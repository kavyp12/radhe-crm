import { mkdir, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, allocations } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { advanceAdjusted, applyOnAccount, onAccountSources, openJobs } from "@/lib/allocations";
import { customerAdvance } from "@/lib/customer-history";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, createInvoiceFromJobs, getInvoice, issueInvoice } from "@/lib/invoices";
import { createJob, getJob, setJobStatus } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { LineText } from "@/lib/lines";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import { invoicePdf } from "@/lib/pdf";
import type { SessionUser } from "@/lib/permissions";
import { createReceipt, getReceipt, jobAdvances, updateReceipt, type ReceiptInput } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";

// T14 (S12, S5, D49): an advance allocated to a job moves to the job's invoice at Issue, up to its open amount; any
// excess stays on account; cancelling the invoice puts it back on the job.

let owner: SessionUser;
let categoryId: string;
let cashId: string;
const today = todayIST();

const customer = (name: string): CustomerInput => ({
  name,
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
  description: "ACP elevation",
  hsnSac: "",
  width: "",
  height: "",
  qty: "1",
  unit: "Nos",
  rate,
  discount: "",
  gst: "0",
});

/** A delivered job worth `rupees` (GST 0, so totals are exact). */
async function job(customerId: number, rupees: string) {
  const id = await createJob(owner, {
    customerId: String(customerId),
    date: formatDate(today),
    siteAddress: "",
    siteReference: "",
    vehicleNo: "",
    salesPersonId: "",
    targetDate: "",
    notes: "",
    lines: JSON.stringify([line(rupees)]),
  });
  await setJobStatus(owner, id, "delivered");
  return id;
}

const receipt = (customerId: number, amount: string, lines: ["invoice" | "job", number, string][], date = today): ReceiptInput => ({
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

async function billJob(jobId: number) {
  const id = await createInvoiceFromJobs(owner, [jobId], "tax");
  await issueInvoice(owner, id);
  return id;
}

const ar = async (customerId: number) => (await ledger({ account: "ar", customerId })).closing;

test("₹10,000 advance on a job → its ₹25,000 invoice shows advance adjusted ₹10,000 and balance ₹15,000", async () => {
  const c = await createCustomer(owner, customer("Advance Ten"));
  const j = await job(c, "25,000");
  const { id: rc } = await createReceipt(owner, receipt(c, "10,000", [["job", j, "10,000"]]));
  expect((await openJobs(db, c)).map((o) => [o.id, o.advance])).toEqual([[j, 10000_00n]]);
  expect((await jobAdvances(j)).map((a) => a.amount)).toEqual([10000_00n]);

  const inv = await billJob(j);
  const got = (await getInvoice(inv))!;
  expect(got).toMatchObject({ totalPaise: 25000_00n, advance: 10000_00n, balance: 15000_00n, open: 15000_00n, payment: "Part Payment" });
  // The job's row is replaced by one on the invoice from the same receipt; the job holds nothing now.
  expect(await jobAdvances(j)).toEqual([]);
  const r = (await getReceipt(rc!))!;
  expect(r.lines.map((l) => [l.invoiceId, l.fromJobId, l.amount])).toEqual([[inv, j, 10000_00n]]);
  expect(r.removed.map((l) => [l.jobId, l.amount])).toEqual([[j, 10000_00n]]);
  expect(r.onAccount).toBe(0n);
  expect(await ar(c)).toBe(15000_00n);

  // The PDF carries Advance adjusted + Balance (saved for a look).
  await mkdir(".samples", { recursive: true });
  const pdf = (await invoicePdf(inv))!;
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  await writeFile(".samples/invoice-advance-adjusted.pdf", pdf.bytes);
});

test("₹30,000 advance on a ₹25,000 invoice → Paid, ₹5,000 stays on account; cancelling puts ₹25,000 back on the job", async () => {
  const c = await createCustomer(owner, customer("Advance Thirty"));
  const j = await job(c, "25,000");
  const { id: rc } = await createReceipt(owner, receipt(c, "30,000", [["job", j, "30,000"]]));
  const inv = await billJob(j);
  expect((await getInvoice(inv))!).toMatchObject({ payment: "Paid", open: 0n, advance: 25000_00n, balance: 0n });
  expect((await getReceipt(rc!))!).toMatchObject({ allocated: 25000_00n, onAccount: 5000_00n });
  expect(await ar(c)).toBe(-5000_00n);

  await cancelInvoice(owner, inv, "Re-bill with the right rate");
  expect((await getJob(owner, j))!.status).toBe("delivered");
  expect((await jobAdvances(j)).map((a) => [a.receiptId, a.amount])).toEqual([[rc, 25000_00n]]);
  expect(await advanceAdjusted(db, inv)).toBe(0n);
  expect((await getReceipt(rc!))!).toMatchObject({ allocated: 25000_00n, onAccount: 5000_00n });

  // Billing the job again moves the advance again.
  const again = await billJob(j);
  expect((await getInvoice(again))!).toMatchObject({ payment: "Paid", advance: 25000_00n });
});

test("several advances move oldest first; what doesn't fit goes on account; other money on the invoice goes on account at cancel", async () => {
  const c = await createCustomer(owner, customer("Two Advances"));
  const j = await job(c, "25,000");
  const { id: first } = await createReceipt(owner, receipt(c, "10,000", [["job", j, "10,000"]], addDays(today, -2)));
  const { id: second } = await createReceipt(owner, receipt(c, "20,000", [["job", j, "20,000"]]));
  const inv = await billJob(j);
  expect((await getReceipt(first!))!.lines.map((l) => l.amount)).toEqual([10000_00n]);
  expect((await getReceipt(second!))!).toMatchObject({ allocated: 15000_00n, onAccount: 5000_00n });
  expect((await getInvoice(inv))!).toMatchObject({ advance: 25000_00n, payment: "Paid" });

  // A plain payment on another invoice, then that invoice is cancelled: the money goes on account, not to a job.
  const other = await createInvoice(owner, {
    kind: "tax",
    customerId: String(c),
    date: formatDate(today),
    terms: "",
    notes: "",
    lines: JSON.stringify([line("4,000")]),
  });
  await issueInvoice(owner, other);
  const { id: third } = await createReceipt(owner, receipt(c, "4,000", [["invoice", other, "4,000"]]));
  await cancelInvoice(owner, other, "");
  expect((await getReceipt(third!))!).toMatchObject({ allocated: 0n, onAccount: 4000_00n });
  expect(await jobAdvances(j)).toEqual([]);
});

test("advances go only to open jobs; a receipt edit keeps the advance it carried onto an invoice", async () => {
  const c = await createCustomer(owner, customer("Edit Advance"));
  const j = await job(c, "25,000");
  const { id: rc } = await createReceipt(owner, receipt(c, "10,000", [["job", j, "10,000"]]));
  const inv = await billJob(j);
  // The job is invoiced now: no more advances for it.
  await expect(createReceipt(owner, receipt(c, "1,000", [["job", j, "1,000"]]))).rejects.toThrow("allocate to its invoice");
  expect((await openJobs(db, c)).map((o) => o.id)).not.toContain(j);

  // Raise the receipt to ₹12,000 with ₹12,000 on the invoice: the lines change, the advance link stays.
  await updateReceipt(owner, rc!, receipt(c, "12,000", [["invoice", inv, "12,000"]]), "");
  expect((await getInvoice(inv))!).toMatchObject({ advance: 12000_00n, open: 13000_00n, balance: 13000_00n });
  const rows = await db.select().from(allocations).where(and(eq(allocations.receiptId, rc!), eq(allocations.active, true)));
  expect(rows.map((r) => [r.invoiceId, r.fromJobId, r.amountPaise])).toEqual([[inv, j, 12000_00n]]);
});

test("D50: a receipt's rest and a credit note's leftover credit are applied on account; the job's part moves at Issue", async () => {
  const c = await createCustomer(owner, customer("On Account Signs"));
  const plain = async (rupees: string) => {
    const id = await createInvoice(owner, { kind: "tax", customerId: String(c), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line(rupees)]) });
    await issueInvoice(owner, id);
    return id;
  };
  // A paid ₹1,000 invoice gets a ₹300 credit note → ₹300 customer credit. A ₹5,000 receipt sits on account.
  const paid = await plain("1,000");
  await createReceipt(owner, receipt(c, "1,000", [["invoice", paid, "1,000"]]));
  const [invLine] = await invoiceLinesLeft(db, "credit", paid);
  const cn = await createNote(owner, "credit", paid, {
    date: formatDate(today),
    reason: "Rate correction",
    notes: "",
    lines: JSON.stringify([{ invoiceLineId: String(invLine.id), qty: "", amount: "300" }]),
  });
  await issueNote(owner, "credit", cn);
  const { id: rc } = await createReceipt(owner, receipt(c, "5,000", []));
  const [a, b] = [await plain("2,000"), await plain("1,500")];
  const j = await job(c, "4,000");
  expect((await onAccountSources(db, c)).map((s) => [s.kind, s.id, s.rest])).toEqual([
    ["credit_note", cn, 300_00n],
    ["receipt", rc, 5000_00n],
  ]);
  const apply = (kind: "receipt" | "credit_note", id: number, lines: ["invoice" | "job", number, string][]) =>
    applyOnAccount(owner, c, { kind, id }, JSON.stringify(lines.map(([target, x, amount]) => ({ target, id: String(x), amount }))));

  await apply("receipt", rc!, [["invoice", a, "2,000"], ["invoice", b, "1,000"], ["job", j, "1,500"]]);
  await expect(apply("receipt", rc!, [["invoice", b, "600"]])).rejects.toThrow("more than the ₹500.00 RC/");
  await expect(apply("credit_note", cn, [["invoice", b, "600"]])).rejects.toThrow("more than the ₹300.00 CN/");
  await apply("credit_note", cn, [["job", j, "300"]]);
  expect((await getInvoice(a))!.payment).toBe("Paid");
  expect((await getInvoice(b))!).toMatchObject({ open: 500_00n, payment: "Part Payment" });
  expect((await jobAdvances(j)).map((x) => [x.receiptId, x.creditNoteId, x.amount])).toEqual([
    [rc, null, 1500_00n],
    [null, cn, 300_00n],
  ]);
  expect(await customerAdvance(c)).toEqual({ onJobs: 1800_00n, onPrintJobs: 0n, onAccount: 500_00n });

  // Issue moves both advances onto the invoice; a cancel puts both back on the job.
  const inv = await billJob(j);
  expect((await getInvoice(inv))!).toMatchObject({ advance: 1800_00n, open: 2200_00n });
  await cancelInvoice(owner, inv, "Re-bill");
  expect((await jobAdvances(j)).map((x) => x.amount)).toEqual([1500_00n, 300_00n]);

  // More of the same receipt on an invoice it already pays: one line, added up.
  await apply("receipt", rc!, [["invoice", b, "500"]]);
  expect((await getReceipt(rc!))!.lines.filter((l) => l.invoiceId === b).map((l) => l.amount)).toEqual([1500_00n]);
  expect(await onAccountSources(db, c)).toEqual([]);
  expect(await customerAdvance(c)).toEqual({ onJobs: 1800_00n, onPrintJobs: 0n, onAccount: 0n });
});
