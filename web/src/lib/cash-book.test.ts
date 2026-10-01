import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, approvalRequests, cashCounts, expenseCategories, journalEntries, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createAdjustment } from "@/lib/adjustments";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { cashBook, postCountDifference, saveCashCount } from "@/lib/cash-book";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate } from "@/lib/dates";
import { cancelExpense, createExpense } from "@/lib/expenses";
import { ledger } from "@/lib/ledger";
import { formatMoney, moneyText } from "@/lib/num";
import type { Role, SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createTransfer } from "@/lib/transfers";
import { createUser } from "@/lib/users";
import { createVendorPayment } from "@/lib/vendor-payments";
import { createVendor } from "@/lib/vendors";

// T26 (S14, A§3, D55): one day of Cash from the journal, grouped by document type; opening = the day before's closing;
// a count's difference posts to cash_short_excess (short: Dr it / Cr cash, excess: the other way) — the owner directly,
// the accountant through approval.

let owner: SessionUser;
let accountant: SessionUser;
const ids: Record<string, number> = {};
// Quiet past days (only this file posts on them); the owner is never held by the backdate gate.
const DAY = "2026-06-10";
const COUNT_DAY = "2026-06-20";

beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "CB accountant", username: "cb.accountant", role: "accountant" as Role, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "accountant-pass-123" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  for (const a of await db.select().from(accounts)) if (a.systemKey) ids[a.systemKey] = a.id;
});

const moneyInput = (date: string, amount: string, account = ids.cash) => ({
  date: formatDate(date), amount, mode: "cash", moneyAccountId: String(account), reference: "", chequeNo: "", chequeDate: "", notes: "",
});

test("the day's groups add up to the journal movement on the Cash account; each document lands in its group", async () => {
  const customer = await createCustomer(owner, {
    name: "CB Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const vendor = await createVendor(owner, { name: "CB Supplier", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
  const [labour] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Labour"));
  const expense = (amount: string) =>
    createExpense(owner, { ...moneyInput(DAY, amount), categoryId: String(labour.id), vendorId: "", jobId: "", notes: "" });
  const move = (from: string, to: string, amount: string) =>
    createTransfer(owner, { date: formatDate(DAY), fromAccountId: String(ids[from]), toAccountId: String(ids[to]), amount, reference: "", notes: "" });

  const { id: receipt } = await createReceipt(owner, { ...moneyInput(DAY, "5,000"), customerId: String(customer), receivedBy: "", allocations: "[]" });
  await expense("1,200");
  const { id: twice } = await expense("400");
  await cancelExpense(owner, twice!, "Entered twice"); // a pair: nets to zero in its group
  await createVendorPayment(owner, { ...moneyInput(DAY, "2,000"), vendorId: String(vendor), allocations: "[]" });
  await move("cash", "bank_1", "1,500"); // deposited in bank
  await move("cash", "upi", "100"); // UPI counts as a bank (A§12)
  await move("bank_2", "cash", "700"); // other: a transfer in
  await move("cash", "petty_cash", "300"); // other: not a bank
  await createAdjustment(owner, {
    kind: "journal", date: formatDate(DAY), narration: "Found in the drawer", customerId: "", amount: "", moneyAccountId: "", allocations: "[]",
    lines: JSON.stringify([{ accountId: String(ids.cash), debit: "50" }, { accountId: String(ids.cash_short_excess), credit: "50" }]),
  });
  await createAdjustment(owner, {
    kind: "refund", date: formatDate(DAY), narration: "", customerId: String(customer), amount: "600", moneyAccountId: String(ids.cash), lines: "[]",
    allocations: JSON.stringify([{ target: "receipt", id: String(receipt), amount: "600" }]),
  }); // D56: refunds get their own group

  const book = await cashBook(ids.cash, DAY);
  const total = Object.fromEntries(book.groups.map((g) => [g.key, g.total]));
  expect(total).toEqual({ received: 5000_00n, expense: -1200_00n, purchase: -2000_00n, refunds: -600_00n, deposited: -1600_00n, other: 450_00n });
  expect(book.groups.find((g) => g.key === "expense")!.entries.map((e) => [e.amount, e.reversal])).toEqual([
    [-1200_00n, false],
    [-400_00n, false],
    [400_00n, true],
  ]);
  const movement = book.groups.reduce((s, g) => s + g.total, 0n);
  const journal = await ledger({ account: "cash" }, DAY, DAY);
  expect(movement).toBe(journal.closing - journal.opening);
  expect([book.opening, book.closing]).toEqual([journal.opening, journal.closing]);

  // Petty Cash has its own book: the ₹300 came in (other).
  const petty = await cashBook(ids.petty_cash, DAY);
  expect(petty.groups.find((g) => g.key === "other")!.total).toBe(300_00n);
});

test("opening = the previous day's closing", async () => {
  for (const account of [ids.cash, ids.petty_cash]) {
    for (const day of [DAY, addDays(DAY, 1), "2026-04-01"]) {
      expect((await cashBook(account, day)).opening).toBe((await cashBook(account, addDays(day, -1))).closing);
    }
  }
  expect((await cashBook(ids.cash, addDays(DAY, 1))).opening).toBe((await cashBook(ids.cash, DAY)).closing);
});

/** The count's posted lines, net per system key (+Dr / −Cr). */
async function posted(countId: number) {
  const rows = await db
    .select({ key: accounts.systemKey, debit: journalLines.debitPaise, credit: journalLines.creditPaise, date: journalEntries.date })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, "cash_counts"), eq(journalEntries.docId, countId)))
    .orderBy(asc(journalLines.id));
  const net: Record<string, bigint> = {};
  for (const r of rows) net[r.key!] = (net[r.key!] ?? 0n) + r.debit - r.credit;
  return { net, dates: [...new Set(rows.map((r) => r.date))] };
}

const latestCount = async () => (await db.select().from(cashCounts).orderBy(asc(cashCounts.id))).at(-1)!;
const count = (actor: SessionUser, counted: bigint, account = ids.petty_cash) =>
  saveCashCount(actor, { accountId: String(account), date: formatDate(COUNT_DAY), counted: moneyText(counted) });

test("a short and an excess count each post correctly; a posted or matching count posts nothing more", async () => {
  await createTransfer(owner, { date: formatDate(COUNT_DAY), fromAccountId: String(ids.bank_1), toAccountId: String(ids.petty_cash), amount: "1,000", reference: "", notes: "" });
  const book = (await cashBook(ids.petty_cash, COUNT_DAY)).closing;

  expect((await count(owner, book - 50_00n)).message).toBe(`Counted ${formatMoney(book - 50_00n)}: short ₹50.00 against the book.`);
  const short = await latestCount();
  expect((await cashBook(ids.petty_cash, COUNT_DAY)).count).toMatchObject({ id: short.id, difference: -50_00n, posted: false, countedByName: owner.name });
  expect((await postCountDifference(owner, short.id, "")).message).toBe("Difference posted: the book now matches the count.");
  expect(await posted(short.id)).toEqual({ net: { cash_short_excess: 50_00n, petty_cash: -50_00n }, dates: [COUNT_DAY] });
  expect((await cashBook(ids.petty_cash, COUNT_DAY)).count).toMatchObject({ difference: 0n, posted: true });
  await expect(postCountDifference(owner, short.id, "")).rejects.toThrow("This count's difference is already posted.");

  await count(owner, book - 30_00n); // a recount finds ₹20 more than the book now says
  const excess = await latestCount();
  await expect(postCountDifference(owner, short.id, "")).rejects.toThrow("There is a later count of that day");
  await postCountDifference(owner, excess.id, "");
  expect(await posted(excess.id)).toEqual({ net: { petty_cash: 20_00n, cash_short_excess: -20_00n }, dates: [COUNT_DAY] });
  expect((await cashBook(ids.petty_cash, COUNT_DAY)).closing).toBe(book - 30_00n);

  await count(owner, book - 30_00n);
  await expect(postCountDifference(owner, (await latestCount()).id, "")).rejects.toThrow("The count matches the book: there is nothing to post.");
  await expect(saveCashCount(owner, { accountId: String(ids.bank_1), date: formatDate(COUNT_DAY), counted: "10" })).rejects.toThrow("Pick Cash or Petty Cash.");
});

test("the accountant's difference goes for approval; the owner's approval posts it, unless the book changed meanwhile", async () => {
  const day = addDays(COUNT_DAY, 1);
  const closing = (await cashBook(ids.cash, day)).closing;
  await saveCashCount(accountant, { accountId: String(ids.cash), date: formatDate(day), counted: moneyText(closing - 25_00n) });
  const mine = await latestCount();
  expect(mine.countedBy).toBe(accountant.id);
  expect(await postCountDifference(accountant, mine.id, "Drawer short at closing")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await posted(mine.id)).net).toEqual({});
  const [request] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, "cash_count.post"), eq(approvalRequests.targetId, mine.id)));
  expect(request.summary).toBe(`Post the cash count difference: short ₹25.00 (Cash, ${formatDate(day)})`);
  await approve(owner, request.id, "");
  expect((await posted(mine.id)).net).toEqual({ cash_short_excess: 25_00n, cash: -25_00n });

  // A request made against an older book is refused when approved.
  await saveCashCount(accountant, { accountId: String(ids.cash), date: formatDate(day), counted: moneyText(closing - 10_00n) });
  const next = await latestCount();
  await postCountDifference(accountant, next.id, "");
  const [stale] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, "cash_count.post"), eq(approvalRequests.targetId, next.id)));
  await createTransfer(owner, { date: formatDate(day), fromAccountId: String(ids.bank_1), toAccountId: String(ids.cash), amount: "5", reference: "", notes: "" });
  await expect(approve(owner, stale.id, "")).rejects.toThrow(`The book for ${formatDate(day)} changed since this was asked`);
  expect((await posted(next.id)).net).toEqual({});
});
