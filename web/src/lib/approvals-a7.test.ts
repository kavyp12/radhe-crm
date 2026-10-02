import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import {
  accounts,
  adjustments,
  approvalRequests,
  creditNotes,
  expenseCategories,
  invoices,
  journalEntries,
  purchaseBills,
  quotations,
  receipts,
  settings,
  stockMoves,
  vendorPayments,
} from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createAdjustment } from "@/lib/adjustments";
import { SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, issueInvoice } from "@/lib/invoices";
import type { LineText } from "@/lib/lines";
import { createNote, invoiceLinesLeft, issueNote } from "@/lib/notes";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill } from "@/lib/purchase-bills";
import { createQuotation, sendQuotation } from "@/lib/quotations";
import { cancelReceipt, createReceipt, updateReceipt, type ReceiptInput } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createItem, createStockAdjustment } from "@/lib/stock";
import { createUser } from "@/lib/users";
import { cancelVendorPayment, createVendorPayment, updateVendorPayment, type VendorPaymentInput } from "@/lib/vendor-payments";
import { createVendor } from "@/lib/vendors";

// T42 (A§7, S22, D67): every case that needs the owner's approval — invoice cancel, receipt edit / cancel, vendor
// payment edit / cancel, purchase bill cancel, discount over the limit (quotation Send, invoice Issue), credit note
// issue, a backdated document, a customer adjustment JV, a stock adjustment. A non-owner gets a pending request and
// nothing changes (no journal entry, the document as it was); the owner's own action is done at once.

let owner: SessionUser;
let accountant: SessionUser;
let sales: SessionUser;
let saved: { discountLimitBp: number | null; backdateDays: number | null };
const ids: Record<string, number> = {};
const today = todayIST();
const t = formatDate(today);

beforeAll(async () => {
  owner = await testOwner();
  const user = async (username: string, role: Role) => {
    const u = { name: username, username, role, canViewCost: role !== "sales" };
    return { ...u, id: await createUser(owner, { ...u, password: `${username}-pass-1` }) };
  };
  accountant = await user("a7.acct", "accountant");
  sales = await user("a7.sales", "sales");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const [s] = await db.select().from(settings);
  saved = { discountLimitBp: s.discountLimitBp, backdateDays: s.backdateDays };
  await writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp: 500, backdateDays: 3 }).where(eq(settings.id, s.id)));
  for (const a of await db.select().from(accounts)) if (a.systemKey) ids[a.systemKey] = a.id;
  ids.category = (await db.query.productCategories.findFirst())!.id;
  ids.customer = await createCustomer(owner, {
    name: "A7 Approval Signs", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  ids.vendor = await createVendor(owner, { name: "A7 Transport Co", gstin: "", stateCode: "24", mobile: "", address: "", creditDays: "", notes: "" });
});

afterAll(async () => {
  await writeTx(owner, (tx) => tx.update(settings).set(saved));
});

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
const entries = async () => (await db.select({ n: count() }).from(journalEntries))[0].n;
const pending = async (type: string) =>
  (await db.select({ n: count() }).from(approvalRequests).where(and(eq(approvalRequests.type, type), eq(approvalRequests.status, "pending"))))[0].n;

/**
 * The A§7 check: `asked` by a non-owner → one more pending request of `type`, no journal entry, `state` unchanged;
 * then `done` by the owner → no new request and `state` changes.
 */
async function gated(type: string, asked: () => Promise<unknown>, done: () => Promise<unknown>, state: () => Promise<unknown>) {
  const before = { requests: await pending(type), entries: await entries(), state: json(await state()) };
  expect(json(await asked())).toContain(SENT_FOR_APPROVAL);
  expect(await pending(type)).toBe(before.requests + 1);
  expect(await entries()).toBe(before.entries);
  expect(json(await state())).toBe(before.state);

  expect(json(await done())).not.toContain(SENT_FOR_APPROVAL);
  expect(await pending(type)).toBe(before.requests + 1);
  expect(json(await state())).not.toBe(before.state);
}

const line = (rate: string, discount = ""): LineText => ({
  lineId: "", categoryId: String(ids.category), description: "Board", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate, discount, gst: "0",
});
async function issued(rupees: string) {
  const id = await createInvoice(owner, { kind: "tax", customerId: String(ids.customer), date: t, terms: "", notes: "", lines: JSON.stringify([line(rupees)]) });
  await issueInvoice(owner, id);
  return id;
}
const row = async <T,>(rows: Promise<T[]>) => (await rows)[0];
const receipt = (amount: string, date = t): ReceiptInput => ({
  customerId: String(ids.customer), date, amount, mode: "cash", moneyAccountId: String(ids.cash), reference: "", chequeNo: "", chequeDate: "",
  receivedBy: "", notes: "", allocations: "[]",
});
const payment = (amount: string): VendorPaymentInput => ({
  vendorId: String(ids.vendor), date: t, amount, mode: "cash", moneyAccountId: String(ids.cash), reference: "", chequeNo: "", chequeDate: "", notes: "", allocations: "[]",
});

test("invoice cancel", async () => {
  const id = await issued("1000");
  const state = () => row(db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id)));
  await gated("invoice.cancel", () => cancelInvoice(accountant, id, "wrong customer"), () => cancelInvoice(owner, id, "wrong customer"), state);
  expect((await state()).status).toBe("cancelled");
});

test("receipt edit and cancel", async () => {
  const id = (await createReceipt(owner, receipt("500"))).id!;
  const state = () => row(db.select({ amount: receipts.amountPaise, status: receipts.status }).from(receipts).where(eq(receipts.id, id)));
  await gated("receipt.edit", () => updateReceipt(accountant, id, receipt("450"), "typo"), () => updateReceipt(owner, id, receipt("450"), "typo"), state);
  expect((await state()).amount).toBe(450_00n);
  await gated("receipt.cancel", () => cancelReceipt(accountant, id, "bounced"), () => cancelReceipt(owner, id, "bounced"), state);
  expect((await state()).status).toBe("cancelled");
});

test("vendor payment edit and cancel", async () => {
  const id = (await createVendorPayment(owner, payment("300"))).id!;
  const state = () => row(db.select({ amount: vendorPayments.amountPaise, status: vendorPayments.status }).from(vendorPayments).where(eq(vendorPayments.id, id)));
  await gated("vendor_payment.edit", () => updateVendorPayment(accountant, id, payment("350"), "typo"), () => updateVendorPayment(owner, id, payment("350"), "typo"), state);
  expect((await state()).amount).toBe(350_00n);
  await gated("vendor_payment.cancel", () => cancelVendorPayment(accountant, id, "duplicate"), () => cancelVendorPayment(owner, id, "duplicate"), state);
  expect((await state()).status).toBe("cancelled");
});

test("purchase bill cancel", async () => {
  const [transport] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Transport"));
  const { id } = await createPurchaseBill(owner, {
    vendorId: String(ids.vendor), vendorBillNo: "A7-1", date: t, roundOff: "", notes: "",
    lines: JSON.stringify([{ what: `cat:${transport.id}`, description: "Tempo", qty: "1", rate: "800", gst: "0", jobId: "" }]),
  });
  const state = () => row(db.select({ status: purchaseBills.status }).from(purchaseBills).where(eq(purchaseBills.id, id!)));
  await gated("purchase_bill.cancel", () => cancelPurchaseBill(accountant, id!, "wrong vendor"), () => cancelPurchaseBill(owner, id!, "wrong vendor"), state);
  expect((await state()).status).toBe("cancelled");
});

test("discount above the limit: quotation Send and invoice Issue", async () => {
  const q = await createQuotation(sales, { customerId: String(ids.customer), date: t, terms: "", notes: "", lines: JSON.stringify([line("1000", "100")]) }); // 10% > 5%
  const qState = () => row(db.select({ status: quotations.status }).from(quotations).where(eq(quotations.id, q)));
  await gated("quotation.send", () => sendQuotation(sales, q), () => sendQuotation(owner, q), qState);
  expect((await qState()).status).toBe("sent");

  const inv = await createInvoice(accountant, { kind: "tax", customerId: String(ids.customer), date: t, terms: "", notes: "", lines: JSON.stringify([line("1000", "100")]) });
  const iState = () => row(db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv)));
  await gated("invoice.issue", () => issueInvoice(accountant, inv), () => issueInvoice(owner, inv), iState);
  expect((await iState()).status).toBe("issued");
});

test("credit note issue", async () => {
  const inv = await issued("2000");
  const [l] = await invoiceLinesLeft(db, "credit", inv);
  const note = await createNote(accountant, "credit", inv, { date: t, reason: "Returned", notes: "", lines: JSON.stringify([{ invoiceLineId: String(l.id), qty: "", amount: "200" }]) });
  const state = () => row(db.select({ status: creditNotes.status }).from(creditNotes).where(eq(creditNotes.id, note)));
  await gated("credit_note.issue", () => issueNote(accountant, "credit", note), () => issueNote(owner, "credit", note), state);
  expect((await state()).status).toBe("issued");
});

test("a document dated before the backdate window", async () => {
  const old = formatDate(addDays(today, -10)); // backdate window 3 days
  const state = () => db.select({ id: receipts.id }).from(receipts).where(and(eq(receipts.customerId, ids.customer), eq(receipts.date, addDays(today, -10))));
  await gated("receipt.create", () => createReceipt(accountant, receipt("100", old)), () => createReceipt(owner, receipt("100", old)), state);
  expect(await state()).toHaveLength(1);
  // Inside the window: no approval.
  expect((await createReceipt(accountant, receipt("100", formatDate(addDays(today, -2))))).id).not.toBeNull();
});

test("customer outstanding adjustment (JV touching a customer)", async () => {
  const inv = await issued("700");
  const input = {
    kind: "write_off", date: t, narration: "", lines: "[]", customerId: String(ids.customer), amount: "70", moneyAccountId: "",
    allocations: JSON.stringify([{ target: "invoice", id: String(inv), amount: "70" }]),
  };
  const state = () => db.select({ id: adjustments.id }).from(adjustments).where(eq(adjustments.customerId, ids.customer));
  await gated("adjustment.create", () => createAdjustment(accountant, input), () => createAdjustment(owner, input), state);
  expect(await state()).toHaveLength(1);
});

test("stock adjustment", async () => {
  const [acrylic] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic"));
  const item = await createItem(owner, { name: "A7 Acrylic 3mm", unit: "Sheet", categoryId: String(acrylic.id), hsnSac: "", gstPercent: "18" });
  const input = { itemId: String(item), date: t, qty: "5", rate: "100", reason: "Found in store" };
  const state = () => db.select({ id: stockMoves.id }).from(stockMoves).where(eq(stockMoves.itemId, item));
  await gated("stock_adjustment.create", () => createStockAdjustment(accountant, input), () => createStockAdjustment(owner, input), state);
  expect(await state()).toHaveLength(1);
});
