import { inflateSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { approvalRequests, productCategories, quotationLines, quotations, settings } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { GET as shareRoute } from "@/app/share/[token]/route";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { todayIST } from "@/lib/dates";
import type { LineText } from "@/lib/lines";
import { pdfForToken, quotationPdf } from "@/lib/pdf";
import type { Role, SessionUser } from "@/lib/permissions";
import {
  approveQuotation,
  cancelQuotation,
  createQuotation,
  duplicateQuotation,
  getQuotation,
  sendQuotation,
  updateQuotation,
  type QuotationInput,
} from "@/lib/quotations";
import { saveBooks } from "@/lib/settings";
import { sendPdfMail, whatsappLink } from "@/lib/share";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let sales: SessionUser;
let categoryId: string;
let local: number; // Gujarat customer, Gujarati name
let outside: number; // Maharashtra customer

async function staff(role: Role): Promise<SessionUser> {
  const user = { name: `Quote ${role}`, username: `quote.${role}`, role, canViewCost: false };
  return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
}

const customer = (patch: Partial<CustomerInput>): CustomerInput => ({
  name: "",
  firmName: "",
  mobile: "",
  email: "",
  gstin: "",
  stateCode: "24",
  billingAddress: "",
  siteAddress: "",
  creditLimit: "",
  creditDays: "",
  isCreditCustomer: false,
  salesPersonId: "",
  collectionPersonId: "",
  notes: "",
  ...patch,
});

beforeAll(async () => {
  owner = await testOwner();
  sales = await staff("sales");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [c] = await db.select().from(productCategories).orderBy(productCategories.id).limit(1);
  categoryId = String(c.id);
  local = await createCustomer(owner, customer({ name: "શ્રી ગણેશ ટ્રેડર્સ", billingAddress: "સી.જી. રોડ, અમદાવાદ" }));
  outside = await createCustomer(owner, customer({ name: "Pune Signs", gstin: "27ABCDE1234F1Z0", stateCode: "27" }));
});

const line = (patch: Partial<LineText>): LineText => ({
  lineId: "",
  categoryId,
  description: "Acrylic letters",
  hsnSac: "",
  width: "",
  height: "",
  qty: "1",
  unit: "Nos",
  rate: "100",
  discount: "",
  gst: "",
  ...patch,
});

// Line 1: 2 × ₹1,000 − ₹100 = ₹1,900 · line 2: 6 × 3 ft Sq Ft, qty left blank → 18 sq ft × ₹150.50 = ₹2,709.
const twoLines = () => [
  line({ qty: "2", rate: "1,000", discount: "100" }),
  line({ description: "Flex board", width: "6", height: "3", unit: "Sq Ft", qty: "", rate: "150.50" }),
];
const input = (customerId: number, lines: LineText[], patch: Partial<QuotationInput> = {}): QuotationInput => ({
  customerId: String(customerId),
  date: "28/09/2026",
  terms: "Valid 15 days.",
  notes: "",
  lines: JSON.stringify(lines),
  ...patch,
});

test("totals: same state = CGST + SGST, other state = IGST; a Sq Ft line's qty defaults to W × H", async () => {
  const same = await getQuotation(await createQuotation(owner, input(local, twoLines())));
  expect(same!.number).toMatch(/^QT\/26-27\/\d{4}$/);
  expect(same!.lines[1]).toMatchObject({ widthMilli: 6000n, heightMilli: 3000n, qtyMilli: 18000n, unit: "Sq Ft", gstBp: 1800 });
  expect(same!.totals).toMatchObject({
    taxable: 4609_00n,
    cgst: 414_81n, // 171.00 + 243.81
    sgst: 414_81n,
    igst: 0n,
    roundOff: 38n, // 5,438.62 → 5,439
    total: 5439_00n,
  });
  expect(same!.totalPaise).toBe(5439_00n);

  const other = await getQuotation(await createQuotation(owner, input(outside, twoLines())));
  expect(other!.placeOfSupply).toBe("27");
  expect(other!.totals).toMatchObject({ taxable: 4609_00n, cgst: 0n, sgst: 0n, igst: 829_62n, total: 5439_00n });

  // A typed qty wins over W × H.
  const typed = await getQuotation(
    await createQuotation(owner, input(local, [line({ width: "6", height: "3", unit: "Sq Ft", qty: "20" })])),
  );
  expect(typed!.lines[0].qtyMilli).toBe(20000n);
});

test("bad lines are refused, naming the line", async () => {
  const bad = (l: Partial<LineText>) => createQuotation(owner, input(local, [line({}), line(l)]));
  await expect(bad({ categoryId: "" })).rejects.toThrow("Line 2: pick a category.");
  await expect(bad({ discount: "500" })).rejects.toThrow("Line 2: the discount is more than the line amount.");
  await expect(bad({ width: "6" })).rejects.toThrow("Line 2: enter both width and height");
  await expect(bad({ qty: "" })).rejects.toThrow("Line 2: enter the qty.");
  await expect(createQuotation(owner, input(local, []))).rejects.toThrow("Add at least one line.");
});

test("status rules: Draft → Sent → Approved; only Draft / Sent editable; editing Sent goes back to Draft", async () => {
  const id = await createQuotation(owner, input(local, twoLines()));
  const status = async () => (await getQuotation(id))!.status;
  await expect(approveQuotation(owner, id)).rejects.toThrow("Only a sent quotation");

  expect((await sendQuotation(owner, id)).message).toBe("Marked as sent.");
  expect(await status()).toBe("sent");
  await updateQuotation(owner, id, input(local, [line({ rate: "200" })]));
  expect(await status()).toBe("draft");
  expect((await getQuotation(id))!.lines).toHaveLength(1);

  // S25 (T29): over the credit limit (₹200 + 18% GST) → Send still works, with a warning.
  const tight = await createCustomer(owner, customer({ name: "Tight Limit Signs", creditLimit: "100" }));
  const over = await createQuotation(owner, input(tight, [line({ rate: "200" })]));
  expect((await sendQuotation(owner, over)).message).toBe("Marked as sent. Over the credit limit: ₹0.00 due + ₹236.00 = ₹236.00, limit ₹100.00.");

  await sendQuotation(owner, id);
  await expect(sendQuotation(owner, id)).rejects.toThrow("Only a draft");
  await approveQuotation(owner, id);
  expect(await status()).toBe("approved");
  await expect(updateQuotation(owner, id, input(local, twoLines()))).rejects.toThrow("can't be edited");

  await cancelQuotation(owner, id); // no job: allowed
  expect(await status()).toBe("cancelled");
  await expect(cancelQuotation(owner, id)).rejects.toThrow("already cancelled");
  await expect(updateQuotation(owner, id, input(local, twoLines()))).rejects.toThrow("can't be edited");

  // Accountants only view quotations (A§8).
  const accountant = { ...owner, role: "accountant" as const };
  await expect(createQuotation(accountant, input(local, twoLines()))).rejects.toThrow("Not allowed");
});

test("a non-owner sending with a discount over the limit files an approval request; the owner's approval sends it", async () => {
  await writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp: 500 }).where(eq(settings.id, 1))); // 5%
  const date = todayIST().split("-").reverse().join("/");

  const within = await createQuotation(sales, input(local, [line({ rate: "1000", discount: "50" })], { date }));
  expect((await sendQuotation(sales, within)).message).toBe("Marked as sent.");

  const over = await createQuotation(sales, input(local, [line({ rate: "1000", discount: "100" })], { date })); // 10%
  expect((await sendQuotation(sales, over)).message).toBe(SENT_FOR_APPROVAL);
  expect((await getQuotation(over))!.status).toBe("draft");
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.targetType, "quotations"), eq(approvalRequests.targetId, over)));
  expect(req).toMatchObject({ type: "quotation.send", status: "pending", requestedBy: sales.id });
  expect(req.reason).toContain("over the limit");
  await approve(owner, req.id, "");
  expect((await getQuotation(over))!.status).toBe("sent");

  // A request for an older version is refused once the quotation has changed (D44).
  const stale = await createQuotation(sales, input(local, [line({ rate: "1000", discount: "100" })], { date }));
  await sendQuotation(sales, stale);
  await updateQuotation(sales, stale, input(local, [line({ rate: "1000", discount: "200" })], { date }));
  const [staleReq] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.targetType, "quotations"), eq(approvalRequests.targetId, stale)));
  await expect(approve(owner, staleReq.id, "")).rejects.toThrow("changed after the request");
  expect((await getQuotation(stale))!.status).toBe("draft");

  await writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp: null }).where(eq(settings.id, 1)));
});

test("duplicate = a new draft with its own number and the same lines", async () => {
  const id = await createQuotation(owner, input(local, twoLines()));
  await sendQuotation(owner, id);
  const copy = await getQuotation(await duplicateQuotation(owner, id));
  const original = await getQuotation(id);
  expect(copy).toMatchObject({ status: "draft", date: todayIST(), customerId: local, terms: "Valid 15 days." });
  expect(copy!.number).not.toBe(original!.number);
  expect(copy!.shareToken).not.toBe(original!.shareToken);
  const strip = (lines: { id: number; quotationId: number }[]) => lines.map((l) => ({ ...l, id: 0, quotationId: 0 }));
  expect(strip(copy!.lines)).toEqual(strip(original!.lines));
});

test("a quotation dated before the books start date is refused (D43)", async () => {
  await expect(createQuotation(owner, input(local, twoLines(), { date: "31/03/2026" }))).rejects.toMatchObject({
    field: "date",
  });
});

/** Every stream of a PDF, inflated where compressed, as one latin1 string (fonts' ToUnicode maps live there). */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const parts = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const body = bytes.subarray(start, raw.indexOf("endstream", start));
    try {
      parts.push(inflateSync(body).toString("latin1"));
    } catch {
      // not compressed, or not zlib
    }
  }
  return parts.join("\n").toLowerCase();
}

test("the PDF renders a Gujarati customer name and ₹, embedding both Noto fonts", async () => {
  const id = await createQuotation(owner, input(local, twoLines()));
  const pdf = await quotationPdf(id);
  expect(pdf!.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf!.fileName).toMatch(/^QT-26-27-\d{4}\.pdf$/);
  const text = pdfText(pdf!.bytes);
  expect(text).toMatch(/\/basefont\s*\/[a-z]{6}\+notosans-regular/);
  expect(text).toMatch(/\/basefont\s*\/[a-z]{6}\+notosansgujarati-regular/);
  expect(text).toContain("<20b9>"); // ₹ in a ToUnicode map
  expect(text).toContain("<0a97>"); // ગ
}, 30_000); // the first render parses the fonts

test("/share/<token> serves the PDF without a login; a wrong token gets 404", async () => {
  const id = await createQuotation(owner, input(local, twoLines()));
  const [q] = await db.select().from(quotations).where(eq(quotations.id, id));
  expect(q.shareToken).toMatch(/^[\w-]{43}$/);
  const get = (token: string) => shareRoute(new Request(`http://x/share/${token}`), { params: Promise.resolve({ token }) });

  const ok = await get(q.shareToken);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

  const wrong = q.shareToken.slice(0, -1) + (q.shareToken.endsWith("A") ? "B" : "A");
  expect((await get(wrong)).status).toBe(404);
  expect((await get("nope")).status).toBe(404);
  expect(await pdfForToken("x".repeat(43))).toBeNull();
}, 30_000);

test("WhatsApp links carry the message; email without SMTP says it isn't set up", async () => {
  expect(whatsappLink("98250 11111", "Hi & bye")).toBe("https://wa.me/919825011111?text=Hi%20%26%20bye");
  expect(whatsappLink("098250 11111", "x")).toBe("https://wa.me/919825011111?text=x");
  expect(whatsappLink(null, "x")).toBe("https://wa.me/?text=x");

  const saved = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  const mail = { to: "a@example.com", subject: "s", text: "t", fileName: "a.pdf", pdf: Buffer.from("%PDF-") };
  await expect(sendPdfMail(mail)).rejects.toThrow("Email isn't set up");
  if (saved !== undefined) process.env.SMTP_HOST = saved;
});

test("lines are saved in order with the category's HSN / GST filled in", async () => {
  const id = await createQuotation(owner, input(local, [line({ description: "A" }), line({ description: "B", gst: "12" })]));
  const rows = await db.select().from(quotationLines).where(eq(quotationLines.quotationId, id)).orderBy(quotationLines.position);
  expect(rows.map((r) => [r.position, r.description, r.gstBp])).toEqual([
    [1, "A", 1800],
    [2, "B", 1200],
  ]);
});
