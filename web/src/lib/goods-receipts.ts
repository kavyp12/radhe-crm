import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { goodsReceiptLines, goodsReceipts, purchaseBillLines, purchaseBills, purchaseOrderLines, purchaseOrders, stockItems, vendors } from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse } from "@/lib/ledger";
import { bpText, milliText, moneyText, parseQty } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import type { PurchaseLineText } from "@/lib/purchase-lines";
import { taxableOf } from "@/lib/purchase-lines";
import { orderStatus, receivedByLine } from "@/lib/purchase-orders";
import { readDate } from "@/lib/sales";
import { addMove, checkNothingOutSince, checkNotNegative, liveMoves, lockItems, pair, reverseMoves } from "@/lib/stock-moves";

// Material receive / GRN (S18, A§3, D21, D52, D53): goods received against a purchase order, numbered GRN/ and posted
// when saved — Dr stock / Cr grn_clearing at the PO rate (excl. GST), with stock moves at that value. Partial receipts
// are fine, never more than ordered less already received (the PO is locked, so two GRNs queue); the PO's status
// follows (Partly received / Received). A bill made from it clears grn_clearing (lib/purchase-bills.ts). Cancel only
// while unbilled and none of its stock has gone out since (D52). Owner / accountant with can_view_cost (PO rates);
// a non-owner's backdated save or cancel goes to the owner (A§7).

type Receipt = typeof goodsReceipts.$inferSelect;

/** The form as typed. lines = JSON of { orderLineId, qty }[]; a blank qty = not received this time. */
export type ReceiptInput = { orderId: string; date: string; notes: string; lines: string };

function allowed(actor: SessionUser, action: "create" | "cancel") {
  if (!can(actor, "goodsReceipts", action) || !canViewCost(actor)) throw new Error("Not allowed");
}

function readLines(json: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  const lines: { orderLineId: number; qty: bigint }[] = [];
  for (const [i, row] of raw.entries()) {
    const o = (row ?? {}) as Record<string, unknown>;
    const text = typeof o.qty === "string" ? o.qty.trim() : "";
    if (!text) continue;
    let qty = -1n;
    try {
      qty = parseQty(text);
    } catch {
      // below
    }
    if (qty < 0n) throw new UserError(`Line ${i + 1}: enter the qty received like 10 or 2.5.`, "lines");
    if (qty === 0n) continue;
    const orderLineId = Number(o.orderLineId);
    if (!Number.isSafeInteger(orderLineId)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
    lines.push({ orderLineId, qty });
  }
  if (!lines.length) throw new UserError("Enter the qty received on at least one line.", "lines");
  if (new Set(lines.map((l) => l.orderLineId)).size !== lines.length) throw new UserError("Put each order line once.", "lines");
  return lines;
}

/** The GRN as it would post now: each line at its PO rate, never more than ordered less already received. */
async function plan(tx: Tx, input: ReceiptInput) {
  const orderId = Number(input.orderId);
  const [order] = Number.isSafeInteger(orderId) ? await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update") : [];
  if (!order) throw new UserError("Pick the purchase order.", "orderId");
  if (order.status === "cancelled") throw new UserError(`${order.number} is cancelled.`, "orderId");
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const read = readLines(input.lines);
  const orderLines = await tx
    .select({ line: purchaseOrderLines, name: stockItems.name, unit: stockItems.unit })
    .from(purchaseOrderLines)
    .innerJoin(stockItems, eq(stockItems.id, purchaseOrderLines.itemId))
    .where(and(eq(purchaseOrderLines.orderId, order.id), eq(purchaseOrderLines.active, true)));
  const received = await receivedByLine(tx, [order.id]);
  const lines = read.map((l, i) => {
    const o = orderLines.find((x) => x.line.id === l.orderLineId);
    if (!o) throw new UserError(`Line ${i + 1}: that order line doesn't exist; reload the page.`, "lines");
    const pending = o.line.qtyMilli - (received.get(o.line.id) ?? 0n);
    if (l.qty > pending) {
      throw new UserError(
        pending > 0n
          ? `${o.name}: only ${milliText(pending)} ${o.unit} is still to come on ${order.number}.`
          : `${o.name}: all of it is already received on ${order.number}.`,
        "lines",
      );
    }
    const value = taxableOf({ qtyMilli: l.qty, ratePaise: o.line.ratePaise });
    return { ...l, itemId: o.line.itemId, name: o.name, unit: o.unit, rate: o.line.ratePaise, value };
  });
  return { order, date, notes: formText(input.notes, "notes", 1000), lines, total: lines.reduce((s, l) => s + l.value, 0n) };
}

type Plan = Awaited<ReturnType<typeof plan>>;
const itemsText = (p: Plan) => p.lines.map((l) => `${l.name} × ${milliText(l.qty)} ${l.unit}`).join(", ");

async function doCreate(tx: Tx, actor: SessionUser, input: ReceiptInput) {
  const p = await plan(tx, input);
  await lockItems(tx, p.lines.map((l) => l.itemId));
  const number = await nextNumber(tx, "grn", p.date);
  const [row] = await tx
    .insert(goodsReceipts)
    .values({ number, date: p.date, orderId: p.order.id, notes: p.notes, createdBy: actor.id })
    .returning({ id: goodsReceipts.id });
  await tx.insert(goodsReceiptLines).values(
    p.lines.map((l, i) => ({
      receiptId: row.id,
      position: i + 1,
      orderLineId: l.orderLineId,
      itemId: l.itemId,
      qtyMilli: l.qty,
      ratePaise: l.rate,
      valuePaise: l.value,
    })),
  );
  for (const l of p.lines) {
    await addMove(tx, { itemId: l.itemId, date: p.date, qty: l.qty, value: l.value, source: "grn", sourceId: row.id });
  }
  const lines = pair(p.total, "stock", "grn_clearing"); // A§3, D21: at the PO rate
  if (lines.length) {
    await post(tx, { date: p.date, docType: "goods_receipts", docId: row.id, number, narration: `Material receive ${number} · ${p.order.number}`, lines });
  }
  return { id: row.id, number };
}

type CreatePayload = { input: ReceiptInput };

registerExecutor<CreatePayload>("grn.create", {
  async describe(tx, p) {
    const d = await plan(tx, p.input);
    return {
      summary: `Material receive against ${d.order.number}, dated ${formatDate(d.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(d.date) },
        { label: "Items", old: null, new: itemsText(d) },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

/** Save a GRN: numbered, stocked in and posted in one transaction; a non-owner's backdated one → a request. */
export async function createReceipt(actor: SessionUser, input: ReceiptInput): Promise<{ id: number | null; message: string }> {
  allowed(actor, "create");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "grn.create", { input } satisfies CreatePayload, `Dated ${formatDate(date)}, before the backdate window`);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

/** Live bills made from these GRNs (their lines billed on a bill that isn't cancelled). */
function billsFrom(q: Tx | typeof db, receiptIds: number[]) {
  return q
    .selectDistinct({ receiptId: goodsReceiptLines.receiptId, id: purchaseBills.id, number: purchaseBills.number })
    .from(purchaseBillLines)
    .innerJoin(purchaseBills, eq(purchaseBills.id, purchaseBillLines.billId))
    .innerJoin(goodsReceiptLines, eq(goodsReceiptLines.id, purchaseBillLines.grnLineId))
    .where(and(inArray(goodsReceiptLines.receiptId, [0, ...receiptIds]), eq(purchaseBillLines.active, true), eq(purchaseBills.status, "active")))
    .orderBy(asc(purchaseBills.id));
}

type CancelPayload = { id: number };

async function lock(tx: Tx, id: number) {
  const [g] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, id)).for("update");
  if (!g) throw new UserError("That GRN doesn't exist.");
  if (g.status !== "active") throw new UserError(`${g.number} is already cancelled.`);
  return g;
}

/** D53: not once billed (cancel the bill first); D52: not once any of its stock has gone out since (items locked). */
async function checkCancel(tx: Tx, g: Receipt, items: number[]) {
  const [bill] = await billsFrom(tx, [g.id]);
  if (bill) throw new UserError(`${g.number} is billed on ${bill.number}: cancel that bill first.`);
  await checkNothingOutSince(tx, "grn", g.id, items, "GRN");
}

/** Mirror moves + reversal on the GRN's own date (D45); its PO lines are open again. */
async function doCancel(tx: Tx, p: CancelPayload) {
  const g = await lock(tx, p.id);
  const items = [...new Set((await liveMoves(tx, "grn", g.id)).map((m) => m.itemId))];
  await lockItems(tx, items);
  await checkCancel(tx, g, items);
  const entry = await liveEntry(tx, "goods_receipts", g.id);
  if (entry) await reverse(tx, entry.id, g.date);
  await reverseMoves(tx, "grn", g.id);
  await checkNotNegative(tx, items);
  await tx.update(goodsReceipts).set({ status: "cancelled" }).where(eq(goodsReceipts.id, g.id));
  return g.number;
}

registerExecutor<CancelPayload>("grn.cancel", {
  async describe(tx, p) {
    const g = await lock(tx, p.id);
    await checkCancel(tx, g, (await liveMoves(tx, "grn", g.id)).map((m) => m.itemId));
    return {
      summary: `Cancel material receive ${g.number}`,
      target: { type: "goods_receipts", id: g.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Stock and journal", old: null, new: `Reversed on ${formatDate(g.date)}` },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

/** Owner / accountant; dated before the backdate window: the accountant's cancel waits for the owner (A§7, D52). */
export async function cancelReceipt(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  allowed(actor, "cancel");
  const [g] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
  if (!g) throw new UserError("That GRN doesn't exist.");
  if (g.status !== "active") throw new UserError(`${g.number} is already cancelled.`);
  const done = `Cancelled ${g.number}; its stock and entry are reversed.`;
  if (await needsBackdateApproval(g.date)) {
    const outcome = await runOrRequest(actor, "grn.cancel", { id } satisfies CancelPayload, reason);
    return { message: outcome.done ? done : outcome.message };
  }
  await writeTx(actor, (tx) => doCancel(tx, { id }));
  return { message: done };
}

// ---- Loaders (callers have checked goodsReceipts + can_view_cost)

async function linesOf(receiptIds: number[]) {
  if (!receiptIds.length) return [];
  return db
    .select({ line: goodsReceiptLines, name: stockItems.name, unit: stockItems.unit, gstBp: purchaseOrderLines.gstBp })
    .from(goodsReceiptLines)
    .innerJoin(stockItems, eq(stockItems.id, goodsReceiptLines.itemId))
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, goodsReceiptLines.orderLineId))
    .where(inArray(goodsReceiptLines.receiptId, receiptIds))
    .orderBy(asc(goodsReceiptLines.receiptId), asc(goodsReceiptLines.position));
}

export async function listReceipts() {
  const rows = await db
    .select({
      id: goodsReceipts.id,
      number: goodsReceipts.number,
      date: goodsReceipts.date,
      status: goodsReceipts.status,
      orderId: goodsReceipts.orderId,
      order: purchaseOrders.number,
      vendor: vendors.name,
    })
    .from(goodsReceipts)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.orderId))
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .orderBy(desc(goodsReceipts.id));
  const ids = rows.map((r) => r.id);
  const [lines, bills] = await Promise.all([linesOf(ids), billsFrom(db, ids)]);
  const byReceipt = Map.groupBy(lines, (l) => l.line.receiptId);
  return rows.map((r) => ({
    ...r,
    value: (byReceipt.get(r.id) ?? []).reduce((s, l) => s + l.line.valuePaise, 0n),
    bills: bills.filter((b) => b.receiptId === r.id).map((b) => b.number),
  }));
}

export async function getReceipt(id: number) {
  const [row] = await db
    .select({ receipt: goodsReceipts, order: purchaseOrders.number, vendorId: vendors.id, vendor: vendors.name })
    .from(goodsReceipts)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.orderId))
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(eq(goodsReceipts.id, id));
  if (!row) return undefined;
  const [lines, bills] = await Promise.all([linesOf([id]), billsFrom(db, [id])]);
  const billed = await billedLines(lines.map((l) => l.line.id));
  return {
    ...row.receipt,
    order: row.order,
    vendorId: row.vendorId,
    vendor: row.vendor,
    total: lines.reduce((s, l) => s + l.line.valuePaise, 0n),
    lines: lines.map((l) => ({ ...l.line, name: l.name, unit: l.unit, gstBp: l.gstBp, bill: billed.get(l.line.id) ?? null })),
    bills: bills.map((b) => ({ id: b.id, number: b.number })),
  };
}

/** GRN line → the live bill it is billed on. */
async function billedLines(lineIds: number[]) {
  if (!lineIds.length) return new Map<number, { id: number; number: string }>();
  const rows = await db
    .select({ lineId: purchaseBillLines.grnLineId, id: purchaseBills.id, number: purchaseBills.number })
    .from(purchaseBillLines)
    .innerJoin(purchaseBills, eq(purchaseBills.id, purchaseBillLines.billId))
    .where(and(inArray(purchaseBillLines.grnLineId, lineIds), eq(purchaseBillLines.active, true), eq(purchaseBills.status, "active")));
  return new Map(rows.map((r) => [r.lineId!, { id: r.id, number: r.number }]));
}

/** A PO's lines for the GRN form: ordered, received so far and still to come (default qty = still to come). */
export async function receiveForm(orderId: number) {
  const [order] = await db
    .select({ order: purchaseOrders, vendor: vendors.name })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(eq(purchaseOrders.id, orderId));
  if (!order || order.order.status === "cancelled") return undefined;
  const lines = await db
    .select({ line: purchaseOrderLines, name: stockItems.name, unit: stockItems.unit })
    .from(purchaseOrderLines)
    .innerJoin(stockItems, eq(stockItems.id, purchaseOrderLines.itemId))
    .where(and(eq(purchaseOrderLines.orderId, orderId), eq(purchaseOrderLines.active, true)))
    .orderBy(asc(purchaseOrderLines.position));
  const received = await receivedByLine(db, [orderId]);
  return {
    id: orderId,
    number: order.order.number,
    vendor: order.vendor,
    lines: lines.map((l) => {
      const got = received.get(l.line.id) ?? 0n;
      return { id: l.line.id, name: l.name, unit: l.unit, rate: l.line.ratePaise, ordered: l.line.qtyMilli, received: got, pending: l.line.qtyMilli - got };
    }),
  };
}

/** Orders goods can still come in against: not cancelled and not fully received. */
export async function openOrders() {
  const rows = await db
    .select({ id: purchaseOrders.id, number: purchaseOrders.number, date: purchaseOrders.date, status: purchaseOrders.status, vendor: vendors.name })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(inArray(purchaseOrders.status, ["draft", "sent"]))
    .orderBy(desc(purchaseOrders.id));
  const lines = await db
    .select({ id: purchaseOrderLines.id, orderId: purchaseOrderLines.orderId, qtyMilli: purchaseOrderLines.qtyMilli })
    .from(purchaseOrderLines)
    .where(and(inArray(purchaseOrderLines.orderId, [0, ...rows.map((r) => r.id)]), eq(purchaseOrderLines.active, true)));
  const byOrder = Map.groupBy(lines, (l) => l.orderId);
  const received = await receivedByLine(db, rows.map((r) => r.id));
  return rows.filter((r) => orderStatus(r.status, byOrder.get(r.id) ?? [], received) !== "Received");
}

/**
 * The bill form's lines from GRNs (bill from GRN): their lines not billed yet, item and qty as received, the rate =
 * the PO rate (change it to the vendor's), GST % = the PO line's. Also the vendor (one per bill).
 */
export async function billLinesFromReceipts(receiptIds: number[]) {
  const receipts = (await Promise.all(receiptIds.map((id) => getReceipt(id)))).filter((g) => g && g.status === "active");
  const vendorId = receipts[0]?.vendorId;
  const same = receipts.filter((g) => g!.vendorId === vendorId);
  const lines: PurchaseLineText[] = same.flatMap((g) =>
    g!.lines
      .filter((l) => l.bill === null)
      .map((l) => ({
        what: `item:${l.itemId}`,
        description: "",
        qty: milliText(l.qtyMilli),
        rate: moneyText(l.ratePaise),
        gst: bpText(l.gstBp),
        jobId: "",
        grnLineId: String(l.id),
      })),
  );
  return { vendorId, receipts: same.map((g) => ({ id: g!.id, number: g!.number })), lines };
}
