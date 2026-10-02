import path from "node:path";
import { Document, Font, Image, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { db } from "@/db";
import { attachments, creditNotes, debitNotes, invoices, purchaseOrders, quotations } from "@/db/schema";
import { getCustomer } from "@/lib/customers";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { stateName } from "@/lib/gstin";
import { lineTotals, sizeText } from "@/lib/lines";
import { getNote, NOTE_KIND, type NoteKind } from "@/lib/notes";
import { amountInWords, bpText, drCr, formatMoney, milliText, noteTotals, type GstMode } from "@/lib/num";
import { getInvoice, INVOICE_KIND } from "@/lib/invoices";
import { getOrder } from "@/lib/purchase-orders";
import { getQuotation } from "@/lib/quotations";
import { columnTotal, hasTotals, isNumeric, type Report, type ReportColumn, type ReportTable } from "@/lib/report";
import { getSettings } from "@/lib/settings";
import { customerLedger, entryLabel, rangeText, statementLink, vendorLedger, withoutReversed, type Range } from "@/lib/statements";
import { storage } from "@/lib/storage";
import { getVendor } from "@/lib/vendors";

// The one A4 layout for quotations, invoices, credit / debit notes, purchase orders and statements (D06, DESIGN "PDFs"),
// rendered with @react-pdf/renderer on the server: the same letterhead, party block (customer, or the vendor on a
// purchase order) and footer; a lines table or a ledger table.
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

/** A credit / debit note line: the invoice line's description, a qty if one was given, the taxable value (T16). */
export type PdfNoteLine = Omit<PdfLine, "qtyMilli" | "ratePaise" | "discountPaise"> & { qtyMilli: bigint | null; taxablePaise: bigint };

export type PdfDoc = {
  title: string; // "Quotation", "Tax Invoice", "Estimate", "Credit Note", "Debit Note", "Purchase Order"
  number: string;
  date: string;
  dueDate?: string | null;
  mark: "DRAFT" | "CANCELLED" | null;
  customer: { name: string; firmName: string | null; billingAddress: string | null; gstin: string | null; stateCode: string };
  /** Over the party block; default "Bill to" ("To" on quotations). */
  partyLabel?: string;
  placeOfSupply: string | null; // printed on tax invoices
  mode: GstMode;
  lines: PdfLine[];
  terms: string | null;
  payment: boolean; // bank details + UPI (invoices)
  /** Under the total: an invoice's Advance adjusted and Balance (S5). */
  after?: [string, bigint][];
  /** A credit / debit note: its lines instead of `lines` (no rate / discount, no round-off), the invoice and the reason. */
  note?: { lines: PdfNoteLine[]; against: string; reason: string };
};

const GREY = "#6b7280";
const LINE = "#d4d4d8";
const s = StyleSheet.create({
  // liga off (inherited by all text): some viewers copy / search the fi / ff ligature glyph as "f" ("Proft"). Noto Sans
  // Gujarati has no liga feature, so its conjuncts are unaffected.
  page: { padding: 32, paddingBottom: 44, fontFamily: ["Noto Sans", "Noto Sans Gujarati"], fontSize: 8.5, color: "#18181b", fontFeatureSettings: { liga: false } },
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
type Computed = Omit<PdfLine, "qtyMilli" | "ratePaise" | "discountPaise"> & {
  qtyMilli: bigint | null;
  ratePaise?: bigint;
  discountPaise?: bigint;
  taxable: bigint;
  cgst: bigint;
  sgst: bigint;
  igst: bigint;
};

function columns(mode: GstMode, note: boolean): Column[] {
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
  const qty: Column = {
    label: "Qty",
    width: 52,
    numeric: true,
    cell: (l) => (l.qtyMilli === null ? "—" : `${milliText(l.qtyMilli)} ${l.unit}`),
  };
  const priced: Column[] = note
    ? [qty]
    : [
        qty,
        { label: "Rate", width: 60, numeric: true, cell: (l) => money(l.ratePaise!) },
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

type Brand = { co: Awaited<ReturnType<typeof getSettings>>; company: string; logo: PdfImage | null; signature: PdfImage | null };

async function brand(): Promise<Brand> {
  const co = await getSettings();
  const [logo, signature] = await Promise.all([settingsImage(co.logoAttachmentId), settingsImage(co.signatureAttachmentId)]);
  return { co, company: co.companyName ?? "[Company name — set in Settings]", logo, signature };
}

/** The company on the left; the document's title and facts (No., Date …) on the right. */
function Letterhead({ b, title, facts }: { b: Brand; title: string; facts: string[] }) {
  return (
    <>
      <View style={[s.row, { gap: 10 }]}>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image, not an HTML img */}
        {b.logo && <Image src={b.logo} style={{ width: 56, height: 56, objectFit: "contain" }} />}
        <View style={{ flex: 1 }}>
          <Text style={s.company}>{b.company}</Text>
          <Text>{b.co.address ?? "[Address — set in Settings]"}</Text>
          {b.co.gstin && <Text>GSTIN: {b.co.gstin}</Text>}
          <Text>{[b.co.phone && `Phone: ${b.co.phone}`, b.co.email].filter(Boolean).join("  ·  ")}</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={s.h1}>{title}</Text>
          {facts.map((f) => (
            <Text key={f}>{f}</Text>
          ))}
        </View>
      </View>
      <View style={s.rule} />
    </>
  );
}

/** The customer ("To" / "Bill to" / "Customer"), with an optional block on the right. */
function Party({ label, c, children }: { label: string; c: PdfDoc["customer"]; children?: ReactNode }) {
  return (
    <View style={[s.row, { gap: 16, marginBottom: 10 }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.muted}>{label}</Text>
        <Text style={s.bold}>{c.firmName ?? c.name}</Text>
        {c.firmName && <Text>{c.name}</Text>}
        {c.billingAddress && <Text>{c.billingAddress}</Text>}
        <Text>GSTIN: {c.gstin ?? "Unregistered"}</Text>
        <Text>
          State: {c.stateCode} · {stateName(c.stateCode) ?? ""}
        </Text>
      </View>
      {children && <View style={{ width: 170 }}>{children}</View>}
    </View>
  );
}

/** On every page: the DRAFT / CANCELLED mark (under the content) and the footer. */
function PageChrome({ mark, footer }: { mark?: string | null; footer: string }) {
  return (
    <>
      {mark && (
        <Text fixed style={s.mark}>
          {mark}
        </Text>
      )}
      <Text
        fixed
        style={{ position: "absolute", bottom: 20, left: 32, right: 32, textAlign: "center", color: GREY, fontSize: 7 }}
        render={({ pageNumber, totalPages }) => `${footer} · Page ${pageNumber} of ${totalPages}`}
      />
    </>
  );
}

export async function renderPdf(doc: PdfDoc): Promise<Buffer> {
  const b = await brand();
  const { co, company, signature } = b;
  const note = doc.note;
  const totals = note
    ? noteTotals(note.lines.map((l) => ({ taxable: l.taxablePaise, gstBp: l.gstBp })), doc.mode)
    : lineTotals(doc.lines, doc.mode);
  const lines: Computed[] = (note ? note.lines : doc.lines).map((l, i) => ({ ...l, ...totals.lines[i] }));
  const cols = columns(doc.mode, !!note);
  const totalRows: [string, bigint][] = [
    [doc.mode === "estimate" ? "Sub total" : "Taxable value", totals.taxable],
    ...(doc.mode === "same_state"
      ? ([["CGST", totals.cgst], ["SGST", totals.sgst]] as [string, bigint][])
      : doc.mode === "other_state"
        ? ([["IGST", totals.igst]] as [string, bigint][])
        : []),
    ...(note ? [] : ([["Round off", totals.roundOff]] as [string, bigint][])), // notes have none (D49)
  ];

  return renderToBuffer(
    <Document title={`${doc.title} ${doc.number}`} author={company}>
      <Page size="A4" style={s.page}>
        <PageChrome mark={doc.mark} footer={`${doc.title} ${doc.number}`} />
        <Letterhead
          b={b}
          title={doc.title}
          facts={[
            `No. ${doc.number}`,
            `Date ${formatDate(doc.date)}`,
            ...(note ? [note.against] : []),
            ...(doc.dueDate ? [`Due ${formatDate(doc.dueDate)}`] : []),
          ]}
        />
        <Party label={doc.partyLabel ?? (doc.title === "Quotation" ? "To" : "Bill to")} c={doc.customer}>
          {doc.placeOfSupply && (
            <>
              <Text style={s.muted}>Place of supply</Text>
              <Text>
                {doc.placeOfSupply} · {stateName(doc.placeOfSupply) ?? ""}
              </Text>
            </>
          )}
        </Party>

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
            {doc.after?.map(([label, v], i) => (
              <View key={label} style={[s.row, { justifyContent: "space-between", paddingVertical: 1.5 }, i === 0 ? { marginTop: 3 } : {}]}>
                <Text style={i === doc.after!.length - 1 ? s.bold : s.muted}>{label}</Text>
                <Text style={i === doc.after!.length - 1 ? s.bold : {}}>{formatMoney(v)}</Text>
              </View>
            ))}
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
            {note && (
              <View>
                <Text style={s.bold}>Reason</Text>
                <Text>{note.reason}</Text>
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

      </Page>
    </Document>,
  );
}


type StatementRow = { date: string; number: string | null; label: string; debit: bigint; credit: bigint; balance: bigint };

/** A customer / vendor statement (S15): opening, the ledger lines with a running balance, totals and closing, Dr / Cr. */
async function renderStatement(d: {
  party: "Customer" | "Vendor";
  customer: PdfDoc["customer"];
  range: Range;
  opening: bigint;
  rows: StatementRow[];
  debit: bigint;
  credit: bigint;
  closing: bigint;
}): Promise<Buffer> {
  const b = await brand();
  const widths = [54, 88, 0, 72, 72, 84]; // 0 = the rest
  const numeric = [false, false, false, true, true, true];
  const line = (cells: string[], bold = false) => (
    <View style={[s.row, s.td]} wrap={false}>
      {cells.map((text, i) => (
        <Text key={i} style={[s.cell, widths[i] ? { width: widths[i] } : { flex: 1 }, numeric[i] ? s.num : {}, bold ? s.bold : {}]}>
          {text}
        </Text>
      ))}
    </View>
  );
  const name = d.customer.firmName ?? d.customer.name;
  return renderToBuffer(
    <Document title={`Statement of account ${name}`} author={b.company}>
      <Page size="A4" style={s.page}>
        <PageChrome footer={`Statement of account · ${name}`} />
        <Letterhead b={b} title="Statement of Account" facts={[rangeText(d.range), `Made ${formatDate(todayIST())}`]} />
        <Party label={d.party} c={d.customer}>
          <Text style={s.muted}>Closing balance</Text>
          <Text style={[s.bold, { fontSize: 11 }]}>{drCr(d.closing)}</Text>
        </Party>
        <View style={[s.row, s.th]} fixed>
          {["Date", "Document", "Particulars", "Debit", "Credit", "Balance"].map((label, i) => (
            <Text key={label} style={[s.cell, widths[i] ? { width: widths[i] } : { flex: 1 }, numeric[i] ? s.num : {}]}>
              {label}
            </Text>
          ))}
        </View>
        {line([d.range.from ? formatDate(d.range.from) : "", "", "Brought forward", "", "", drCr(d.opening)], true)}
        {d.rows.map((r, i) => (
          <View key={i}>
            {line([formatDate(r.date), r.number ?? "", r.label, r.debit ? formatMoney(r.debit) : "", r.credit ? formatMoney(r.credit) : "", drCr(r.balance)])}
          </View>
        ))}
        {line(["", "", "Total", formatMoney(d.debit), formatMoney(d.credit), ""], true)}
        {line([formatDate(d.range.to ?? todayIST()), "", "Closing balance", "", "", drCr(d.closing)], true)}
        <Text style={[s.muted, { marginTop: 10 }]}>
          {d.party === "Customer"
            ? `Balance: Dr = due to ${b.company}, Cr = in the customer's favour.`
            : `Balance: Cr = due to the vendor from ${b.company}, Dr = in ${b.company}'s favour.`}
        </Text>
      </Page>
    </Document>,
  );
}

/**
 * A report or list as an A4 table (S20, S27, D59): letterhead with the report's name, filters and generated-at, then
 * each table (its header repeats on every page it runs onto), a totals row, page numbers. Landscape when wide.
 */
export async function reportPdf(report: Report): Promise<Buffer> {
  const b = await brand();
  const landscape = Math.max(...report.tables.map((t) => t.columns.length)) > 7;
  // A table with many amounts (job-wise profit) gets narrower amount columns, so its text columns keep some room.
  const tight = (t: ReportTable) => t.columns.filter((c) => c.type === "money" || c.type === "balance").length > 7;
  // Words never break (no hyphenation), so a text column holding a long token with no space (a file name) gets a
  // wider share, up to 3x, instead of running into the next column. Tokens up to 16 characters leave it at 1x.
  const grow = (t: ReportTable, c: ReportColumn) => {
    const longest = Math.max(0, ...t.rows.flatMap((r) => String(r[c.key] ?? "").split(" ").map((w) => w.length)));
    return longest > 16 ? Math.min(3, longest / 12) : 1;
  };
  const width = (t: ReportTable, c: ReportColumn) =>
    c.type === "money"
      ? { width: tight(t) ? 66 : 80 }
      : c.type === "balance"
        ? { width: 92 }
        : c.type === "date"
          ? { width: 58 }
          : c.type === "number" || c.type === "qty"
            ? { width: 50 }
            : { flex: grow(t, c) };
  const cellText = (c: ReportColumn, v: unknown) =>
    v === null || v === undefined
      ? ""
      : c.type === "money"
        ? formatMoney(v as bigint)
        : c.type === "balance"
          ? drCr(v as bigint)
          : c.type === "qty"
            ? milliText(v as bigint)
            : c.type === "date"
              ? formatDate(v as string)
              : String(v);
  const generated = `Generated ${formatDateTime(report.generatedAt)}`;
  return renderToBuffer(
    <Document title={report.title} author={b.company}>
      <Page size="A4" orientation={landscape ? "landscape" : "portrait"} style={s.page}>
        <PageChrome footer={`${report.title} · ${generated}`} />
        <Letterhead b={b} title={report.title} facts={[...report.filters, generated]} />
        {report.tables.map((t, ti) => (
          <View key={ti} style={{ marginBottom: 14 }}>
            {t.title && <Text style={[s.bold, { fontSize: 10, marginBottom: 4 }]}>{t.title}</Text>}
            <View style={[s.row, s.th]} fixed>
              {t.columns.map((c) => (
                <Text key={c.key} style={[s.cell, width(t, c), isNumeric(c) ? s.num : {}]}>
                  {c.label}
                </Text>
              ))}
            </View>
            {t.rows.map((r, i) => (
              <View key={i} style={[s.row, s.td]} wrap={false}>
                {t.columns.map((c) => (
                  <Text key={c.key} style={[s.cell, width(t, c), isNumeric(c) ? s.num : {}]}>
                    {cellText(c, r[c.key])}
                  </Text>
                ))}
              </View>
            ))}
            {t.rows.length === 0 && <Text style={[s.cell, s.muted]}>Nothing in this period.</Text>}
            {hasTotals(t) && (
              <View style={[s.row, s.td, s.bold, { backgroundColor: "#fafafa" }]} wrap={false}>
                {t.columns.map((c, i) => (
                  <Text key={c.key} style={[s.cell, width(t, c), isNumeric(c) ? s.num : {}]}>
                    {c.total ? formatMoney(columnTotal(t, c.key)) : i === 0 ? `Total (${t.rows.length})` : ""}
                  </Text>
                ))}
              </View>
            )}
            {t.note && <Text style={[s.muted, { marginTop: 4 }]}>{t.note}</Text>}
          </View>
        ))}
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

export async function invoicePdf(id: number) {
  const inv = await getInvoice(id);
  if (!inv) return null;
  const number = inv.number ?? "Draft";
  const bytes = await renderPdf({
    title: INVOICE_KIND[inv.kind],
    number,
    date: inv.date,
    dueDate: inv.dueDate,
    mark: inv.status === "draft" ? "DRAFT" : inv.status === "cancelled" ? "CANCELLED" : null,
    customer: inv.customer,
    placeOfSupply: inv.kind === "tax" ? inv.placeOfSupply : null,
    mode: inv.mode,
    lines: inv.lines,
    terms: inv.terms,
    payment: true,
    after:
      inv.advance > 0n
        ? [
            ["Advance adjusted", -inv.advance],
            ["Balance", inv.balance],
          ]
        : undefined,
  });
  return { bytes, fileName: pdfFileName(inv.number ?? `draft-invoice-${inv.id}`) };
}

/** A credit / debit note: "Credit Note — against invoice RDS/…" (T16). */
export async function notePdf(kind: NoteKind, id: number) {
  const n = await getNote(kind, id);
  if (!n) return null;
  const number = n.number ?? "Draft";
  const bytes = await renderPdf({
    title: NOTE_KIND[kind].title,
    number,
    date: n.date,
    dueDate: n.dueDate,
    mark: n.status === "draft" ? "DRAFT" : n.status === "cancelled" ? "CANCELLED" : null,
    customer: n.customer,
    placeOfSupply: n.invoice.kind === "tax" ? n.invoice.placeOfSupply : null,
    mode: n.mode,
    lines: [],
    terms: null,
    payment: kind === "debit",
    note: {
      lines: n.lines,
      against: `Against invoice ${n.invoice.number} (${formatDate(n.invoice.date)})`,
      reason: n.reason,
    },
  });
  return { bytes, fileName: pdfFileName(n.number ?? `draft-${NOTE_KIND[kind].path}-${n.id}`) };
}

/** A purchase order (T22): the vendor in the party block, the items at the order's rates, GST as for bills. */
export async function purchaseOrderPdf(id: number) {
  const o = await getOrder(id);
  if (!o) return null;
  const bytes = await renderPdf({
    title: "Purchase Order",
    number: o.number,
    date: o.date,
    mark: o.status === "draft" ? "DRAFT" : o.status === "cancelled" ? "CANCELLED" : null,
    customer: { name: o.vendor.name, firmName: null, billingAddress: o.vendor.address, gstin: o.vendor.gstin, stateCode: o.vendorStateCode },
    partyLabel: "Vendor",
    placeOfSupply: null,
    mode: o.mode,
    lines: o.lines.map((l) => ({
      category: l.name,
      description: l.description ? `${l.name} — ${l.description}` : l.name,
      hsnSac: l.hsnSac,
      widthMilli: null,
      heightMilli: null,
      qtyMilli: l.qtyMilli,
      unit: l.unit,
      ratePaise: l.ratePaise,
      discountPaise: 0n,
      gstBp: l.gstBp,
    })),
    terms: null, // notes stay internal
    payment: false,
  });
  return { bytes, fileName: pdfFileName(o.number) };
}

/** A customer's statement for the range (S15), figures straight from the journal, reversed pairs left out (D50). */
export async function statementPdf(customerId: number, range: Range) {
  const customer = await getCustomer(customerId);
  if (!customer) return null;
  const l = withoutReversed(await customerLedger(customerId, range));
  const bytes = await renderStatement({
    party: "Customer",
    customer,
    range,
    opening: l.opening,
    rows: l.rows.map((r) => ({ date: r.date, number: r.number, label: entryLabel(r), debit: r.debit, credit: r.credit, balance: r.balance })),
    debit: l.debit,
    credit: l.credit,
    closing: l.closing,
  });
  // ASCII only: the name goes into a header, and customer names may be Gujarati.
  return { bytes, fileName: `statement-${customerId}-${range.to ?? todayIST()}.pdf` };
}

/** A vendor's statement (S15): their AP lines, reversed pairs left out (D50). Cr = we owe them. */
export async function vendorStatementPdf(vendorId: number, range: Range) {
  const v = await getVendor(vendorId);
  if (!v) return null;
  const l = withoutReversed(await vendorLedger(vendorId, range));
  const bytes = await renderStatement({
    party: "Vendor",
    customer: { name: v.name, firmName: null, billingAddress: v.address, gstin: v.gstin, stateCode: v.stateCode },
    range,
    opening: l.opening,
    rows: l.rows.map((r) => ({ date: r.date, number: r.number, label: entryLabel(r), debit: r.debit, credit: r.credit, balance: r.balance })),
    debit: l.debit,
    credit: l.credit,
    closing: l.closing,
  });
  return { bytes, fileName: `vendor-statement-${vendorId}-${range.to ?? todayIST()}.pdf` };
}

/** The PDF behind a public share link (/share/<token>), or null for an unknown token. */
export async function pdfForToken(token: string) {
  if (!/^[\w-]{43}$/.test(token)) return null; // 32 bytes, base64url
  const [q] = await db.select({ id: quotations.id }).from(quotations).where(eq(quotations.shareToken, token));
  if (q) return quotationPdf(q.id);
  const [inv] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.shareToken, token));
  if (inv) return invoicePdf(inv.id);
  for (const [kind, t] of [["credit", creditNotes], ["debit", debitNotes]] as const) {
    const [note] = await db.select({ id: t.id }).from(t).where(eq(t.shareToken, token));
    if (note) return notePdf(kind, note.id);
  }
  const [po] = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.shareToken, token));
  if (po) return purchaseOrderPdf(po.id);
  const statement = await statementLink(token);
  if (!statement) return null;
  const range = { from: statement.fromDate, to: statement.toDate };
  return statement.customerId !== null ? statementPdf(statement.customerId, range) : vendorStatementPdf(statement.vendorId!, range);
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
