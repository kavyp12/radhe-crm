import { mkdir, writeFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { GET as shareRoute } from "@/app/share/[token]/route";
import { db } from "@/db";
import { accounts, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { customerAdvance, customerHistory } from "@/lib/customer-history";
import { createCustomer, customerOverview, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, createInvoiceFromJobs, issueInvoice } from "@/lib/invoices";
import { createJobFromQuotation, setJobStatus } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { LineText } from "@/lib/lines";
import { statementPdf } from "@/lib/pdf";
import type { SessionUser } from "@/lib/permissions";
import { approveQuotation, createQuotation, sendQuotation } from "@/lib/quotations";
import { cancelReceipt, createReceipt, updateReceipt, type ReceiptInput } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createStatementLink, customerLedger, readRange, withoutReversed } from "@/lib/statements";

let owner: SessionUser;
let categoryId: string;
let cashId: string;
const today = todayIST();

const customer = (name: string, patch: Partial<CustomerInput> = {}): CustomerInput => ({
  name,
  firmName: "",
  mobile: "9876543210",
  email: "",
  gstin: "",
  stateCode: "24",
  billingAddress: "Satellite, Ahmedabad",
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
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  cashId = String((await db.query.accounts.findFirst({ where: eq(accounts.systemKey, "cash") }))!.id);
});

const line = (rate: string): LineText => ({
  lineId: "",
  categoryId,
  description: "Glow sign board",
  hsnSac: "",
  width: "",
  height: "",
  qty: "1",
  unit: "Nos",
  rate,
  discount: "",
  gst: "0",
});

async function invoice(customerId: number, rupees: string, date = today) {
  const id = await createInvoice(owner, {
    kind: "tax",
    customerId: String(customerId),
    date: formatDate(date),
    terms: "",
    notes: "",
    lines: JSON.stringify([line(rupees)]),
  });
  await issueInvoice(owner, id);
  return id;
}

const receipt = (customerId: number, amount: string, lines: ["invoice" | "job", number, string][] = [], date = today): ReceiptInput => ({
  customerId: String(customerId),
  date: formatDate(date),
  amount,
  mode: "cash",
  moneyAccountId: cashId,
  reference: "",
  chequeNo: "",
  chequeDate: "",
  receivedBy: "",
  notes: "",
  allocations: JSON.stringify(lines.map(([target, id, a]) => ({ target, id: String(id), amount: a }))),
});

/** The customer's AR balance straight from journal_lines (independent of ledger()). */
async function arSum(customerId: number) {
  const ar = (await db.query.accounts.findFirst({ where: eq(accounts.systemKey, "ar") }))!.id;
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
    .from(journalLines)
    .where(and(eq(journalLines.accountId, ar), eq(journalLines.customerId, customerId)));
  return BigInt(row.net);
}

let shared: { id: number; token: string };

test("the ledger closing = the customer's AR balance across documents, reversals included", async () => {
  const c = await createCustomer(owner, customer("Ledger Traders", { openingBalance: "1,000" }));
  const a = await invoice(c, "5,000", addDays(today, -10));
  await createReceipt(owner, receipt(c, "2,000", [["invoice", a, "2,000"]], addDays(today, -5)));
  const { id: bounced } = await createReceipt(owner, receipt(c, "500", [], addDays(today, -4)));
  await cancelReceipt(owner, bounced!, "Cheque bounced"); // reversal
  const wrong = await invoice(c, "3,000", addDays(today, -3));
  await cancelInvoice(owner, wrong, "Wrong customer"); // reversal
  const { id: edited } = await createReceipt(owner, receipt(c, "700", [], addDays(today, -2)));
  await updateReceipt(owner, edited!, receipt(c, "800", [], addDays(today, -2)), ""); // reverse + repost

  // ₹1,000 opening + ₹5,000 − ₹2,000 − ₹800 = ₹3,200 Dr; the cancelled ones net to zero.
  const all = await ledger({ account: "ar", customerId: c });
  expect(all.closing).toBe(3200_00n);
  expect(all.closing).toBe(await arSum(c));
  expect((await customerOverview(c)).outstanding).toBe(all.closing);
  expect(all.rows.at(-1)!.balance).toBe(all.closing);
  expect(all.rows.filter((r) => r.reverses !== null)).toHaveLength(3);

  // A range: opening = everything before it; opening + its lines = the same closing.
  const { range } = readRange("custom", formatDate(addDays(today, -4)), formatDate(today));
  const part = await customerLedger(c, range);
  expect(part.opening).toBe(1000_00n + 5000_00n - 2000_00n);
  expect(part.opening + part.debit - part.credit).toBe(part.closing);
  expect(part.closing).toBe(all.closing);
  shared = { id: c, token: await createStatementLink(owner, c, range) };
});

test("the statement shows the ledger's figures; a sample PDF is saved", async () => {
  const { range } = readRange("fy");
  const l = await customerLedger(shared.id, range);
  const all = await ledger({ account: "ar", customerId: shared.id }, range.from!, range.to!);
  expect([l.opening, l.closing, l.rows.map((r) => r.balance)]).toEqual([all.opening, all.closing, all.rows.map((r) => r.balance)]);
  expect(l.debit - l.credit).toBe(l.closing - l.opening);

  const pdf = (await statementPdf(shared.id, range))!;
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.fileName).toBe(`statement-${shared.id}-${today}.pdf`);
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/statement.pdf", pdf.bytes);
}, 30_000);

test("the statement leaves out reversed entries with their reversals (D50); the ledger keeps them", async () => {
  const l = await customerLedger(shared.id, { from: null, to: null });
  expect(l.rows).toHaveLength(10); // opening, invoice, receipt, 3 cancelled / edited + their 3 reversals, the repost
  const s = withoutReversed(l);
  // Opening ₹1,000 · invoice ₹5,000 · receipt ₹2,000 · the edited receipt as it stands (₹800).
  expect(s.rows.map((r) => r.debit || r.credit)).toEqual([1000_00n, 5000_00n, 2000_00n, 800_00n]);
  expect(s.rows.map((r) => r.balance)).toEqual([1000_00n, 6000_00n, 4000_00n, 3200_00n]);
  expect([s.opening, s.closing, s.debit, s.credit]).toEqual([0n, l.closing, 6000_00n, 2800_00n]);
});

test("the statement share link works without a login; a wrong token gets 404", async () => {
  const get = (token: string) => shareRoute(new Request(`http://x/share/${token}`), { params: Promise.resolve({ token }) });
  const ok = await get(shared.token);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("application/pdf");
  const wrong = shared.token.slice(0, -1) + (shared.token.endsWith("A") ? "B" : "A");
  expect((await get(wrong)).status).toBe(404);
  expect((await get("nope")).status).toBe(404);
}, 30_000);

test("history: quotation → job → invoice → payment → pending in one chain, with the pipeline label", async () => {
  const c = await createCustomer(owner, customer("History Signs", { creditDays: "30" }));
  const q = await createQuotation(owner, { customerId: String(c), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line("9,000")]) });
  expect((await customerHistory(c)).map((h) => h.label)).toEqual(["Draft"]);
  await sendQuotation(owner, q);
  await approveQuotation(owner, q);
  const header = { date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "" };
  const job = await createJobFromQuotation(owner, q, header);
  await createReceipt(owner, receipt(c, "4,000", [["job", job, "4,000"]]));
  expect(await customerAdvance(c)).toEqual({ onJobs: 4000_00n, onPrintJobs: 0n, onAccount: 0n });
  expect((await customerHistory(c))[0]).toMatchObject({ label: "In Production", pending: 0n });

  await setJobStatus(owner, job, "delivered");
  const inv = await createInvoiceFromJobs(owner, [job], "tax");
  await issueInvoice(owner, inv);
  await createReceipt(owner, receipt(c, "2,000", [["invoice", inv, "2,000"]]));
  const blank = await invoice(c, "1,500"); // an invoice of its own: its own chain

  const chains = await customerHistory(c);
  expect(chains).toHaveLength(2);
  const main = chains.find((h) => h.quotations.length)!;
  expect(main.quotations.map((x) => x.id)).toEqual([q]);
  expect(main.jobs.map((x) => [x.id, x.status])).toEqual([[job, "Invoiced"]]);
  expect(main.invoices.map((x) => [x.id, x.payment])).toEqual([[inv, "Part Payment"]]);
  expect(main.payments.map((p) => p.amount)).toEqual([4000_00n, 2000_00n]); // the advance moved at Issue, then a payment
  expect(main).toMatchObject({ label: "Part Payment", pending: 3000_00n });
  expect(chains.find((h) => !h.quotations.length)).toMatchObject({ label: "Unpaid", pending: 1500_00n });
  expect(chains.find((h) => !h.quotations.length)!.invoices[0].id).toBe(blank);
  expect(await customerAdvance(c)).toEqual({ onJobs: 0n, onPrintJobs: 0n, onAccount: 0n });
});
