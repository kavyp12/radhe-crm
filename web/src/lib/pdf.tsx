import path from "node:path";
import { Document, Font, Image, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { db } from "@/db";
import { attachments, quotations } from "@/db/schema";
import { formatDate } from "@/lib/dates";
import { stateName } from "@/lib/gstin";
import { lineTotals, sizeText } from "@/lib/lines";
import { amountInWords, bpText, formatMoney, milliText, type GstMode } from "@/lib/num";
import { getQuotation } from "@/lib/quotations";
import { getSettings } from "@/lib/settings";
import { storage } from "@/lib/storage";

// The one A4 layout for quotations and invoices (D06, DESIGN "PDFs"), rendered on the server with @react-pdf/renderer.
// Built-in Helvetica has no ₹ and no Gujarati, so everything is set in Noto Sans with Noto Sans Gujarati as the
// fallback for Gujarati letters (fonts committed under src/assets/fonts, OFL; next.config traces them into the build).

const FONTS = path.join(/*turbopackIgnore: true*/ process.cwd(), "src/assets/fonts");
Font.register({
  family: "Noto Sans",
  fonts: [
    { src: path.join(FONTS, "NotoSans-Regular.ttf") },
    { src: path.join(FONTS, "NotoSans-Bold.ttf"), fontWeight: 700 },
  ],
});
Font.register({
  family: "Noto Sans Gujarati",
  fonts: [
    { src: path.join(FONTS, "NotoSansGujarati-Regular.ttf") },
    { src: path.join(FONTS, "NotoSansGujarati-Bold.ttf"), fontWeight: 700 },
  ],
});
Font.registerHyphenationCallback((word) => [word]); // names and addresses are never hyphenated

export type PdfLine = {
  category: string;
  description: string | null;
  hsnSac: string | null;
  widthMilli: bigint | null;
  heightMilli: bigint | null;
  qtyMilli: bigint;
  unit: string;
  ratePaise: bigint;
  discountPaise: bigint;
  gstBp: number;
};

export type PdfDoc = {
  title: string; // "Quotation", "Tax Invoice", "Estimate"
  number: string;
  date: string;
  dueDate?: string | null;
  mark: "DRAFT" | "CANCELLED" | null;
  customer: { name: string; firmName: string | null; billingAddress: string | null; gstin: string | null; stateCode: string };
  placeOfSupply: string | null; // printed on tax invoices
  mode: GstMode;
  lines: PdfLine[];
  terms: string | null;
  payment: boolean; // bank details + UPI (invoices)
};

const GREY = "#6b7280";
const LINE = "#d4d4d8";
const s = StyleSheet.create({
  page: { padding: 32, paddingBottom: 44, fontFamily: ["Noto Sans", "Noto Sans Gujarati"], fontSize: 8.5, color: "#18181b" },
  row: { flexDirection: "row" },
  muted: { color: GREY },
  bold: { fontWeight: 700 },
  h1: { fontSize: 15, fontWeight: 700 },
  company: { fontSize: 13, fontWeight: 700 },
  rule: { borderBottomWidth: 1, borderBottomColor: LINE, marginVertical: 8 },
  th: { backgroundColor: "#f4f4f5", borderBottomWidth: 1, borderBottomColor: LINE, fontWeight: 700 },
  td: { borderBottomWidth: 0.5, borderBottomColor: LINE },
  cell: { paddingVertical: 4, paddingHorizontal: 3 },
  num: { textAlign: "right" },
  mark: {
    position: "absolute",
    top: 330,
    left: 70,
    fontSize: 88,
    fontWeight: 700,
    color: "#dc2626",
    opacity: 0.12,
    transform: "rotate(-30deg)",
  },
});

type Column = { label: string; width: number | "flex"; numeric?: boolean; cell: (l: Computed, i: number) => ReactNode };
type Computed = PdfLine & { taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint };

function columns(mode: GstMode): Column[] {
  const money = (v: bigint) => formatMoney(v);
  const lead: Column[] = [
    { label: "#", width: 16, cell: (_, i) => String(i + 1) },
    {
      label: "Description",
      width: "flex",
      cell: (l) => (
        <>
          <Text>{l.description ?? l.category}</Text>
          {sizeText(l.widthMilli, l.heightMilli) && <Text style={s.muted}>Size {sizeText(l.widthMilli, l.heightMilli)}</Text>}
        </>
      ),
    },
  ];
  const priced: Column[] = [
    { label: "Qty", width: 52, numeric: true, cell: (l) => `${milliText(l.qtyMilli)} ${l.unit}` },
    { label: "Rate", width: 60, numeric: true, cell: (l) => money(l.ratePaise) },
    { label: "Disc.", width: 48, numeric: true, cell: (l) => (l.discountPaise ? money(l.discountPaise) : "—") },
  ];
  if (mode === "estimate") return [...lead, ...priced, { label: "Amount", width: 66, numeric: true, cell: (l) => money(l.taxable) }];
  const tax: Column[] =
    mode === "same_state"
      ? [
          { label: "CGST", width: 50, numeric: true, cell: (l) => money(l.cgst) },
          { label: "SGST", width: 50, numeric: true, cell: (l) => money(l.sgst) },
        ]
      : [{ label: "IGST", width: 56, numeric: true, cell: (l) => money(l.igst) }];
  return [
    ...lead,
    { label: "HSN/SAC", width: 40, cell: (l) => l.hsnSac ?? "" },
    ...priced,
    { label: "Taxable", width: 62, numeric: true, cell: (l) => money(l.taxable) },
    { label: "GST %", width: 34, numeric: true, cell: (l) => bpText(l.gstBp) },
    ...tax,
  ];
}

const widthStyle = (c: Column) => (c.width === "flex" ? { flex: 1 } : { width: c.width });

type PdfImage = { data: Buffer; format: "png" | "jpg" };

/** A settings image (logo / signature) that react-pdf can draw: PNG or JPEG only. */
async function settingsImage(id: number | null): Promise<PdfImage | null> {
  if (!id) return null;
  const [file] = await db.select().from(attachments).where(eq(attachments.id, id));
  const format = file?.mime === "image/png" ? "png" : file?.mime === "image/jpeg" ? "jpg" : null;
  const bytes = format && (await storage.get(file.path));
  return bytes ? { data: Buffer.from(bytes), format: format! } : null;
}

export async function renderPdf(doc: PdfDoc): Promise<Buffer> {
  const co = await getSettings();
  const [logo, signature] = await Promise.all([settingsImage(co.logoAttachmentId), settingsImage(co.signatureAttachmentId)]);
  const totals = lineTotals(doc.lines, doc.mode);
  const lines: Computed[] = doc.lines.map((l, i) => ({ ...l, ...totals.lines[i] }));
  const cols = columns(doc.mode);
  const company = co.companyName ?? "[Company name — set in Settings]";
  const c = doc.customer;
  const totalRows: [string, bigint][] = [
    [doc.mode === "estimate" ? "Sub total" : "Taxable value", totals.taxable],
    ...(doc.mode === "same_state"
      ? ([["CGST", totals.cgst], ["SGST", totals.sgst]] as [string, bigint][])
      : doc.mode === "other_state"
        ? ([["IGST", totals.igst]] as [string, bigint][])
        : []),
    ["Round off", totals.roundOff],
  ];

  return renderToBuffer(
    <Document title={`${doc.title} ${doc.number}`} author={company}>
      <Page size="A4" style={s.page}>
        {doc.mark && (
          <Text fixed style={s.mark}>
            {doc.mark}
          </Text>
        )}

        <View style={[s.row, { gap: 10 }]}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image, not an HTML img */}
          {logo && <Image src={logo} style={{ width: 56, height: 56, objectFit: "contain" }} />}
          <View style={{ flex: 1 }}>
            <Text style={s.company}>{company}</Text>
            <Text>{co.address ?? "[Address — set in Settings]"}</Text>
            {co.gstin && <Text>GSTIN: {co.gstin}</Text>}
            <Text>{[co.phone && `Phone: ${co.phone}`, co.email].filter(Boolean).join("  ·  ")}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.h1}>{doc.title}</Text>
            <Text>No. {doc.number}</Text>
            <Text>Date {formatDate(doc.date)}</Text>
            {doc.dueDate && <Text>Due {formatDate(doc.dueDate)}</Text>}
          </View>
        </View>
        <View style={s.rule} />

        <View style={[s.row, { gap: 16, marginBottom: 10 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.muted}>{doc.title === "Quotation" ? "To" : "Bill to"}</Text>
            <Text style={s.bold}>{c.firmName ?? c.name}</Text>
            {c.firmName && <Text>{c.name}</Text>}
            {c.billingAddress && <Text>{c.billingAddress}</Text>}
            <Text>GSTIN: {c.gstin ?? "Unregistered"}</Text>
            <Text>
              State: {c.stateCode} · {stateName(c.stateCode) ?? ""}
            </Text>
          </View>
          {doc.placeOfSupply && (
            <View style={{ width: 170 }}>
              <Text style={s.muted}>Place of supply</Text>
              <Text>
                {doc.placeOfSupply} · {stateName(doc.placeOfSupply) ?? ""}
              </Text>
            </View>
          )}
        </View>

        <View style={[s.row, s.th]}>
          {cols.map((col) => (
            <Text key={col.label} style={[s.cell, widthStyle(col), col.numeric ? s.num : {}]}>
              {col.label}
            </Text>
          ))}
        </View>
        {lines.map((l, i) => (
          <View key={i} style={[s.row, s.td]} wrap={false}>
            {cols.map((col) => (
              <View key={col.label} style={[s.cell, widthStyle(col)]}>
                {typeof col.cell(l, i) === "string" ? (
                  <Text style={col.numeric ? s.num : {}}>{col.cell(l, i)}</Text>
                ) : (
                  col.cell(l, i)
                )}
              </View>
            ))}
          </View>
        ))}

        <View style={[s.row, { marginTop: 8, gap: 16 }]} wrap={false}>
          <View style={{ flex: 1 }}>
            <Text style={s.muted}>Amount in words</Text>
            <Text style={s.bold}>{amountInWords(totals.total)}</Text>
          </View>
          <View style={{ width: 200 }}>
            {totalRows.map(([label, v]) => (
              <View key={label} style={[s.row, { justifyContent: "space-between", paddingVertical: 1.5 }]}>
                <Text style={s.muted}>{label}</Text>
                <Text>{formatMoney(v)}</Text>
              </View>
            ))}
            <View style={[s.row, { justifyContent: "space-between", borderTopWidth: 1, borderTopColor: LINE, marginTop: 3, paddingTop: 4 }]}>
              <Text style={[s.bold, { fontSize: 11 }]}>Total</Text>
              <Text style={[s.bold, { fontSize: 11 }]}>{formatMoney(totals.total)}</Text>
            </View>
          </View>
        </View>

        <View style={[s.row, { marginTop: 18, gap: 16 }]} wrap={false}>
          <View style={{ flex: 1, gap: 8 }}>
            {doc.payment && (co.bankDetails || co.upiId) && (
              <View>
                <Text style={s.bold}>Bank details</Text>
                {co.bankDetails && <Text>{co.bankDetails}</Text>}
                {co.upiId && <Text>UPI: {co.upiId}</Text>}
              </View>
            )}
            {doc.terms && (
              <View>
                <Text style={s.bold}>Terms and conditions</Text>
                <Text>{doc.terms}</Text>
              </View>
            )}
          </View>
          <View style={{ width: 170, alignItems: "center" }}>
            <Text>For {company}</Text>
            {signature ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image, not an HTML img
              <Image src={signature} style={{ height: 42, marginVertical: 4, objectFit: "contain" }} />
            ) : (
              <View style={{ height: 50 }} />
            )}
            <Text style={s.muted}>Authorised signatory</Text>
          </View>
        </View>

        <Text
          fixed
          style={{ position: "absolute", bottom: 20, left: 32, right: 32, textAlign: "center", color: GREY, fontSize: 7 }}
          render={({ pageNumber, totalPages }) => `${doc.title} ${doc.number} · Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>,
  );
}

/** "QT/26-27/0001" → "QT-26-27-0001.pdf". */
export const pdfFileName = (number: string) => `${number.replaceAll("/", "-")}.pdf`;

export async function quotationPdf(id: number) {
  const q = await getQuotation(id);
  if (!q) return null;
  const bytes = await renderPdf({
    title: "Quotation",
    number: q.number,
    date: q.date,
    mark: q.status === "draft" ? "DRAFT" : q.status === "cancelled" ? "CANCELLED" : null,
    customer: q.customer,
    placeOfSupply: null,
    mode: q.mode,
    lines: q.lines,
    terms: q.terms,
    payment: false,
  });
  return { bytes, fileName: pdfFileName(q.number) };
}

/** The PDF behind a public share link (/share/<token>), or null for an unknown token. */
export async function pdfForToken(token: string) {
  if (!/^[\w-]{43}$/.test(token)) return null; // 32 bytes, base64url
  const [q] = await db.select({ id: quotations.id }).from(quotations).where(eq(quotations.shareToken, token));
  if (q) return quotationPdf(q.id);
  return null;
}

/** A PDF as an inline HTTP response (opens in the browser's viewer: read, print, download). */
export function pdfResponse(pdf: { bytes: Buffer; fileName: string } | null): Response {
  if (!pdf) return new Response("Not found", { status: 404 });
  return new Response(new Blob([new Uint8Array(pdf.bytes)]), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pdf.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
