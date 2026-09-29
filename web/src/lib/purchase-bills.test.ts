import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, approvalRequests, expenseCategories, journalEntries, journalLines, purchaseBills, stockMoves } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { createCustomer } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { gstinCheckChar } from "@/lib/gstin";
import { createJob } from "@/lib/jobs";
import { ledger } from "@/lib/ledger";
import type { Role, SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill, getPurchaseBill, updatePurchaseBill, type BillInput } from "@/lib/purchase-bills";
import type { PurchaseLineText } from "@/lib/purchase-lines";
import { saveBooks } from "@/lib/settings";
import { createItem, createStockAdjustment, getItem } from "@/lib/stock";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T18 (S9, A§3, D51): posting (stock line, expense line with a job, CGST + SGST vs IGST, round-off), stock in at
// taxable, duplicate vendor bill no, cancel = reverse entry + stock (refused below zero), edit = reverse + repost.

let owner: SessionUser;
let accountant: SessionUser;
let noCost: SessionUser;
let local: number; // Gujarat, registered → CGST + SGST
let outside: number; // Maharashtra → IGST
let unregistered: number;
let transport: { id: number; accountId: number };
let jobId: number;
const today = todayIST();
const withCheck = (first14: string) => first14 + gstinCheckChar(first14);

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role, username: string, canViewCost: boolean) => {
    const user = { name: `PB ${username}`, username: `pb.${username}`, role, canViewCost };
    return { ...user, id: await createUser(owner, { ...user, password: `${username}-pass-123` }) };
  };
  accountant = await staff("accountant", "accountant", true);
  noCost = await staff("accountant", "nocost", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const vendor = (name: string, gstin: string, stateCode: string, creditDays = "") =>
    createVendor(owner, { name, gstin, stateCode, mobile: "", address: "", creditDays, notes: "" });
  local = await vendor("Shree Acrylic House", withCheck("24AAAPS1234Q1Z"), "24", "15");
  outside = await vendor("Mumbai LED Traders", withCheck("27AAAPM1234Q1Z"), "27");
  unregistered = await vendor("Ramesh Welding", "", "24");
  const [t] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Transport"));
  transport = { id: t.id, accountId: t.accountId };
  const customer = await createCustomer(owner, {
    name: "PB Job Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const categoryId = String((await db.query.productCategories.findFirst())!.id);
  jobId = await createJob(owner, {
    customerId: String(customer), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId, description: "", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "5000", discount: "", gst: "0" }]),
  });
});

const acrylic = async (name: string) => {
  const [c] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic"));
  return createItem(owner, { name, unit: "Sheet", categoryId: String(c.id), hsnSac: "3920", gstPercent: "18" });
};
const itemLine = (itemId: number, qty: string, rate: string, gst = "18"): PurchaseLineText => ({ what: `item:${itemId}`, description: "", qty, rate, gst, jobId: "" });
const expenseLine = (qty: string, rate: string, gst: string, job = ""): PurchaseLineText => ({ what: `cat:${transport.id}`, description: "Tempo to site", qty, rate, gst, jobId: job });
const bill = (vendorId: number, no: string, lines: PurchaseLineText[], patch: Partial<BillInput> = {}): BillInput => ({
  vendorId: String(vendorId),
  vendorBillNo: no,
  date: formatDate(today),
  roundOff: "",
  notes: "",
  lines: JSON.stringify(lines),
  ...patch,
});
const save = async (actor: SessionUser, input: BillInput) => {
  const { id } = await createPurchaseBill(actor, input);
  return id!;
};

/** The bill's journal, net per account (+Dr / −Cr): system key, or the account id for expense accounts. */
async function posted(id: number) {
  const rows = await db
    .select({ key: accounts.systemKey, account: accounts.id, debit: journalLines.debitPaise, credit: journalLines.creditPaise, vendorId: journalLines.vendorId, jobId: journalLines.jobId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, "purchase_bills"), eq(journalEntries.docId, id)))
    .orderBy(asc(journalLines.id));
  const net: Record<string, bigint> = {};
  for (const r of rows) {
    const k = r.key ?? `account ${r.account}`;
    net[k] = (net[k] ?? 0n) + r.debit - r.credit;
  }
  return { rows, net };
}
const stockOf = async (itemId: number) => {
  const i = (await getItem(owner, itemId))!;
  return [i.qty, i.cost!.value, i.cost!.average];
};

test("same state: Dr stock + the expense account (with its job) + CGST / SGST, round-off, Cr AP; stock in at taxable", async () => {
  const item = await acrylic("PB acrylic 3mm");
  // 10 sheets @ ₹100 at 18% + transport ₹333.33 at 5% for the job: ₹1,000 + ₹180 + ₹333.33 + ₹16.66 = ₹1,529.99 → round-off +₹0.01.
  const id = await save(owner, bill(local, "SAH/101", [itemLine(item, "10", "100"), expenseLine("1", "333.33", "5", String(jobId))]));
  const b = (await getPurchaseBill(id))!;
  expect(b).toMatchObject({ totalPaise: 1530_00n, roundOffPaise: 1n, dueDate: addDays(today, 15), mode: "same_state" });
  expect(b.number).toMatch(/^PB\/26-27\/\d{4}$/);
  const { rows, net } = await posted(id);
  expect(net).toEqual({
    stock: 1000_00n,
    [`account ${transport.accountId}`]: 333_33n,
    gst_in_cgst: 98_33n,
    gst_in_sgst: 98_33n,
    round_off: 1n,
    ap: -1530_00n,
  });
  expect(rows.find((r) => r.key === "ap")!.vendorId).toBe(local);
  expect(rows.find((r) => r.account === transport.accountId)!.jobId).toBe(jobId);
  expect((await ledger({ jobId })).rows.map((r) => r.debit)).toEqual([333_33n]);
  expect(await stockOf(item)).toEqual([10_000n, 1000_00n, 100_00n]);

  // A second bill at another rate: the average moves (D20).
  await save(owner, bill(local, "SAH/102", [itemLine(item, "10", "120")]));
  expect(await stockOf(item)).toEqual([20_000n, 2200_00n, 110_00n]);
});

test("other state → IGST; a typed round-off (±₹1) matches the vendor's total; more than ₹1 is refused", async () => {
  const item = await acrylic("PB LED strip");
  const lines = [itemLine(item, "3", "333.33", "12")]; // ₹999.99 + IGST ₹120.00 = ₹1,119.99
  const id = await save(owner, bill(outside, "MLT-55", lines, { roundOff: "-0.99" }));
  expect((await posted(id)).net).toEqual({ stock: 999_99n, gst_in_igst: 120_00n, round_off: -99n, ap: -1119_00n });
  await expect(save(owner, bill(outside, "MLT-56", lines, { roundOff: "1.01" }))).rejects.toThrow("₹1 either way at most");
  // An unregistered vendor's line is simply at the GST % typed (0 by default in the form).
  const u = await save(owner, bill(unregistered, "12", [expenseLine("1", "750", "0")]));
  expect((await posted(u)).net).toEqual({ [`account ${transport.accountId}`]: 750_00n, ap: -750_00n });
});

test("the vendor's bill no is unique per vendor (any case); another vendor or a cancelled bill frees it", async () => {
  const item = await acrylic("PB ACP");
  const first = await save(owner, bill(local, "INV-77", [itemLine(item, "1", "500")]));
  const { number } = (await getPurchaseBill(first))!;
  await expect(save(owner, bill(local, "inv-77", [itemLine(item, "1", "500")]))).rejects.toThrow(
    `This vendor's bill inv-77 is already entered as ${number}.`,
  );
  await save(owner, bill(outside, "INV-77", [itemLine(item, "1", "500")]));
  await cancelPurchaseBill(owner, first, "Entered twice");
  await save(owner, bill(local, "INV-77", [itemLine(item, "1", "500")]));
});

test("cancel reverses the entry and the stock on the bill date; refused once the stock has been used", async () => {
  const item = await acrylic("PB acrylic 5mm");
  const id = await save(owner, bill(local, "C-1", [itemLine(item, "10", "200")]));
  expect((await cancelPurchaseBill(owner, id, "Wrong vendor")).message).toMatch(/^Cancelled PB\//);
  expect((await posted(id)).net).toEqual({ stock: 0n, gst_in_cgst: 0n, gst_in_sgst: 0n, ap: 0n });
  const entries = await db.select().from(journalEntries).where(and(eq(journalEntries.docType, "purchase_bills"), eq(journalEntries.docId, id)));
  expect(entries.map((e) => e.date)).toEqual([today, today]);
  expect(await stockOf(item)).toEqual([0n, 0n, null]);
  expect((await getPurchaseBill(id))!.status).toBe("cancelled");

  const used = await save(owner, bill(local, "C-2", [itemLine(item, "10", "200")]));
  await createStockAdjustment(owner, { itemId: String(item), date: formatDate(today), qty: "-8", rate: "", reason: "Used on a job" });
  await expect(cancelPurchaseBill(owner, used, "")).rejects.toThrow("PB acrylic 5mm has been used or issued since this bill was entered");
  expect((await getPurchaseBill(used))!.status).toBe("active");
  expect(await stockOf(item)).toEqual([2_000n, 400_00n, 200_00n]);
});

test("D52: once stock went out after a bill, its stock can't be taken back (no value left on zero qty); other edits still work", async () => {
  const item = await acrylic("PB acrylic 6mm");
  const first = await save(owner, bill(local, "D52-1", [itemLine(item, "10", "100")]));
  const second = await save(owner, bill(local, "D52-2", [itemLine(item, "10", "200"), expenseLine("1", "500", "5")]));
  // 20 sheets worth ₹3,000 (average ₹150); 10 go out at ₹1,500.
  await createStockAdjustment(owner, { itemId: String(item), date: formatDate(today), qty: "-10", rate: "", reason: "Used" });
  expect(await stockOf(item)).toEqual([10_000n, 1500_00n, 150_00n]);
  // Before D52 this cancel went through and left 0 sheets worth −₹500.
  await expect(cancelPurchaseBill(owner, second, "")).rejects.toThrow("has been used or issued since this bill was entered");
  await expect(cancelPurchaseBill(owner, first, "")).rejects.toThrow("stock adjustment instead");
  const edit = (lines: PurchaseLineText[], patch: Partial<BillInput> = {}) =>
    updatePurchaseBill(owner, second, bill(local, "D52-2", lines, patch), "");
  await expect(edit([itemLine(item, "8", "200"), expenseLine("1", "500", "5")])).rejects.toThrow("stock adjustment instead");
  await expect(edit([itemLine(item, "10", "210"), expenseLine("1", "500", "5")])).rejects.toThrow("stock adjustment instead");
  // The stock lines unchanged: the expense line, notes and even the date may change (the moves go back in as they were).
  await edit([itemLine(item, "10", "200"), expenseLine("1", "650", "5")], { notes: "Transport corrected", date: formatDate(addDays(today, -1)) });
  expect((await getPurchaseBill(second))!.totalPaise).toBe(3043_00n); // ₹2,000 + ₹360 GST + ₹650 + ₹32.50, rounded
  expect(await stockOf(item)).toEqual([10_000n, 1500_00n, 150_00n]);
  // Re-entered moves still count from the bill's first entry: the cancel stays refused.
  await expect(cancelPurchaseBill(owner, second, "")).rejects.toThrow("stock adjustment instead");
  // A bill entered after the stock went out can be cancelled.
  const later = await save(owner, bill(local, "D52-3", [itemLine(item, "5", "300")]));
  await cancelPurchaseBill(owner, later, "Wrong item");
  expect(await stockOf(item)).toEqual([10_000n, 1500_00n, 150_00n]);
});

test("edit = reverse + repost (books and stock); the accountant's edit and cancel wait for the owner", async () => {
  const item = await acrylic("PB acrylic 8mm");
  const input = bill(local, "E-1", [itemLine(item, "5", "300")]);
  const id = await save(owner, input);
  const version = async () => (await db.select().from(purchaseBills).where(eq(purchaseBills.id, id)))[0].updatedAt;

  expect(await updatePurchaseBill(accountant, id, bill(local, "E-1", [itemLine(item, "6", "300")]), "Qty was 6")).toEqual({ message: SENT_FOR_APPROVAL });
  expect(await stockOf(item)).toEqual([5_000n, 1500_00n, 300_00n]); // nothing changed yet
  const [req] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, "purchase_bill.edit"), eq(approvalRequests.targetId, id)));
  expect(req.changes).toContainEqual({ label: "Total", old: "₹1,770.00", new: "₹2,124.00" });
  const before = await version();
  await approve(owner, req.id, "");
  expect(await version()).not.toEqual(before);
  expect(await stockOf(item)).toEqual([6_000n, 1800_00n, 300_00n]);
  expect((await posted(id)).net).toMatchObject({ stock: 1800_00n, ap: -2124_00n }); // old entry reversed, new one posted
  const moves = await db.select().from(stockMoves).where(and(eq(stockMoves.source, "purchase"), eq(stockMoves.sourceId, id))).orderBy(asc(stockMoves.id));
  expect(moves.map((m) => m.qtyMilli)).toEqual([5_000n, -5_000n, 6_000n]);
  expect((await getPurchaseBill(id))!.lines.map((l) => l.qtyMilli)).toEqual([6_000n]);

  expect(await cancelPurchaseBill(accountant, id, "Duplicate")).toEqual({ message: SENT_FOR_APPROVAL });
  expect((await getPurchaseBill(id))!.status).toBe("active");
});

test("guards: a job only on expense lines; no rates without can_view_cost; a backdated bill by a non-owner waits", async () => {
  const item = await acrylic("PB guard item");
  await expect(save(owner, bill(local, "G-1", [{ ...itemLine(item, "1", "10"), jobId: String(jobId) }]))).rejects.toThrow(
    "Line 1: a job goes on expense lines only",
  );
  await expect(save(noCost, bill(local, "G-2", [itemLine(item, "1", "10")]))).rejects.toThrow("Not allowed");
  // Backdate days not set = anything before today (D39).
  const old = bill(local, "G-3", [itemLine(item, "1", "10")], { date: formatDate(addDays(today, -5)) });
  expect(await createPurchaseBill(accountant, old)).toEqual({ id: null, message: SENT_FOR_APPROVAL });
  expect((await createPurchaseBill(owner, bill(local, "G-4", [itemLine(item, "1", "10")], { date: formatDate(addDays(today, -5)) }))).id).not.toBeNull();
});
