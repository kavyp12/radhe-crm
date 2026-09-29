import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { accounts, expenseCategories, journalEntries, journalLines, stockMoves } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { createCustomer } from "@/lib/customers";
import { formatDate, todayIST } from "@/lib/dates";
import { gstinCheckChar } from "@/lib/gstin";
import { billLinesFromReceipts, cancelReceipt, createReceipt, getReceipt, openOrders, type ReceiptInput } from "@/lib/goods-receipts";
import { createJob } from "@/lib/jobs";
import { createRequest, decideRequest } from "@/lib/material-requests";
import type { SessionUser } from "@/lib/permissions";
import { cancelPurchaseBill, createPurchaseBill, getPurchaseBill, updatePurchaseBill, type BillInput } from "@/lib/purchase-bills";
import { purchaseChain } from "@/lib/purchase-chain";
import type { PurchaseLineText } from "@/lib/purchase-lines";
import { cancelOrder, createOrder, getOrder, linesFromRequests, updateOrder } from "@/lib/purchase-orders";
import { saveBooks } from "@/lib/settings";
import { createItem, getItem } from "@/lib/stock";
import { createStockIssue } from "@/lib/stock-issues";
import { createVendor } from "@/lib/vendors";
import { createVendorPayment } from "@/lib/vendor-payments";

// T23 (S18, A§3, D21, D52, D53): a GRN posts Dr stock / Cr grn_clearing at the PO rate; a bill from it clears
// grn_clearing with the difference to price_variance and no stock move; partial receipts; cancel rules; the chain.

let owner: SessionUser;
let vendorId: number;
let categoryId: string;
let cashId: string;
const today = todayIST();
const withCheck = (first14: string) => first14 + gstinCheckChar(first14);

beforeAll(async () => {
  owner = await testOwner();
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  vendorId = await createVendor(owner, {
    name: "GRN Sign Supplies", gstin: withCheck("24AAAPG1234Q1Z"), stateCode: "24", mobile: "", address: "", creditDays: "", notes: "",
  });
  categoryId = String((await db.select().from(expenseCategories).where(eq(expenseCategories.name, "ACP")))[0].id);
  cashId = String((await db.select().from(accounts).where(eq(accounts.systemKey, "cash")))[0].id);
});

const item = (name: string) => createItem(owner, { name, unit: "Sheet", categoryId, hsnSac: "7606", gstPercent: "18" });
/** A PO for `qty` sheets @ ₹100 at 18%. */
async function order(itemId: number, qty: string) {
  const lines = [{ itemId: String(itemId), description: "", qty, rate: "100", gst: "18", requestLineId: "" }];
  return (await createOrder(owner, { vendorId: String(vendorId), date: formatDate(today), notes: "", lines: JSON.stringify(lines) })).id;
}
const receive = async (orderId: number, qty: string) => {
  const o = (await getOrder(orderId))!;
  const input: ReceiptInput = { orderId: String(orderId), date: formatDate(today), notes: "", lines: JSON.stringify([{ orderLineId: String(o.lines[0].id), qty }]) };
  return (await createReceipt(owner, input)).id!;
};
const billInput = (no: string, lines: PurchaseLineText[]): BillInput => ({
  vendorId: String(vendorId), vendorBillNo: no, date: formatDate(today), roundOff: "", notes: "", lines: JSON.stringify(lines),
});
/** The bill for a GRN's unbilled lines at the vendor's `rate`. */
async function billAt(grnId: number, no: string, rate: string) {
  const { lines } = await billLinesFromReceipts([grnId]);
  return (await createPurchaseBill(owner, billInput(no, lines.map((l) => ({ ...l, rate }))))).id!;
}
/** Net per system account (+Dr / −Cr) over these documents' journal entries. */
async function net(docs: [string, number][]) {
  const rows = await db
    .select({ key: accounts.systemKey, debit: journalLines.debitPaise, credit: journalLines.creditPaise, docType: journalEntries.docType, docId: journalEntries.docId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(inArray(journalEntries.docType, [...new Set(docs.map(([t]) => t))]));
  const out: Record<string, bigint> = {};
  for (const r of rows.filter((r) => docs.some(([t, id]) => t === r.docType && id === r.docId))) out[r.key!] = (out[r.key!] ?? 0n) + r.debit - r.credit;
  return out;
}
const stockOf = async (itemId: number) => {
  const i = (await getItem(owner, itemId))!;
  return [i.qty, i.cost!.value];
};

test("a GRN posts Dr stock / Cr grn_clearing at the PO rate (excl. GST) and brings the stock in", async () => {
  const sheet = await item("GRN ACP sheet 3mm");
  const po = await order(sheet, "10");
  const grn = await receive(po, "4");
  const g = (await getReceipt(grn))!;
  expect(g.number).toMatch(/^GRN\/26-27\/\d{4}$/);
  expect(g.total).toBe(400_00n);
  expect(await net([["goods_receipts", grn]])).toEqual({ stock: 400_00n, grn_clearing: -400_00n });
  const moves = await db.select().from(stockMoves).where(and(eq(stockMoves.source, "grn"), eq(stockMoves.sourceId, grn)));
  expect(moves.map((m) => [m.qtyMilli, m.valuePaise])).toEqual([[4_000n, 400_00n]]);
  expect(await stockOf(sheet)).toEqual([4_000n, 400_00n]);
});

test("two partial GRNs: Partly Received → Received; over-receiving is refused; a received order can't change", async () => {
  const sheet = await item("GRN ACP sheet 4mm");
  const po = await order(sheet, "10");
  expect((await getOrder(po))!.shown).toBe("Draft");
  await receive(po, "4");
  expect((await getOrder(po))!).toMatchObject({ shown: "Partly Received", lines: [{ received: 4_000n }] });
  await expect(receive(po, "7")).rejects.toThrow("only 6 Sheet is still to come");
  expect((await openOrders()).map((o) => o.id)).toContain(po);
  await receive(po, "6");
  expect((await getOrder(po))!.shown).toBe("Received");
  await expect(receive(po, "1")).rejects.toThrow("all of it is already received");
  expect((await openOrders()).map((o) => o.id)).not.toContain(po);
  await expect(cancelOrder(owner, po)).rejects.toThrow("can't be cancelled");
  const lines = JSON.stringify([{ itemId: String(sheet), description: "", qty: "12", rate: "100", gst: "18", requestLineId: "" }]);
  await expect(updateOrder(owner, po, { vendorId: String(vendorId), date: formatDate(today), notes: "", lines })).rejects.toThrow("can't be changed");
});

test("bills from GRNs: a higher and a lower rate → price_variance ±, grn_clearing back to zero, no stock move; each GRN line billed once", async () => {
  const sheet = await item("GRN ACP sheet 6mm");
  const po = await order(sheet, "10");
  const first = await receive(po, "4"); // ₹400 at the PO rate
  const second = await receive(po, "6"); // ₹600
  const movesBefore = (await db.select().from(stockMoves).where(eq(stockMoves.itemId, sheet))).length;

  // 4 @ ₹105 = ₹420: Dr grn_clearing ₹400 + price_variance ₹20 + CGST / SGST ₹37.80 each; ₹495.60 → round-off +₹0.40.
  const higher = await billAt(first, "GS-1", "105");
  expect(await net([["purchase_bills", higher]])).toEqual({
    grn_clearing: 400_00n,
    price_variance: 20_00n,
    gst_in_cgst: 37_80n,
    gst_in_sgst: 37_80n,
    round_off: 40n,
    ap: -496_00n,
  });
  expect(await net([["goods_receipts", first], ["purchase_bills", higher]])).toMatchObject({ grn_clearing: 0n });
  // 6 @ ₹95 = ₹570: price_variance −₹30 (Cr).
  const lower = await billAt(second, "GS-2", "95");
  expect(await net([["purchase_bills", lower]])).toMatchObject({ grn_clearing: 600_00n, price_variance: -30_00n });
  expect(await net([["goods_receipts", second], ["purchase_bills", lower]])).toMatchObject({ grn_clearing: 0n });
  // The stock stays at the GRN value: bills add no stock move.
  expect(await stockOf(sheet)).toEqual([10_000n, 1000_00n]);
  expect((await db.select().from(stockMoves).where(eq(stockMoves.itemId, sheet))).length).toBe(movesBefore);
  expect((await getPurchaseBill(higher))!.lines).toMatchObject([{ grnId: first, grn: (await getReceipt(first))!.number }]);

  // Billed once: nothing left to bill, and the same GRN line on another bill is refused.
  expect((await billLinesFromReceipts([first])).lines).toEqual([]);
  const [line] = (await getReceipt(first))!.lines;
  const again = billInput("GS-3", [{ what: `item:${sheet}`, description: "", qty: "4", rate: "105", gst: "18", jobId: "", grnLineId: String(line.id) }]);
  await expect(createPurchaseBill(owner, again)).rejects.toThrow(`already billed on ${(await getPurchaseBill(higher))!.number}`);
  // The item and qty stay as received.
  await expect(updatePurchaseBill(owner, higher, billInput("GS-1", [{ ...JSON.parse(again.lines)[0], qty: "3" }]), "")).rejects.toThrow(
    "the item and qty stay as received",
  );
  // The vendor's rate corrected on the bill: reversed + reposted, still no stock move.
  await updatePurchaseBill(owner, higher, billInput("GS-1", [{ ...JSON.parse(again.lines)[0], rate: "102" }]), "");
  expect(await net([["purchase_bills", higher]])).toMatchObject({ grn_clearing: 400_00n, price_variance: 8_00n });
  expect(await stockOf(sheet)).toEqual([10_000n, 1000_00n]);
});

test("a GRN can't be cancelled once billed (cancel the bill first), nor once its stock has gone out (D52)", async () => {
  const sheet = await item("GRN ACP sheet 8mm");
  const po = await order(sheet, "10");
  const grn = await receive(po, "5");
  const bill = await billAt(grn, "GC-1", "100");
  const { number } = (await getPurchaseBill(bill))!;
  await expect(cancelReceipt(owner, grn, "")).rejects.toThrow(`is billed on ${number}: cancel that bill first.`);
  // The bill's cancel takes grn_clearing back (no stock change); then the GRN can go.
  await cancelPurchaseBill(owner, bill, "Wrong bill");
  expect(await net([["goods_receipts", grn], ["purchase_bills", bill]])).toMatchObject({ grn_clearing: -500_00n });
  expect(await stockOf(sheet)).toEqual([5_000n, 500_00n]);
  expect((await cancelReceipt(owner, grn, "Entered twice")).message).toMatch(/^Cancelled GRN\//);
  expect(await stockOf(sheet)).toEqual([0n, 0n]);
  expect(await net([["goods_receipts", grn]])).toEqual({ stock: 0n, grn_clearing: 0n });
  expect((await getOrder(po))!.shown).toBe("Draft");

  // Stock from a GRN issued to a job: its GRN stays (fix with an adjustment).
  const used = await receive(po, "5");
  const customerId = await createCustomer(owner, {
    name: "GRN Customer", firmName: "", mobile: "", email: "", gstin: "", stateCode: "24", billingAddress: "", siteAddress: "",
    creditLimit: "", creditDays: "", isCreditCustomer: false, salesPersonId: "", collectionPersonId: "", notes: "",
  });
  const pc = String((await db.query.productCategories.findFirst())!.id);
  const jobId = await createJob(owner, {
    customerId: String(customerId), date: formatDate(today), siteAddress: "", siteReference: "", vehicleNo: "", salesPersonId: "", targetDate: "", notes: "",
    lines: JSON.stringify([{ lineId: "", categoryId: pc, description: "", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "1000", discount: "", gst: "0" }]),
  });
  await createStockIssue(owner, { kind: "issue", jobId: String(jobId), date: formatDate(today), notes: "", lines: JSON.stringify([{ itemId: String(sheet), qty: "1" }]) });
  await expect(cancelReceipt(owner, used, "")).rejects.toThrow("has been used or issued since this GRN was entered");
});

test("the chain MR → PO → GRN → Bill → Payment links each step both ways", async () => {
  const sheet = await item("GRN ACP sheet 2mm");
  const mr = await createRequest(owner, { neededBy: formatDate(today), jobId: "", notes: "", lines: JSON.stringify([{ itemId: String(sheet), qty: "3" }]) });
  await decideRequest(owner, mr.id, "approve", "");
  const { lines } = await linesFromRequests([mr.id]);
  const po = await createOrder(owner, { vendorId: String(vendorId), date: formatDate(today), notes: "", lines: JSON.stringify(lines.map((l) => ({ ...l, rate: "100" }))) });
  const grn = await receive(po.id, "3");
  const bill = await billAt(grn, "CH-1", "100");
  const pay = await createVendorPayment(owner, {
    vendorId: String(vendorId), date: formatDate(today), amount: "354", mode: "cash", moneyAccountId: cashId, reference: "", chequeNo: "", chequeDate: "", notes: "",
    allocations: JSON.stringify([{ id: String(bill), amount: "354" }]),
  });
  const numbers = (c: Awaited<ReturnType<typeof purchaseChain>>) => [c.request, c.order, c.receipt, c.bill, c.payment].map((s) => s.map((d) => d.id));
  const all = [[mr.id], [po.id], [grn], [bill], [pay.id!]];
  expect(numbers(await purchaseChain("request", mr.id))).toEqual(all);
  expect(numbers(await purchaseChain("order", po.id))).toEqual(all);
  expect(numbers(await purchaseChain("receipt", grn))).toEqual(all);
  expect(numbers(await purchaseChain("bill", bill))).toEqual(all);
  expect(numbers(await purchaseChain("payment", pay.id!))).toEqual(all);
  // A plain bill (no GRN) has only its payments.
  const plain = (await createPurchaseBill(owner, billInput("CH-2", [{ what: `item:${sheet}`, description: "", qty: "1", rate: "10", gst: "0", jobId: "" }]))).id!;
  expect(numbers(await purchaseChain("bill", plain))).toEqual([[], [], [], [plain], []]);
});
