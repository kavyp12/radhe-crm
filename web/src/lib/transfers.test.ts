import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, auditLog, expenseCategories, journalEntries, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { SENT_FOR_APPROVAL } from "@/lib/approvals";
import { moneySummary, type MoneyRow } from "@/lib/cash-bank";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelExpense, createExpense } from "@/lib/expenses";
import { ledger } from "@/lib/ledger";
import { moneyText } from "@/lib/num";
import type { Role, SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { cancelTransfer, createTransfer, getTransfer, transferWarning, updateTransfer, type TransferInput } from "@/lib/transfers";
import { createUser } from "@/lib/users";

// T25 (S13, A§3, A§12, D55): a transfer posts Dr to / Cr from; an edit reverses and reposts (the trail stays); the
// cash & bank summary per money account is opening + received − paid = the journal's closing for the same period.

let owner: SessionUser;
let accountant: SessionUser;
const ids: Record<string, number> = {};
const today = todayIST();

beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "TR accountant", username: "tr.accountant", role: "accountant" as Role, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "accountant-pass-123" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  for (const a of await db.select().from(accounts).where(eq(accounts.isMoney, true))) ids[a.systemKey!] = a.id;
});

const transfer = (from: string, to: string, amount: string, patch: Partial<TransferInput> = {}): TransferInput => ({
  date: formatDate(today),
  fromAccountId: String(ids[from]),
  toAccountId: String(ids[to]),
  amount,
  reference: "",
  notes: "",
  ...patch,
});

/** The transfer's journal lines, oldest first. */
async function entries(id: number) {
  const rows = await db
    .select({ date: journalEntries.date, reverses: journalEntries.reversesEntryId, account: journalLines.accountId, debit: journalLines.debitPaise, credit: journalLines.creditPaise })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.docType, "transfers"), eq(journalEntries.docId, id)))
    .orderBy(asc(journalEntries.id), asc(journalLines.id));
  return rows.map((r) => [r.date, r.reverses !== null, r.account, r.debit, r.credit]);
}

test("a transfer posts both sides: Dr the to-account / Cr the from-account; the same account is refused", async () => {
  const { id, message } = await createTransfer(owner, transfer("cash", "bank_1", "5,000", { reference: "Deposit slip 4411" }));
  expect(message).toMatch(/^Saved TR\/26-27\/\d{4}\.$/);
  expect(await entries(id!)).toEqual([
    [today, false, ids.bank_1, 5000_00n, 0n],
    [today, false, ids.cash, 0n, 5000_00n],
  ]);
  expect((await getTransfer(id!))!).toMatchObject({ from: "Cash", to: "Bank 1", amountPaise: 5000_00n, reference: "Deposit slip 4411" });
  await expect(createTransfer(owner, transfer("upi", "upi", "10"))).rejects.toThrow("Pick two different accounts.");
  await expect(createTransfer(owner, transfer("upi", "bank_2", "0"))).rejects.toThrow("Enter the amount moved.");
});

test("an edit reverses on the old date and reposts; the trail stays and the old values are in the audit log", async () => {
  const { id } = await createTransfer(owner, transfer("upi", "bank_1", "1,200"));
  await updateTransfer(accountant, id!, transfer("upi", "bank_2", "1,250"), ""); // dated today: no approval needed
  expect(await entries(id!)).toEqual([
    [today, false, ids.bank_1, 1200_00n, 0n],
    [today, false, ids.upi, 0n, 1200_00n],
    [today, true, ids.bank_1, 0n, 1200_00n],
    [today, true, ids.upi, 1200_00n, 0n],
    [today, false, ids.bank_2, 1250_00n, 0n],
    [today, false, ids.upi, 0n, 1250_00n],
  ]);
  const [change] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "transfers"), eq(auditLog.rowId, String(id)), eq(auditLog.action, "update")));
  expect(change.userId).toBe(accountant.id);
  expect(change.oldData).toMatchObject({ amount_paise: 1200_00, to_account_id: ids.bank_1 });
  // A reference-only change posts nothing new; cancel reverses on the transfer's date.
  await updateTransfer(owner, id!, transfer("upi", "bank_2", "1,250", { reference: "UTR 998877" }), "");
  expect(await entries(id!)).toHaveLength(6);
  await cancelTransfer(owner, id!, "");
  expect((await getTransfer(id!))!.status).toBe("cancelled");
  expect((await entries(id!)).slice(6)).toEqual([
    [today, true, ids.bank_2, 0n, 1250_00n],
    [today, true, ids.upi, 1250_00n, 0n],
  ]);
});

test("a non-owner's backdated transfer, edit or cancel waits for the owner", async () => {
  const old = transfer("cash", "petty_cash", "300", { date: formatDate(addDays(today, -2)) }); // backdate days unset = before today (D39)
  expect(await createTransfer(accountant, old)).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  const { id } = await createTransfer(owner, old);
  expect(await updateTransfer(accountant, id!, { ...old, amount: "350" }, "Typo")).toEqual({ message: SENT_FOR_APPROVAL });
  expect(await cancelTransfer(accountant, id!, "")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await getTransfer(id!))!).toMatchObject({ amountPaise: 300_00n, status: "active" });
});

test("a transfer that takes the from-account below zero that day is saved, with a warning", async () => {
  const day = addDays(today, -1);
  await createTransfer(owner, transfer("bank_2", "petty_cash", "1,000", { date: formatDate(day) }));
  const balance = (await ledger({ account: "petty_cash" }, undefined, day)).closing;
  expect(balance > 0n).toBe(true);
  const input = transfer("petty_cash", "cash", moneyText(balance + 1_00n), { date: formatDate(day) });
  const warning = `Petty Cash would be ₹1.00 below zero at the end of ${formatDate(day)}.`;
  expect(await transferWarning(input)).toBe(warning);
  expect(await transferWarning({ ...input, amount: moneyText(balance) })).toBeNull();
  expect(await transferWarning({ ...input, amount: "abc" })).toBeNull(); // the form shows that error itself
  const { id } = await createTransfer(owner, input); // a warning, not a block
  expect(id).not.toBeNull();
  expect(await transferWarning(input, id!)).toBe(warning); // editing it: its own entry isn't counted twice
});

test("for each money account, opening + received − paid = the journal's closing for the same period", async () => {
  // Some traffic today: a receipt, an expense and its cancel (a pair), transfers both ways.
  const customer = await createCustomer(owner, {
    name: "TR Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  await createReceipt(owner, {
    customerId: String(customer), date: formatDate(today), amount: "2,500", mode: "upi", moneyAccountId: String(ids.upi),
    reference: "", chequeNo: "", chequeDate: "", receivedBy: "", notes: "", allocations: "[]",
  });
  const [labour] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Labour"));
  const summaryToday = async () => moneySummary({ from: today, to: today });
  const before = await summaryToday();
  const { id: expense } = await createExpense(owner, {
    date: formatDate(today), categoryId: String(labour.id), vendorId: "", jobId: "", amount: "777", mode: "cash", moneyAccountId: String(ids.cash), notes: "",
  });
  await cancelExpense(owner, expense!, "Entered twice");
  await createTransfer(owner, transfer("bank_1", "petty_cash", "400"));
  const after = await summaryToday();
  const row = (rows: MoneyRow[], key: string) => rows.find((r) => r.key === key)!;
  // The cancelled expense (a pair inside the period) moves neither column; the transfer does.
  expect([row(after, "cash").received - row(before, "cash").received, row(after, "cash").paid - row(before, "cash").paid]).toEqual([0n, 0n]);
  expect(row(after, "petty_cash").received - row(before, "petty_cash").received).toBe(400_00n);
  expect(row(after, "bank_1").paid - row(before, "bank_1").paid).toBe(400_00n);

  const month = { from: `${today.slice(0, 8)}01`, to: today };
  for (const range of [{ from: today, to: today }, month, { from: "2026-04-01", to: addDays(today, -1) }, { from: null, to: null }]) {
    const rows = await moneySummary(range);
    expect(rows.map((r) => r.key)).toEqual(["cash", "petty_cash", "upi", "bank_1", "bank_2"]);
    for (const r of rows) {
      const l = await ledger({ account: r.id }, range.from ?? undefined, range.to ?? undefined);
      expect(r.opening + r.received - r.paid).toBe(r.closing);
      expect([r.opening, r.closing]).toEqual([l.opening, l.closing]);
    }
  }
});
