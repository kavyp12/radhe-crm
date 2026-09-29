import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, auditLog, expenseCategories, journalEntries, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelExpense, createExpense, getExpense, listExpenses, updateExpense, type ExpenseInput } from "@/lib/expenses";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T20 (S10, A§3, D51): an expense posts Dr its category's account (with the job) / Cr the money account; a job-tagged
// one is in the job's ledger; an edit reverses and reposts (the trail stays); the backdate gate applies to non-owners.

let owner: SessionUser;
let accountant: SessionUser;
let labour: { id: number; accountId: number };
let diesel: { id: number; accountId: number };
let cashId: number;
let bankId: number;
let jobA: number;
let jobB: number;
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "EX accountant", username: "ex.accountant", role: "accountant" as Role, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "accountant-pass-123" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const category = async (name: string) => {
    const [c] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, name));
    return { id: c.id, accountId: c.accountId };
  };
  [labour, diesel] = [await category("Labour"), await category("Diesel/Petrol")];
  const money = await db.select().from(accounts).where(eq(accounts.isMoney, true));
  cashId = money.find((a) => a.systemKey === "cash")!.id;
  bankId = money.find((a) => a.systemKey === "bank_1")!.id;
  const customer = await createCustomer(owner, {
    name: "EX Job Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const categoryId = String((await db.query.productCategories.findFirst())!.id);
  const job = () =>
    createJob(owner, {
      customerId: String(customer), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
      lines: JSON.stringify([{ lineId: "", categoryId, description: "", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "10000", discount: "", gst: "0" }]),
    });
  [jobA, jobB] = [await job(), await job()];
});

const expense = (amount: string, patch: Partial<ExpenseInput> = {}): ExpenseInput => ({
  date: formatDate(today),
  categoryId: String(labour.id),
  vendorId: "",
  jobId: "",
  amount,
  mode: "cash",
  moneyAccountId: String(cashId),
  notes: "",
  ...patch,
});

/** The expense's journal entries, oldest first, with their lines. */
async function entries(id: number) {
  const rows = await db
    .select({ entry: journalEntries, account: journalLines.accountId, debit: journalLines.debitPaise, credit: journalLines.creditPaise, jobId: journalLines.jobId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.docType, "expenses"), eq(journalEntries.docId, id)))
    .orderBy(asc(journalEntries.id), asc(journalLines.id));
  return rows.map((r) => ({ date: r.entry.date, reverses: r.entry.reversesEntryId !== null, account: r.account, debit: r.debit, credit: r.credit, jobId: r.jobId }));
}

test("an expense posts Dr its category's account (with the job) / Cr the money account, and shows in the job's ledger", async () => {
  const before = (await ledger({ jobId: jobA })).closing;
  const { id, message } = await createExpense(owner, expense("1,850", { jobId: String(jobA), notes: "Fitters, 2 days" }));
  expect(message).toMatch(/^Saved EX\/26-27\/\d{4}\.$/);
  expect(await entries(id!)).toEqual([
    { date: today, reverses: false, account: labour.accountId, debit: 1850_00n, credit: 0n, jobId: jobA },
    { date: today, reverses: false, account: cashId, debit: 0n, credit: 1850_00n, jobId: null },
  ]);
  const job = await ledger({ jobId: jobA });
  expect(job.closing - before).toBe(1850_00n);
  expect(job.rows.at(-1)).toMatchObject({ docType: "expenses", docId: id, debit: 1850_00n });
  expect((await listExpenses()).find((e) => e.id === id)).toMatchObject({ category: "Labour", account: "Cash", amount: 1850_00n });
});

test("an edit reverses and reposts: the old entry, its reversal and the new one stay; the old values are in the audit log", async () => {
  const { id } = await createExpense(owner, expense("500", { categoryId: String(diesel.id), jobId: String(jobA) }));
  const input = expense("650", { categoryId: String(diesel.id), jobId: String(jobB), moneyAccountId: String(bankId), mode: "bank" });
  expect((await updateExpense(accountant, id!, input, "")).message).toMatch(/^Saved EX\//); // today: no approval needed
  const trail = await entries(id!);
  expect(trail.map((l) => [l.reverses, l.account, l.debit, l.credit, l.jobId])).toEqual([
    [false, diesel.accountId, 500_00n, 0n, jobA],
    [false, cashId, 0n, 500_00n, null],
    [true, diesel.accountId, 0n, 500_00n, jobA],
    [true, cashId, 500_00n, 0n, null],
    [false, diesel.accountId, 650_00n, 0n, jobB],
    [false, bankId, 0n, 650_00n, null],
  ]);
  // The job it left nets to zero; the new job carries it.
  const net = async (jobId: number) => (await ledger({ jobId })).rows.filter((r) => r.docId === id && r.docType === "expenses").reduce((s, r) => s + r.debit - r.credit, 0n);
  expect([await net(jobA), await net(jobB)]).toEqual([0n, 650_00n]);
  const [change] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "expenses"), eq(auditLog.rowId, String(id)), eq(auditLog.action, "update")));
  expect(change.userId).toBe(accountant.id);
  expect(change.oldData).toMatchObject({ amount_paise: 500_00, job_id: jobA });
  expect(change.newData).toMatchObject({ amount_paise: 650_00, job_id: jobB });

  // Notes only: nothing is reposted.
  await updateExpense(owner, id!, { ...input, notes: "Generator diesel" }, "");
  expect(await entries(id!)).toHaveLength(6);
});

test("cancel reverses on the expense date; a non-owner's backdated save, edit or cancel waits for the owner", async () => {
  const { id } = await createExpense(owner, expense("300"));
  await cancelExpense(accountant, id!, "Entered twice");
  expect((await getExpense(id!))!.status).toBe("cancelled");
  expect((await entries(id!)).filter((l) => l.reverses).map((l) => l.date)).toEqual([today, today]);

  const old = expense("120", { date: formatDate(addDays(today, -3)) }); // backdate days not set = anything before today (D39)
  expect(await createExpense(accountant, old)).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  const { id: mine } = await createExpense(owner, old);
  expect(await updateExpense(accountant, mine!, { ...old, amount: "130" }, "Typo")).toEqual({ message: SENT_FOR_APPROVAL });
  expect(await cancelExpense(accountant, mine!, "")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await getExpense(mine!))!).toMatchObject({ amountPaise: 120_00n, status: "active" });
});
