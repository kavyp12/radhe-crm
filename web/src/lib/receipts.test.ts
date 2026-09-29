import { and, asc, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, allocations, approvalRequests, journalEntries, journalLines, receipts } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { openInvoices, paymentStatus } from "@/lib/allocations";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { fifo } from "@/lib/fifo";
import { cancelInvoice, createInvoice, getInvoice, issueInvoice } from "@/lib/invoices";
import { ledger } from "@/lib/ledger";
import type { LineText } from "@/lib/lines";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelReceipt, createReceipt, getReceipt, updateReceipt, type ReceiptInput } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let accountant: SessionUser;
let categoryId: string;
let cashId: number;
let bankId: number;
const today = todayIST();
const shown = (iso: string) => formatDate(iso);

const customer = (name: string, creditDays = ""): CustomerInput => ({
  name,
  firmName: "",
  mobile: "",
  email: "",
  gstin: "",
  stateCode: "24",
  billingAddress: "",
  siteAddress: "",
  creditLimit: "",
  creditDays,
  isCreditCustomer: false,
  salesPersonId: "",
  collectionPersonId: "",
  notes: "",
});

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role) => {
    const user = { name: `Receipt ${role}`, username: `rc.${role}`, role, canViewCost: true };
    return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
  };
  accountant = await staff("accountant");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  const money = await db.select().from(accounts).where(eq(accounts.isMoney, true));
  cashId = money.find((a) => a.systemKey === "cash")!.id;
  bankId = money.find((a) => a.systemKey === "bank_1")!.id;
});

/** An issued tax invoice for `rupees` in total (GST 0 so the total is exact). */
async function invoice(customerId: number, rupees: string, date = today) {
  const line: LineText = {
    lineId: "",
    categoryId,
    description: "Board",
    hsnSac: "",
    width: "",
    height: "",
    qty: "1",
    unit: "Nos",
    rate: rupees,
    discount: "",
    gst: "0",
  };
  const id = await createInvoice(owner, {
    kind: "tax",
    customerId: String(customerId),
    date: shown(date),
    terms: "",
    notes: "",
    lines: JSON.stringify([line]),
  });
  await issueInvoice(owner, id);
  return id;
}

const receipt = (customerId: number, amount: string, lines: [number, string][] = [], patch: Partial<ReceiptInput> = {}) => ({
  customerId: String(customerId),
  date: shown(today),
  amount,
  mode: "cash",
  moneyAccountId: String(cashId),
  reference: "",
  chequeNo: "",
  chequeDate: "",
  receivedBy: "",
  notes: "",
  allocations: JSON.stringify(lines.map(([id, a]) => ({ target: "invoice", id: String(id), amount: a }))),
  ...patch,
});

const arBalance = async (customerId: number) => (await ledger({ account: "ar", customerId })).closing;
const status = async (id: number) => (await getInvoice(id))!.payment;

/** The receipt's journal lines, net per account (+Dr / −Cr), and all its entries. */
async function posted(receiptId: number) {
  const rows = await db
    .select({ entry: journalEntries.id, date: journalEntries.date, reverses: journalEntries.reversesEntryId, account: journalLines.accountId, customerId: journalLines.customerId, debit: journalLines.debitPaise, credit: journalLines.creditPaise })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.docType, "receipts"), eq(journalEntries.docId, receiptId)))
    .orderBy(asc(journalLines.id));
  const net = new Map<number, bigint>();
  for (const r of rows) net.set(r.account, (net.get(r.account) ?? 0n) + r.debit - r.credit);
  return { rows, net };
}

test("S6: ₹50,000 received → invoice A ₹20,000 + invoice B ₹25,000 + ₹5,000 advance on account", async () => {
  const c = await createCustomer(owner, customer("S6 Traders"));
  const a = await invoice(c, "20,000");
  const b = await invoice(c, "25,000");
  const open = await openInvoices(db, c);
  expect(open.map((i) => [i.id, i.open])).toEqual([
    [a, 20000_00n],
    [b, 25000_00n],
  ]);
  // The form's FIFO fill: oldest first, the rest stays on account.
  expect(fifo(50000_00n, open.map((i) => i.open))).toEqual([20000_00n, 25000_00n]);

  const { id, message } = await createReceipt(owner, receipt(c, "50,000", [[a, "20,000"], [b, "25,000"]]));
  expect(message).toMatch(/^Saved RC\/26-27\/\d{4}\.$/);
  const r = (await getReceipt(id!))!;
  expect(r).toMatchObject({ amountPaise: 50000_00n, allocated: 45000_00n, onAccount: 5000_00n, status: "active" });
  expect(r.number).toMatch(/^RC\/26-27\/\d{4}$/);
  // Dr cash / Cr AR (customer), on the receipt date, with the receipt's number.
  const { rows, net } = await posted(id!);
  expect([...net]).toEqual([
    [cashId, 50000_00n],
    [(await db.query.accounts.findFirst({ where: eq(accounts.systemKey, "ar") }))!.id, -50000_00n],
  ]);
  expect(rows.find((l) => l.credit > 0n)?.customerId).toBe(c);
  expect(await status(a)).toBe("Paid");
  expect(await status(b)).toBe("Paid");
  expect(await openInvoices(db, c)).toEqual([]);
  expect(await arBalance(c)).toBe(-5000_00n); // ₹45,000 billed − ₹50,000 received = ₹5,000 advance (Cr)
});

test("over-allocation is blocked: more than the receipt, or more than an invoice's open amount", async () => {
  const c = await createCustomer(owner, customer("Over Allocation"));
  const a = await invoice(c, "10,000");
  const b = await invoice(c, "10,000");
  await expect(createReceipt(owner, receipt(c, "15,000", [[a, "10,000"], [b, "6,000"]]))).rejects.toThrow(
    "₹16,000.00 allocated is more than the ₹15,000.00 received",
  );
  await expect(createReceipt(owner, receipt(c, "15,000", [[a, "12,000"]]))).rejects.toThrow("is more than its open ₹10,000.00");
  await createReceipt(owner, receipt(c, "4,000", [[a, "4,000"]]));
  // Another receipt can only take what is left open.
  await expect(createReceipt(owner, receipt(c, "7,000", [[a, "7,000"]]))).rejects.toThrow("is more than its open ₹6,000.00");
  // Another customer's invoice can't be paid from this receipt.
  const other = await createCustomer(owner, customer("Someone Else"));
  await expect(createReceipt(owner, receipt(other, "1,000", [[a, "1,000"]]))).rejects.toThrow("isn't this customer's");
  // Nothing was saved by the refused attempts.
  expect((await openInvoices(db, c)).map((i) => i.open)).toEqual([6000_00n, 10000_00n]);
});

test("status is computed: Unpaid → Part Payment → Paid; Overdue once past the due date", async () => {
  const c = await createCustomer(owner, customer("Status Steps", "15"));
  const id = await invoice(c, "30,000");
  expect(await status(id)).toBe("Unpaid");
  await createReceipt(owner, receipt(c, "10,000", [[id, "10,000"]]));
  expect(await status(id)).toBe("Part Payment");
  expect((await getInvoice(id))!.open).toBe(20000_00n);
  await createReceipt(owner, receipt(c, "20,000", [[id, "20,000"]]));
  expect(await status(id)).toBe("Paid");

  // Dated 40 days ago with 15 credit days → due 25 days ago: Overdue, unpaid or part paid.
  const old = await invoice(c, "8,000", addDays(today, -40));
  expect((await getInvoice(old))!.dueDate).toBe(addDays(today, -25));
  expect(await status(old)).toBe("Overdue");
  await createReceipt(owner, receipt(c, "3,000", [[old, "3,000"]]));
  expect(await status(old)).toBe("Overdue");
  await createReceipt(owner, receipt(c, "5,000", [[old, "5,000"]]));
  expect(await status(old)).toBe("Paid");

  // The due date itself is not overdue yet; the day after is (A§5: due_date < today).
  const doc = { status: "issued", totalPaise: 100n, dueDate: "2026-10-15" };
  expect(paymentStatus(doc, 100n, "2026-10-15")).toBe("Unpaid");
  expect(paymentStatus(doc, 100n, "2026-10-16")).toBe("Overdue");
  expect(paymentStatus({ ...doc, status: "draft" }, 100n)).toBeNull();
  expect(paymentStatus({ ...doc, status: "cancelled" }, 100n)).toBe("Cancelled");
});

test("a cancel reverses the entry on the receipt date and reopens its invoices; rows are kept, never deleted", async () => {
  const c = await createCustomer(owner, customer("Cancel Me"));
  const a = await invoice(c, "12,000");
  const { id } = await createReceipt(owner, receipt(c, "12,000", [[a, "12,000"]], { mode: "bank", moneyAccountId: String(bankId) }));
  expect(await status(a)).toBe("Paid");
  expect(await arBalance(c)).toBe(0n);

  expect((await cancelReceipt(owner, id!, "Bounced")).message).toMatch(/^Cancelled RC\/.+; its entry is reversed\.$/);
  expect(await status(a)).toBe("Unpaid");
  expect((await getInvoice(a))!.open).toBe(12000_00n);
  expect(await arBalance(c)).toBe(12000_00n);
  const { rows, net } = await posted(id!);
  expect([...net.values()].every((v) => v === 0n)).toBe(true);
  expect(rows.filter((r) => r.reverses !== null).every((r) => r.date === today)).toBe(true);
  // The allocation row stays, inactive; the DB refuses to delete it.
  const kept = await db.select().from(allocations).where(eq(allocations.receiptId, id!));
  expect(kept.map((k) => k.active)).toEqual([false]);
  await expect(db.delete(allocations).where(eq(allocations.receiptId, id!))).rejects.toThrow();
  await expect(cancelReceipt(owner, id!, "")).rejects.toThrow("already cancelled");
});

test("a non-owner's cancel, edit and backdated receipt go to the owner; nothing changes until approved", async () => {
  const c = await createCustomer(owner, customer("Needs Approval"));
  const a = await invoice(c, "9,000");
  const { id } = await createReceipt(accountant, receipt(c, "5,000", [[a, "5,000"]]));
  const pending = async (type: string) =>
    (await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, type), eq(approvalRequests.status, "pending")))).at(-1)!;

  // Edit: ₹5,000 → ₹9,000, all to the invoice.
  const edit = receipt(c, "9,000", [[a, "9,000"]]);
  expect((await updateReceipt(accountant, id!, edit, "Customer paid the rest in the same cheque")).message).toBe(SENT_FOR_APPROVAL);
  expect((await getReceipt(id!))!.amountPaise).toBe(5000_00n);
  expect(await status(a)).toBe("Part Payment");
  await approve(owner, (await pending("receipt.edit")).id, "ok");
  expect((await getReceipt(id!))!).toMatchObject({ amountPaise: 9000_00n, allocated: 9000_00n });
  expect(await status(a)).toBe("Paid");
  // Reverse + repost: the original, its reversal and the new entry, netting to the new amount.
  const { rows, net } = await posted(id!);
  expect(new Set(rows.map((r) => r.entry)).size).toBe(3);
  expect(net.get(cashId)).toBe(9000_00n);

  // Cancel by the accountant: a request; nothing reversed yet.
  expect((await cancelReceipt(accountant, id!, "Duplicate")).message).toBe(SENT_FOR_APPROVAL);
  expect((await getReceipt(id!))!.status).toBe("active");
  await approve(owner, (await pending("receipt.cancel")).id, "");
  expect((await getReceipt(id!))!.status).toBe("cancelled");
  expect(await status(a)).toBe("Unpaid");

  // A date before the backdate window (none set = before today, D39): no receipt until approved, then numbered.
  const before = (await db.select({ n: sql<number>`count(*)::int` }).from(receipts))[0].n;
  const backdated = receipt(c, "2,000", [[a, "2,000"]], { date: shown(addDays(today, -3)) });
  expect(await createReceipt(accountant, backdated)).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  expect((await db.select({ n: sql<number>`count(*)::int` }).from(receipts))[0].n).toBe(before);
  await approve(owner, (await pending("receipt.create")).id, "");
  const [made] = await db.select().from(receipts).where(eq(receipts.customerId, c)).orderBy(sql`id desc`).limit(1);
  expect(made).toMatchObject({ date: addDays(today, -3), amountPaise: 2000_00n, status: "active" });
  expect(await status(a)).toBe("Part Payment");
  // The owner's own backdated receipt needs nobody.
  expect((await createReceipt(owner, receipt(c, "1,000", [], { date: shown(addDays(today, -3)) }))).id).not.toBeNull();
});

test("cancelling an invoice puts the money allocated to it back on account", async () => {
  const c = await createCustomer(owner, customer("Invoice Cancelled"));
  const a = await invoice(c, "6,000");
  const { id } = await createReceipt(owner, receipt(c, "6,000", [[a, "6,000"]]));
  expect((await getReceipt(id!))!.onAccount).toBe(0n);
  await cancelInvoice(owner, a, "Wrong rate");
  expect((await getReceipt(id!))!).toMatchObject({ allocated: 0n, onAccount: 6000_00n });
  expect(await arBalance(c)).toBe(-6000_00n);
});

test("a cheque needs its number; the money account must be a money account", async () => {
  const c = await createCustomer(owner, customer("Cheque Payer"));
  await expect(createReceipt(owner, receipt(c, "500", [], { mode: "cheque", moneyAccountId: String(bankId) }))).rejects.toMatchObject({
    field: "chequeNo",
  });
  const ar = (await db.query.accounts.findFirst({ where: eq(accounts.systemKey, "ar") }))!.id;
  await expect(createReceipt(owner, receipt(c, "500", [], { moneyAccountId: String(ar) }))).rejects.toMatchObject({
    field: "moneyAccountId",
  });
  const { id } = await createReceipt(
    owner,
    receipt(c, "500", [], { mode: "cheque", moneyAccountId: String(bankId), chequeNo: "004512", chequeDate: "30/09/2026" }),
  );
  expect((await getReceipt(id!))!).toMatchObject({ chequeNo: "004512", chequeDate: "2026-09-30", onAccount: 500_00n });
});
