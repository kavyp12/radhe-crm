import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { accounts, adjustments, approvalRequests, journalEntries, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { cancelAdjustment, createAdjustment, getAdjustment, type AdjustmentInput } from "@/lib/adjustments";
import { onAccountSources, openInvoices } from "@/lib/allocations";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { customerHistory } from "@/lib/customer-history";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { formatDate, todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, getInvoice, issueInvoice } from "@/lib/invoices";
import { ledger, post } from "@/lib/ledger";
import type { LineText } from "@/lib/lines";
import { cancelNote, createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelReceipt, createReceipt, getReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

// T24 (S22, A§3, A§7, D55): a JV must balance; a write-off / discount settles invoices (open amount down, bad_debts /
// discount_allowed up); a refund uses up on-account money and never more; a non-owner's JV waits for the owner; cancel
// reverses it and gives back what it settled.

let owner: SessionUser;
let accountant: SessionUser;
let categoryId: string;
const ids: Record<string, number> = {};
const today = todayIST();

const customerInput = (name: string): CustomerInput => ({
  name, firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
  creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
});

beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "JV accountant", username: "jv.accountant", role: "accountant" as Role, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "accountant-pass-123" }) };
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  for (const a of await db.select().from(accounts)) if (a.systemKey) ids[a.systemKey] = a.id;
});

/** An issued tax invoice for `rupees` (GST 0, so the total is exact). */
async function invoice(customerId: number, rupees: string) {
  const line: LineText = { lineId: "", categoryId, description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: rupees, discount: "", gst: "0" };
  const id = await createInvoice(owner, { kind: "tax", customerId: String(customerId), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([line]) });
  await issueInvoice(owner, id);
  return id;
}

const receipt = (customerId: number, amount: string, lines: [number, string][] = []) =>
  createReceipt(owner, {
    customerId: String(customerId), date: formatDate(today), amount, mode: "cash", moneyAccountId: String(ids.cash), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: JSON.stringify(lines.map(([id, a]) => ({ target: "invoice", id: String(id), amount: a }))),
  });

const blank: AdjustmentInput = { kind: "journal", date: formatDate(today), narration: "", lines: "[]", customerId: "", amount: "", moneyAccountId: "", allocations: "[]" };
const jv = (lines: { accountId: number; debit?: string; credit?: string; customerId?: number; vendorId?: number }[], narration = "Correction") => ({
  ...blank,
  narration,
  lines: JSON.stringify(lines.map((l) => ({ accountId: String(l.accountId), debit: l.debit ?? "", credit: l.credit ?? "", customerId: l.customerId ? String(l.customerId) : "", vendorId: l.vendorId ? String(l.vendorId) : "", jobId: "" }))),
});
const customerAdjustment = (kind: string, customerId: number, amount: string, allocations: { target: string; id: number; amount: string }[], patch: Partial<AdjustmentInput> = {}) => ({
  ...blank,
  kind,
  customerId: String(customerId),
  amount,
  allocations: JSON.stringify(allocations.map((a) => ({ ...a, id: String(a.id) }))),
  ...patch,
});

const open = async (customerId: number, invoiceId: number) => (await openInvoices(db, customerId)).find((i) => i.id === invoiceId)?.open ?? 0n;
const onAccount = async (customerId: number) => (await onAccountSources(db, customerId)).reduce((s, x) => s + x.rest, 0n);
const arBalance = async (customerId: number) => (await ledger({ account: "ar", customerId })).closing;

/** The JV's journal lines, net per system key / account id (+Dr / −Cr), all entries together. */
async function posted(id: number) {
  const rows = await db
    .select({ key: accounts.systemKey, account: journalLines.accountId, debit: journalLines.debitPaise, credit: journalLines.creditPaise })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, "adjustments"), eq(journalEntries.docId, id)))
    .orderBy(asc(journalLines.id));
  const net: Record<string, bigint> = {};
  for (const r of rows) net[r.key ?? r.account] = (net[r.key ?? r.account] ?? 0n) + r.debit - r.credit;
  return net;
}

test("a JV posts as entered; an unbalanced one (or one line, or AR without the customer) is refused and nothing is saved", async () => {
  const c = await createCustomer(owner, customerInput("JV Balance Customer"));
  const count = async () => (await db.select().from(adjustments)).length;
  const before = await count();
  await expect(createAdjustment(owner, jv([{ accountId: ids.capital, debit: "1,000" }, { accountId: ids.cash, credit: "999.99" }]))).rejects.toThrow(
    "Debits ₹1,000.00 and credits ₹999.99 don't match: the entry must balance.",
  );
  await expect(createAdjustment(owner, jv([{ accountId: ids.cash, debit: "10" }]))).rejects.toThrow("Enter at least two lines");
  await expect(createAdjustment(owner, jv([{ accountId: ids.cash, debit: "10", credit: "10" }, { accountId: ids.capital, credit: "10" }]))).rejects.toThrow(
    "Line 1: enter a debit or a credit (one of them).",
  );
  await expect(createAdjustment(owner, jv([{ accountId: ids.bad_debts, debit: "10" }, { accountId: ids.ar, credit: "10" }]))).rejects.toThrow(
    "Line 2: an Accounts Receivable line needs the customer.",
  );
  await expect(createAdjustment(owner, jv([{ accountId: ids.cash, debit: "10" }, { accountId: ids.capital, credit: "10" }], "  "))).rejects.toThrow(
    "Say what the entry is for.",
  );
  // D56: stock and GRN clearing belong to stock moves / GRNs.
  for (const key of ["stock", "grn_clearing"]) {
    await expect(createAdjustment(owner, jv([{ accountId: ids[key], debit: "10" }, { accountId: ids.capital, credit: "10" }]))).rejects.toThrow(
      /^Line 1: .+ can't be used in a JV \(use a stock adjustment\)\.$/,
    );
  }
  expect(await count()).toBe(before);

  const { id, message } = await createAdjustment(
    owner,
    jv([{ accountId: ids.bad_debts, debit: "250" }, { accountId: ids.ar, credit: "250", customerId: c }], "Old balance written off"),
  );
  expect(message).toMatch(/^Saved JV\/26-27\/\d{4}\.$/);
  expect(await posted(id!)).toEqual({ bad_debts: 250_00n, ar: -250_00n });
  expect(await arBalance(c)).toBe(-250_00n);
  expect(await getAdjustment(id!)).toMatchObject({ kind: "journal", amountPaise: 250_00n, narration: "Old balance written off", customerId: null });
});

test("a write-off settles the oldest invoice first: its open amount goes down, bad_debts up; the invoice can't be cancelled under it", async () => {
  const c = await createCustomer(owner, customerInput("JV Write-off Customer"));
  const [a, b] = [await invoice(c, "1,000"), await invoice(c, "500")];
  await receipt(c, "950", [[a, "950"]]); // ₹50 left on A
  const badBefore = (await ledger({ account: "bad_debts" })).closing;

  const { id } = await createAdjustment(owner, customerAdjustment("write_off", c, "80", [
    { target: "invoice", id: a, amount: "50" },
    { target: "invoice", id: b, amount: "30" },
  ]));
  expect(await posted(id!)).toEqual({ bad_debts: 80_00n, ar: -80_00n });
  expect((await ledger({ account: "bad_debts" })).closing - badBefore).toBe(80_00n);
  expect([await open(c, a), await open(c, b)]).toEqual([0n, 470_00n]);
  expect((await getInvoice(a))!.payment).toBe("Paid");
  expect(await arBalance(c)).toBe(470_00n);
  await expect(cancelInvoice(owner, a, "")).rejects.toThrow(/^Cancel JV\/26-27\/\d{4} first: it settles part of this invoice\.$/);

  // A settlement discount posts to discount_allowed. The whole amount must be allocated, never over an open amount.
  const { id: d } = await createAdjustment(owner, customerAdjustment("discount", c, "20", [{ target: "invoice", id: b, amount: "20" }]));
  expect(await posted(d!)).toEqual({ discount_allowed: 20_00n, ar: -20_00n });
  await expect(createAdjustment(owner, customerAdjustment("discount", c, "20", [{ target: "invoice", id: b, amount: "15" }]))).rejects.toThrow(
    "Put the whole ₹20.00 on the invoices / debit notes / opening bills it settles: ₹15.00 is allocated.",
  );
  await expect(createAdjustment(owner, customerAdjustment("write_off", c, "500", [{ target: "invoice", id: b, amount: "500" }]))).rejects.toThrow(
    "is more than its open ₹450.00",
  );
});

test("a refund uses up on-account money (receipt rest, credit left) and can't be more than there is", async () => {
  const c = await createCustomer(owner, customerInput("JV Refund Customer"));
  const inv = await invoice(c, "600");
  const { id: r1 } = await receipt(c, "1,000", [[inv, "600"]]); // ₹400 on account
  const { id: r2 } = await receipt(c, "300"); // ₹300 more
  expect(await onAccount(c)).toBe(700_00n);
  const refund = (amount: string, lines: [number, string][]) =>
    customerAdjustment("refund", c, amount, lines.map(([id, a]) => ({ target: "receipt", id, amount: a })), { moneyAccountId: String(ids.bank_1) });

  await expect(createAdjustment(owner, refund("700.01", [[r1!, "400"], [r2!, "300.01"]]))).rejects.toThrow(
    "₹700.01 is more than the ₹700.00 JV Refund Customer has on account.",
  );
  await expect(createAdjustment(owner, refund("500", [[r1!, "500"]]))).rejects.toThrow("₹500.00 is more than the ₹400.00 it has on account.");

  const cashBefore = (await ledger({ account: "bank_1" })).closing;
  const { id } = await createAdjustment(owner, refund("500", [[r1!, "400"], [r2!, "100"]]));
  expect(await posted(id!)).toEqual({ ar: 500_00n, bank_1: -500_00n });
  expect((await ledger({ account: "bank_1" })).closing - cashBefore).toBe(-500_00n);
  expect(await onAccount(c)).toBe(200_00n);
  expect(await arBalance(c)).toBe(-200_00n); // what is still on account
  expect((await getReceipt(r1!))!).toMatchObject({ onAccount: 0n });
  expect((await getReceipt(r1!))!.lines.at(-1)).toMatchObject({ refundId: id, amount: 400_00n });
  await expect(createAdjustment(owner, refund("200.01", [[r2!, "200.01"]]))).rejects.toThrow("is more than the ₹200.00");
  // Customer history: money paid back pays nothing in a chain (no stray card).
  const chains = await customerHistory(c);
  expect(chains.map((ch) => ch.key)).toEqual([`i${inv}`]);
  expect(chains[0].payments).toEqual([expect.objectContaining({ receiptId: r1, amount: 600_00n })]);
  // The receipt it paid back can't be cancelled (or edited) under it.
  await expect(cancelReceipt(owner, r1!, "")).rejects.toThrow(/^Cancel JV\/26-27\/\d{4} first: it paid back part of this receipt\.$/);

  // Cancel: the money is on account again and the receipt can go.
  await cancelAdjustment(owner, id!, "Refund not paid");
  expect(await onAccount(c)).toBe(700_00n);
  expect(await arBalance(c)).toBe(-700_00n);
  expect((await cancelReceipt(owner, r2!, "")).message).toMatch(/^Cancelled RC\//);
});

test("a credit note's leftover credit can be refunded; the note can't be cancelled under the refund", async () => {
  const c = await createCustomer(owner, customerInput("JV Credit Refund Customer"));
  const inv = await invoice(c, "600");
  await receipt(c, "600", [[inv, "600"]]); // paid in full, so the whole note is left as credit
  const [line] = await invoiceLinesLeft(db, "credit", inv);
  const note = await createNote(owner, "credit", inv, {
    date: formatDate(today),
    reason: "Rate reduced",
    notes: "",
    lines: JSON.stringify([{ invoiceLineId: String(line.id), qty: "1", amount: "200" }]),
  });
  await issueNote(owner, "credit", note);
  expect(await onAccount(c)).toBe(200_00n);

  const { id } = await createAdjustment(
    owner,
    customerAdjustment("refund", c, "150", [{ target: "credit_note", id: note, amount: "150" }], { moneyAccountId: String(ids.cash) }),
  );
  expect(await posted(id!)).toEqual({ ar: 150_00n, cash: -150_00n });
  expect(await onAccount(c)).toBe(50_00n);
  await expect(cancelNote(owner, "credit", note, "")).rejects.toThrow(/^Cancel JV\/26-27\/\d{4} first: it paid back part of this note's credit\.$/);
});

test("customer history puts a debit note's payment in its invoice's chain", async () => {
  const c = await createCustomer(owner, customerInput("JV History Customer"));
  const inv = await invoice(c, "500");
  const [line] = await invoiceLinesLeft(db, "debit", inv);
  const note = await createNote(owner, "debit", inv, { date: formatDate(today), reason: "Extra fitting", notes: "", lines: JSON.stringify([{ invoiceLineId: String(line.id), qty: "1", amount: "100" }]) });
  await issueNote(owner, "debit", note);
  const { id: paid } = await createReceipt(owner, {
    customerId: String(c), date: formatDate(today), amount: "100", mode: "cash", moneyAccountId: String(ids.cash), reference: "", chequeNo: "",
    chequeDate: "", receivedBy: "", notes: "", allocations: JSON.stringify([{ target: "debit_note", id: String(note), amount: "100" }]),
  });
  const chains = await customerHistory(c);
  expect(chains.map((ch) => ch.key)).toEqual([`i${inv}`]);
  expect(chains[0].payments).toEqual([expect.objectContaining({ receiptId: paid, amount: 100_00n })]);
});

test("an accountant's JV waits for the owner: nothing is numbered or posted until it is approved", async () => {
  const c = await createCustomer(owner, customerInput("JV Approval Customer"));
  const inv = await invoice(c, "1,200");
  const entries = async () => (await db.select().from(journalEntries).where(eq(journalEntries.docType, "adjustments"))).length;
  const [before, rows] = [await entries(), (await db.select().from(adjustments)).length];

  expect(await createAdjustment(accountant, customerAdjustment("write_off", c, "200", [{ target: "invoice", id: inv, amount: "200" }]))).toEqual({
    id: null,
    message: SENT_FOR_APPROVAL,
  });
  expect(await createAdjustment(accountant, jv([{ accountId: ids.cash, debit: "5" }, { accountId: ids.cash_short_excess, credit: "5" }]))).toEqual({
    id: null,
    message: SENT_FOR_APPROVAL,
  });
  expect([await entries(), (await db.select().from(adjustments)).length, await open(c, inv)]).toEqual([before, rows, 1200_00n]);

  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, "adjustment.create"), eq(approvalRequests.requestedBy, accountant.id)))
    .orderBy(asc(approvalRequests.id));
  expect(request.summary).toBe(`Write-off ₹200.00 · JV Approval Customer, dated ${formatDate(today)}`);
  expect(request.changes).toContainEqual({ label: "Entry", old: null, new: "Dr Bad Debts ₹200.00\nCr Accounts Receivable (JV Approval Customer) ₹200.00" });
  await approve(owner, request.id, "");
  expect(await open(c, inv)).toBe(1000_00n);
  expect(await entries()).toBe(before + 1);
  const [made] = await db.select().from(adjustments).where(eq(adjustments.customerId, c));
  expect(made.createdBy).toBe(owner.id); // the owner's approval did it (A§7)

  // The accountant's cancel waits too.
  expect(await cancelAdjustment(accountant, made.id, "Wrong customer")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await getAdjustment(made.id))!.status).toBe("active");
});

test("cancel reverses the JV on its own date and the invoice's open amount comes back; the reversal trail stays", async () => {
  const c = await createCustomer(owner, customerInput("JV Cancel Customer"));
  const inv = await invoice(c, "900");
  const { id } = await createAdjustment(owner, customerAdjustment("discount", c, "90", [{ target: "invoice", id: inv, amount: "90" }]));
  expect(await open(c, inv)).toBe(810_00n);
  expect((await cancelAdjustment(owner, id!, "Discount not agreed")).message).toMatch(/^Cancelled JV\/26-27\/\d{4}; its entry is reversed\.$/);
  expect(await open(c, inv)).toBe(900_00n);
  expect(await posted(id!)).toEqual({ discount_allowed: 0n, ar: 0n });
  const trail = await db.select().from(journalEntries).where(and(eq(journalEntries.docType, "adjustments"), eq(journalEntries.docId, id!))).orderBy(asc(journalEntries.id));
  expect(trail.map((e) => [e.date, e.reversesEntryId !== null])).toEqual([[today, false], [today, true]]);
  const got = (await getAdjustment(id!))!;
  expect(got.status).toBe("cancelled");
  expect(got.allocated.map((a) => [a.number, a.active])).toEqual([[(await getInvoice(inv))!.number, false]]);
  await expect(cancelAdjustment(owner, id!, "")).rejects.toThrow("This JV is already cancelled.");
  // Nothing stands against the invoice any more.
  expect((await cancelInvoice(owner, inv, "")).message).toMatch(/Cancelled/);
});

test("the DB refuses an unbalanced entry even without the JV form", async () => {
  await expect(
    writeTx(owner, (tx) =>
      post(tx, { date: today, docType: "adjustments", docId: 0, lines: [{ account: "cash", debit: 100n }, { account: "capital", credit: 99n }] }),
    ),
  ).rejects.toThrow("Unbalanced entry");
});
