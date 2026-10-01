import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { createInvoice, issueInvoice } from "@/lib/invoices";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import { addTotals, AGING, agingBucket, byPerson, emptyTotals, outstanding, type Totals } from "@/lib/outstanding";
import type { SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T28 (S7, D17, D57): aging buckets by invoice-date age (7/8, 15/16, 30/31, 60/61); due today vs overdue by due date;
// for every customer and in total, buckets + "opening / on account" = the AR balance from the journal; person-wise
// totals add up to the grand total.

let owner: SessionUser;
let categoryId: string;
let cash: number;
const staff: string[] = [];
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  cash = (await db.select().from(accounts).where(eq(accounts.systemKey, "cash")))[0].id;
  for (const name of ["OS Sales One", "OS Collector"]) {
    const user = { name, username: name.toLowerCase().replaceAll(" ", "."), role: "sales" as const, canViewCost: false };
    staff.push(await createUser(owner, { ...user, password: "os-sales-pass-123" }));
  }
});

const customerInput = (name: string, patch: Partial<CustomerInput> = {}): CustomerInput => ({
  name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
  creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "", ...patch,
});
const line = (rate: string) => ({ lineId: "", categoryId, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate, discount: "", gst: "0" });
async function invoice(customerId: number, rupees: string) {
  const id = await createInvoice(owner, { kind: "tax", customerId: String(customerId), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line(rupees)]) });
  await issueInvoice(owner, id);
  return id;
}
const receipt = (customerId: number, amount: string, allocations: { target: string; id: number; amount: string }[] = []) =>
  createReceipt(owner, {
    customerId: String(customerId), date: formatDate(today), amount, mode: "cash", moneyAccountId: String(cash), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: JSON.stringify(allocations.map((a) => ({ ...a, id: String(a.id) }))),
  });
const sumAging = (t: Totals) => AGING.reduce((s, b) => s + t.aging[b.key], 0n);

test("bucket boundaries: 7 / 8, 15 / 16, 30 / 31, 60 / 61 days", async () => {
  expect([0, 7, 8, 15, 16, 30, 31, 60, 61, 400, -2].map(agingBucket)).toEqual(
    ["d0_7", "d0_7", "d8_15", "d8_15", "d16_30", "d16_30", "d31_60", "d31_60", "d60", "d60", "d0_7"],
  );
  // The same through outstanding(): one ₹1,000 invoice dated today, seen from later days.
  const c = await createCustomer(owner, customerInput("OS Aging Customer"));
  await invoice(c, "1,000");
  for (const [days, bucket] of [[7, "d0_7"], [8, "d8_15"], [15, "d8_15"], [16, "d16_30"], [30, "d16_30"], [31, "d31_60"], [60, "d31_60"], [61, "d60"]] as const) {
    const row = (await outstanding(addDays(today, days))).customers.find((r) => r.id === c)!;
    expect([days, row.docs[0].age, row.docs[0].bucket, row.totals.aging[bucket]]).toEqual([days, days, bucket, 1000_00n]);
  }
});

test("due today vs overdue: by the due date (invoice date + the customer's credit days)", async () => {
  const c = await createCustomer(owner, customerInput("OS Credit Customer", { creditDays: "10" }));
  await invoice(c, "500");
  const at = async (days: number) => (await outstanding(addDays(today, days))).customers.find((r) => r.id === c)!.totals;
  expect([(await at(9)).dueToday, (await at(9)).overdue]).toEqual([0n, 0n]);
  expect([(await at(10)).dueToday, (await at(10)).overdue]).toEqual([500_00n, 0n]);
  expect([(await at(11)).dueToday, (await at(11)).overdue]).toEqual([0n, 500_00n]);
});

test("buckets + opening / on account = the AR balance, per customer and in total; person-wise totals = the grand total", async () => {
  const c = await createCustomer(owner, customerInput("OS Mixed Customer", { openingBalance: "1,500", salesPersonId: staff[0], collectionPersonId: staff[1] }));
  const [a, b] = [await invoice(c, "10,000"), await invoice(c, "4,000")];
  await receipt(c, "6,000", [{ target: "invoice", id: a, amount: "6,000" }]); // A: ₹4,000 open
  await receipt(c, "700"); // on account
  const job = await createJob(owner, {
    customerId: String(c), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([line("3,000")]),
  });
  await receipt(c, "1,000", [{ target: "job", id: job, amount: "1,000" }]); // a job advance
  const [dnLine] = await invoiceLinesLeft(db, "debit", b);
  const dn = await createNote(owner, "debit", b, { date: formatDate(today), reason: "Extra fitting", notes: "", lines: JSON.stringify([{ invoiceLineId: String(dnLine.id), qty: "1", amount: "250" }]) });
  await issueNote(owner, "debit", dn);
  const [cnLine] = await invoiceLinesLeft(db, "credit", b);
  const cn = await createNote(owner, "credit", b, { date: formatDate(today), reason: "Rate reduced", notes: "", lines: JSON.stringify([{ invoiceLineId: String(cnLine.id), qty: "1", amount: "400" }]) });
  await issueNote(owner, "credit", cn); // B: ₹3,600 open

  const report = await outstanding();
  const mine = report.customers.find((r) => r.id === c)!;
  expect(mine.docs.map((d) => [d.target, d.open])).toEqual([["invoice", 4000_00n], ["invoice", 3600_00n], ["debit_note", 250_00n]]);
  // Opening ₹1,500 − on account ₹700 − advance ₹1,000.
  expect([sumAging(mine.totals), mine.totals.onAccount, mine.totals.total]).toEqual([7850_00n, -200_00n, 7650_00n]);

  for (const row of report.customers) {
    expect(sumAging(row.totals) + row.totals.onAccount).toBe(row.totals.total);
    expect(row.totals.total).toBe((await ledger({ account: "ar", customerId: row.id })).closing);
  }
  const all = (await ledger({ account: "ar" })).closing;
  expect(report.totals.total).toBe(all);
  expect(sumAging(report.totals) + report.totals.onAccount).toBe(all);

  for (const kind of ["sales", "collection"] as const) {
    const groups = byPerson(report.customers, kind);
    expect(groups.reduce((t, g) => addTotals(t, g.totals), emptyTotals())).toEqual(report.totals);
    const person = groups.find((g) => g.id === staff[kind === "sales" ? 0 : 1])!;
    expect(person.customers.map((x) => x.id)).toEqual([c]);
  }
});
