import { mkdir, writeFile } from "node:fs/promises";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { accounts, approvalRequests, invoices, journalEntries, journalLines, productCategories, settings } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, todayIST } from "@/lib/dates";
import {
  billableJobs,
  cancelInvoice,
  createInvoice,
  createInvoiceFromJobs,
  createInvoiceFromQuotation,
  creditWarning,
  getInvoice,
  issueInvoice,
  updateInvoice,
  type InvoiceInput,
} from "@/lib/invoices";
import { cancelJob, createJob, createJobFromQuotation, getJob, setJobStatus } from "@/lib/jobs";
import type { LineText } from "@/lib/lines";
import { invoicePdf, quotationPdf } from "@/lib/pdf";
import type { Role, SessionUser } from "@/lib/permissions";
import { approveQuotation, cancelQuotation, createQuotation, sendQuotation } from "@/lib/quotations";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let accountant: SessionUser;
let sales: SessionUser;
let categoryId: string;
let local: number; // Gujarat, 15 credit days
let outside: number; // Maharashtra

async function staff(role: Role): Promise<SessionUser> {
  const user = { name: `Invoice ${role}`, username: `inv.${role}`, role, canViewCost: role === "accountant" };
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
  [accountant, sales] = [await staff("accountant"), await staff("sales")];
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [c] = await db.select().from(productCategories).orderBy(productCategories.id).limit(1);
  categoryId = String(c.id);
  local = await createCustomer(
    owner,
    customer({ name: "કૃષ્ણ સ્વીટ્સ", firmName: "Krishna Sweets", billingAddress: "Maninagar, Ahmedabad", creditDays: "15" }),
  );
  outside = await createCustomer(owner, customer({ name: "Pune Signs", gstin: "27ABCDE1234F1Z0", stateCode: "27" }));
});

const line = (patch: Partial<LineText> = {}): LineText => ({
  lineId: "",
  categoryId,
  description: "LED sign board",
  hsnSac: "9405",
  width: "",
  height: "",
  qty: "1",
  unit: "Nos",
  rate: "1,000.40",
  discount: "",
  gst: "",
  ...patch,
});
const input = (customerId: number, patch: Partial<InvoiceInput> = {}, lines = [line()]): InvoiceInput => ({
  kind: "tax",
  customerId: String(customerId),
  date: "29/09/2026",
  terms: "Payment within 15 days.",
  notes: "",
  lines: JSON.stringify(lines),
  ...patch,
});

/** The live journal entry an invoice posted: its lines as account key → net (+Dr / −Cr), with sub-ledgers. */
async function posted(invoiceId: number) {
  const rows = await db
    .select({
      entry: journalEntries.id,
      date: journalEntries.date,
      number: journalEntries.number,
      reverses: journalEntries.reversesEntryId,
      key: accounts.systemKey,
      debit: journalLines.debitPaise,
      credit: journalLines.creditPaise,
      customerId: journalLines.customerId,
      jobId: journalLines.jobId,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, "invoices"), eq(journalEntries.docId, invoiceId)))
    .orderBy(asc(journalLines.id));
  const net = (list: typeof rows) =>
    Object.fromEntries(
      [...new Set(list.map((r) => r.key))].map((k) => [
        k,
        list.filter((r) => r.key === k).reduce((s, r) => s + r.debit - r.credit, 0n),
      ]),
    );
  return { rows, net: net(rows), original: net(rows.filter((r) => r.reverses === null)) };
}

test("same state: Dr AR = grand total; Cr sales, CGST, SGST; round-off (±); the entry balances", async () => {
  // ₹1,000.40 + 9% + 9% (₹90.04 each) = ₹1,180.48 → ₹1,180, round-off −0.48 (a debit).
  const id = await createInvoice(owner, input(local));
  const draft = await getInvoice(id);
  expect(draft).toMatchObject({ number: null, status: "draft", dueDate: "2026-10-14", placeOfSupply: "24" });
  expect((await posted(id)).rows).toEqual([]); // drafts post nothing

  expect((await issueInvoice(owner, id)).message).toMatch(/^Issued RDS\/26-27\/\d{4}\.$/);
  const inv = await getInvoice(id);
  expect(inv).toMatchObject({ status: "issued", totalPaise: 1180_00n, roundOffPaise: -48n });
  expect(inv!.number).toMatch(/^RDS\/26-27\/\d{4}$/);
  const { rows, net } = await posted(id);
  expect(net).toEqual({ ar: 1180_00n, sales: -1000_40n, gst_out_cgst: -90_04n, gst_out_sgst: -90_04n, round_off: 48n });
  expect(rows.find((r) => r.key === "ar")).toMatchObject({ customerId: local, debit: 1180_00n });
  expect(rows.every((r) => r.date === "2026-09-29" && r.number === inv!.number)).toBe(true);
  expect(rows.reduce((s, r) => s + r.debit - r.credit, 0n)).toBe(0n);
});

test("other state: IGST; estimate: sales + round-off only, own series", async () => {
  // ₹1,000.40 + 18% IGST ₹180.07 = ₹1,180.47 → ₹1,180 (round-off −0.47).
  const other = await createInvoice(owner, input(outside));
  await issueInvoice(owner, other);
  expect((await posted(other)).net).toEqual({ ar: 1180_00n, sales: -1000_40n, gst_out_igst: -180_07n, round_off: 47n });

  // Estimate: ₹999.60 → ₹1,000 (round-off +0.40, a credit), no GST even with a GST % on the line.
  const est = await createInvoice(owner, input(local, { kind: "estimate" }, [line({ rate: "999.60", gst: "18" })]));
  await issueInvoice(owner, est);
  const e = await getInvoice(est);
  expect(e!.number).toMatch(/^EST\/26-27\/\d{4}$/);
  expect((await posted(est)).net).toEqual({ ar: 1000_00n, sales: -999_60n, round_off: -40n });
});

test("an issued invoice can't be edited; cancel reverses on the invoice date, nets to zero and keeps the number", async () => {
  const id = await createInvoice(owner, input(local));
  await issueInvoice(owner, id);
  const { number } = (await getInvoice(id))!;
  await expect(updateInvoice(owner, id, input(local))).rejects.toThrow("can't be edited");
  await expect(issueInvoice(owner, id)).rejects.toThrow("Only a draft");

  expect((await cancelInvoice(owner, id, "Wrong customer")).message).toBe(`Cancelled ${number}; its entry is reversed.`);
  const inv = await getInvoice(id);
  expect(inv).toMatchObject({ status: "cancelled", number });
  const { rows, net } = await posted(id);
  expect(Object.values(net).every((v) => v === 0n)).toBe(true);
  expect(rows.filter((r) => r.reverses !== null).every((r) => r.date === "2026-09-29" && r.number === number)).toBe(true);
  await expect(cancelInvoice(owner, id, "")).rejects.toThrow("already cancelled");
});

test("a non-owner issuing with a discount over the limit files a request and posts nothing; approval issues it", async () => {
  await writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp: 500 }).where(eq(settings.id, 1)));
  const date = todayIST().split("-").reverse().join("/");
  const id = await createInvoice(accountant, input(local, { date }, [line({ rate: "1000", discount: "100" })])); // 10%
  expect((await issueInvoice(accountant, id)).message).toBe(SENT_FOR_APPROVAL);
  expect(await getInvoice(id)).toMatchObject({ status: "draft", number: null });
  expect((await posted(id)).rows).toEqual([]);

  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, "invoice.issue"), eq(approvalRequests.targetId, id)));
  expect(req).toMatchObject({ status: "pending", requestedBy: accountant.id });
  await approve(owner, req.id, "ok");
  expect((await getInvoice(id))!.status).toBe("issued");
  expect((await posted(id)).net.ar).toBe(1062_00n); // ₹900 + 18%

  // An accountant's cancel of an issued invoice is a request too (A§7): nothing reversed yet.
  expect((await cancelInvoice(accountant, id, "Duplicate")).message).toBe(SENT_FOR_APPROVAL);
  expect((await getInvoice(id))!.status).toBe("issued");
  expect((await posted(id)).net.ar).toBe(1062_00n);

  await writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp: null }).where(eq(settings.id, 1)));
  // Sales only view invoices.
  await expect(createInvoice(sales, input(local))).rejects.toThrow("Not allowed");
});

test("jobs → Invoiced on issue and back to their status on cancel; a job can't be on two live invoices", async () => {
  const lines = JSON.stringify([line({ description: "Board A", rate: "5000" })]);
  const job = { date: "29/09/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "" };
  const a = await createJob(owner, { ...job, customerId: String(local), lines });
  const b = await createJob(owner, { ...job, customerId: String(local), lines });
  await setJobStatus(owner, a, "delivered");
  await setJobStatus(owner, b, "ready");
  expect((await billableJobs(local)).map((j) => j.id)).toEqual(expect.arrayContaining([a, b]));

  const id = await createInvoiceFromJobs(owner, [a, b], "tax");
  const draft = await getInvoice(id);
  expect(draft!.lines.map((l) => [l.jobId, l.description])).toEqual([
    [a, "Board A"],
    [b, "Board A"],
  ]);
  await expect(createInvoiceFromJobs(owner, [a], "tax")).rejects.toThrow("already on invoice"); // draft counts
  await expect(cancelJob(owner, a)).rejects.toThrow("on draft invoice");
  expect((await billableJobs(local)).map((j) => j.id)).not.toContain(a);

  await issueInvoice(owner, id);
  expect((await getJob(owner, a))!.status).toBe("invoiced");
  expect((await getJob(owner, b))!.status).toBe("invoiced");
  const salesLines = (await posted(id)).rows.filter((r) => r.key === "sales");
  expect(salesLines.map((r) => [r.jobId, r.credit])).toEqual([
    [a, 5000_00n],
    [b, 5000_00n],
  ]);
  await expect(setJobStatus(owner, a, "ready")).rejects.toThrow("invoiced job");
  await expect(cancelJob(owner, a)).rejects.toThrow("cancel the invoice first");

  await cancelInvoice(owner, id, "");
  const [ja, jb] = [await getJob(owner, a), await getJob(owner, b)];
  expect([ja!.status, jb!.status]).toEqual(["delivered", "ready"]);
  expect(ja!.history.slice(-2).map((h) => [h.from, h.to])).toEqual([
    ["delivered", "invoiced"],
    ["invoiced", "delivered"],
  ]);
  // The cancelled invoice frees them.
  const again = await createInvoiceFromJobs(owner, [a], "tax");
  expect((await getInvoice(again))!.lines).toHaveLength(1);
});

test("from a quotation without a job; the quotation is then locked to that invoice", async () => {
  const q = await createQuotation(owner, {
    customerId: String(outside),
    date: "29/09/2026",
    terms: "",
    notes: "",
    lines: JSON.stringify([line({ rate: "2500" })]),
  });
  await sendQuotation(owner, q);
  await approveQuotation(owner, q);
  const id = await createInvoiceFromQuotation(owner, q, "tax");
  const inv = await getInvoice(id);
  expect(inv).toMatchObject({ customerId: outside, placeOfSupply: "27", status: "draft" });
  expect(inv!.lines[0].quotationLineId).not.toBeNull();
  await expect(createInvoiceFromQuotation(owner, q, "tax")).rejects.toThrow("already on invoice");
  const header = { date: "29/09/2026", siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "" };
  await expect(createJobFromQuotation(owner, q, header)).rejects.toThrow("already on invoice");
  await expect(cancelQuotation(owner, q)).rejects.toThrow("cancel that first");
});

test("an invoice dated before the books start date is refused", async () => {
  await expect(createInvoice(owner, input(local, { date: "31/03/2026" }))).rejects.toMatchObject({ field: "date" });
  const id = await createInvoice(owner, input(local));
  await expect(updateInvoice(owner, id, input(local, { date: "15/03/2026" }))).rejects.toMatchObject({ field: "date" });
});

test("credit-limit warning: AR balance + this invoice over the limit (a warning, the invoice still issues)", async () => {
  const tight = await createCustomer(owner, customer({ name: "Tight Credit", creditLimit: "1,000" }));
  expect(await creditWarning(tight, 900_00n)).toBeNull();
  const id = await createInvoice(owner, input(tight));
  const { message } = await issueInvoice(owner, id);
  expect(message).toContain("Over the credit limit: ₹0.00 due + ₹1,180.00 = ₹1,180.00, limit ₹1,000.00.");
  expect((await getInvoice(id))!.status).toBe("issued");
  expect(await creditWarning(tight, 1n)).toContain("₹1,180.00 due");
});

test("due date = invoice date + the customer's credit days", async () => {
  const id = await createInvoice(owner, input(local, { date: "01/10/2026" }));
  expect((await getInvoice(id))!.dueDate).toBe(addDays("2026-10-01", 15));
});

test("sample PDFs render (saved to web/.samples/ for a look)", async () => {
  await mkdir(".samples", { recursive: true });
  const save = async (name: string, pdf: { bytes: Buffer } | null) => {
    expect(pdf!.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(`.samples/${name}.pdf`, pdf!.bytes);
  };
  const quote = await createQuotation(owner, {
    customerId: String(local),
    date: "29/09/2026",
    terms: "Valid for 15 days. 50% advance with order.",
    notes: "",
    lines: JSON.stringify([
      line({ description: "ACP elevation with acrylic letters", width: "20", height: "4", unit: "Sq Ft", qty: "", rate: "650" }),
      line({ description: "Installation", rate: "3,500", discount: "500" }),
    ]),
  });
  await save("quotation-gujarati", await quotationPdf(quote));

  const many = [
    line({ description: "LED glow sign board", width: "10", height: "3", unit: "Sq Ft", qty: "", rate: "450" }),
    line({ description: "Flex banner", width: "6", height: "3", unit: "Sq Ft", qty: "", rate: "18.50", discount: "25" }),
    line({ description: "Installation and fitting", rate: "1,500" }),
  ];
  const same = await createInvoice(owner, input(local, {}, many));
  await issueInvoice(owner, same);
  await save("tax-invoice-same-state", await invoicePdf(same));
  const other = await createInvoice(owner, input(outside, {}, many));
  await issueInvoice(owner, other);
  await save("tax-invoice-other-state", await invoicePdf(other));
  const est = await createInvoice(owner, input(local, { kind: "estimate" }, many));
  await issueInvoice(owner, est);
  await save("estimate", await invoicePdf(est));
  const cancelled = await createInvoice(owner, input(local, {}, many));
  await issueInvoice(owner, cancelled);
  await cancelInvoice(owner, cancelled, "sample");
  await save("cancelled-invoice", await invoicePdf(cancelled));
  const draft = await createInvoice(owner, input(local, {}, many));
  await save("draft-invoice", await invoicePdf(draft));

  const [{ n }] = await db.select({ n: count() }).from(invoices).where(sql`${invoices.number} like 'RDS/%'`);
  expect(n).toBeGreaterThan(0);
}, 60_000);
