import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import {
  goodsReceiptLines,
  goodsReceipts,
  materialRequestLines,
  materialRequests,
  PURCHASE_ORDER_STATUSES,
  purchaseBillLines,
  purchaseBills,
  purchaseOrderLines,
  purchaseOrders,
  stockItems,
  vendors,
} from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { gstMode } from "@/lib/lines";
import { itemsText, listRequests } from "@/lib/material-requests";
import { bpText, milliText, moneyText } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import {
  billTotals,
  blankOrderLine,
  ORDER_LINE_KEYS,
  readOrderLine,
  type OrderLine,
  type OrderLineText,
} from "@/lib/purchase-lines";
import { companyState, newShareToken, readDate } from "@/lib/sales";

// Purchase orders (S18, A§8, D36, D53): made from one or more approved material requests (their lines copied, qty
// editable) or blank; numbered PO/ when saved and never posted. Rates default to the item's last purchase rate, GST %
// to the item's; totals as for bills (vendor state vs ours, round-off to the rupee). Draft → Sent (→ Partly received →
// Received from the GRNs, T23); editable until the first GRN, cancelled only while nothing is received. A request on
// a live order is Ordered; cancelling the order (or taking its lines off) makes it Approved again. Owner / accountant
// with can_view_cost only (purchase rates).

type Order = typeof purchaseOrders.$inferSelect;
type OrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export const ORDER_STATUS: Record<OrderStatus, Status> = { draft: "Draft", sent: "Sent", cancelled: "Cancelled" };

/** Per PO line: the qty received on live GRNs (T23). */
export async function receivedByLine(q: Tx | typeof db, orderIds: number[]): Promise<Map<number, bigint>> {
  if (!orderIds.length) return new Map();
  const rows = await q
    .select({ lineId: goodsReceiptLines.orderLineId, qty: sql<string>`sum(${goodsReceiptLines.qtyMilli})` })
    .from(goodsReceiptLines)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.receiptId))
    .where(and(inArray(goodsReceipts.orderId, orderIds), eq(goodsReceipts.status, "active")))
    .groupBy(goodsReceiptLines.orderLineId);
  return new Map(rows.map((r) => [r.lineId, BigInt(r.qty)]));
}

/** The status shown (computed, T23): Cancelled; every line received → Received; some → Partly Received; else Draft / Sent. */
export function orderStatus(status: OrderStatus, lines: { id: number; qtyMilli: bigint }[], received: Map<number, bigint>): Status {
  if (status === "cancelled") return "Cancelled";
  if (lines.length && lines.every((l) => (received.get(l.id) ?? 0n) >= l.qtyMilli)) return "Received";
  if (lines.some((l) => (received.get(l.id) ?? 0n) > 0n)) return "Partly Received";
  return ORDER_STATUS[status];
}

/** Goods came in against the order (a live GRN): it can no longer be changed or cancelled. */
async function checkNothingReceived(tx: Tx, o: Order, what: string) {
  const [grn] = await tx
    .select({ number: goodsReceipts.number })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.orderId, o.id), eq(goodsReceipts.status, "active")))
    .limit(1);
  if (grn) throw new UserError(`Goods have been received against ${o.number} (${grn.number}): it can't be ${what}.`);
}

/** The form as typed. lines = JSON of OrderLineText[]. */
export type OrderInput = { vendorId: string; date: string; notes: string; lines: string };

function allowed(actor: SessionUser, action: "create" | "edit" | "cancel") {
  if (!can(actor, "purchaseOrders", action) || !canViewCost(actor)) throw new Error("Not allowed");
}

function readLines(json: string): OrderLine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  if (raw.length > 200) throw new UserError("An order can have 200 lines at most.", "lines");
  const lines: OrderLine[] = [];
  for (const [i, row] of raw.entries()) {
    const o = (row ?? {}) as Record<string, unknown>;
    const t = Object.fromEntries(ORDER_LINE_KEYS.map((k) => [k, typeof o[k] === "string" ? o[k] : ""])) as OrderLineText;
    if (blankOrderLine(t)) continue;
    try {
      lines.push(readOrderLine(t, i + 1));
    } catch (e) {
      throw new UserError((e as Error).message, "lines");
    }
  }
  if (!lines.length) throw new UserError("Add at least one line.", "lines");
  const copied = lines.flatMap((l) => (l.requestLineId === null ? [] : [l.requestLineId]));
  if (new Set(copied).size !== copied.length) throw new UserError("A requested line is on this order twice.", "lines");
  return lines;
}

const activeLines = (q: Tx | typeof db, orderId: number) =>
  q
    .select()
    .from(purchaseOrderLines)
    .where(and(eq(purchaseOrderLines.orderId, orderId), eq(purchaseOrderLines.active, true)))
    .orderBy(asc(purchaseOrderLines.position));

/** The requests (ids) these order lines were copied from. */
async function requestsOf(tx: Tx, requestLineIds: (number | null)[]) {
  const ids = [...new Set(requestLineIds.filter((v): v is number => v !== null))];
  if (!ids.length) return [];
  const rows = await tx.select({ id: materialRequestLines.requestId }).from(materialRequestLines).where(inArray(materialRequestLines.id, ids));
  return [...new Set(rows.map((r) => r.id))];
}

/** The form → checked values, lines and totals; lines copied from requests are checked against them (locked). */
async function readOrder(tx: Tx, input: OrderInput, current?: Order) {
  const vendorId = Number(input.vendorId);
  const [vendor] = Number.isSafeInteger(vendorId) ? await tx.select().from(vendors).where(eq(vendors.id, vendorId)) : [];
  if (!vendor) throw new UserError("Pick the vendor.", "vendorId");
  if (!vendor.active && vendor.id !== current?.vendorId) throw new UserError("This vendor is inactive.", "vendorId");
  const date = readDate(input.date);
  const lines = readLines(input.lines);
  const old = current ? await activeLines(tx, current.id) : [];

  const items = await tx.select().from(stockItems).where(inArray(stockItems.id, [...new Set(lines.map((l) => l.itemId))]));
  const copied = lines.flatMap((l) => (l.requestLineId === null ? [] : [l.requestLineId]));
  const requested = copied.length
    ? await tx
        .select({ line: materialRequestLines, number: materialRequests.number, status: materialRequests.status })
        .from(materialRequestLines)
        .innerJoin(materialRequests, eq(materialRequests.id, materialRequestLines.requestId))
        .where(inArray(materialRequestLines.id, copied))
        .for("update") // two orders can't both take the same request
    : [];
  const mine = await requestsOf(tx, old.map((o) => o.requestLineId)); // already Ordered by this order
  lines.forEach((l, i) => {
    const fail = (message: string): never => {
      throw new UserError(`Line ${i + 1}: ${message}`, "lines");
    };
    const item = items.find((x) => x.id === l.itemId) ?? fail("that item doesn't exist; pick it again.");
    if (!item.active && !old.some((o) => o.itemId === item.id)) fail(`${item.name} is inactive.`);
    if (l.requestLineId === null) return;
    const r = requested.find((x) => x.line.id === l.requestLineId) ?? fail("that requested line doesn't exist; reload the page.");
    if (r.line.itemId !== l.itemId) fail(`the item must stay as requested on ${r.number}.`);
    const ordered = r.status === "ordered" && mine.includes(r.line.requestId);
    if (r.status !== "approved" && !ordered) fail(`${r.number} is ${r.status}: only approved requests can be ordered.`);
  });

  const mode = gstMode(vendor.stateCode, await companyState(tx));
  const totals = billTotals(lines, mode);
  return {
    vendor,
    lines,
    mode,
    totals,
    requestIds: [...new Set(requested.map((r) => r.line.requestId))],
    oldRequestIds: mine,
    values: {
      vendorId: vendor.id,
      date,
      vendorStateCode: vendor.stateCode,
      totalPaise: totals.total,
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

const insertLines = (tx: Tx, orderId: number, lines: OrderLine[]) =>
  tx.insert(purchaseOrderLines).values(
    lines.map((l, i) => ({
      orderId,
      position: i + 1,
      itemId: l.itemId,
      description: l.description,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise,
      gstBp: l.gstBp,
      requestLineId: l.requestLineId,
    })),
  );

/** A request on a live order's line is Ordered; one no longer on any goes back to Approved (D53). */
async function syncOrdered(tx: Tx, requestIds: number[]) {
  for (const id of new Set(requestIds)) {
    const [live] = await tx
      .select({ one: sql`1` })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.orderId))
      .innerJoin(materialRequestLines, eq(materialRequestLines.id, purchaseOrderLines.requestLineId))
      .where(and(eq(materialRequestLines.requestId, id), eq(purchaseOrderLines.active, true), ne(purchaseOrders.status, "cancelled")))
      .limit(1);
    await tx
      .update(materialRequests)
      .set({ status: live ? "ordered" : "approved" })
      .where(and(eq(materialRequests.id, id), eq(materialRequests.status, live ? "approved" : "ordered")));
  }
}

export async function createOrder(actor: SessionUser, input: OrderInput): Promise<{ id: number; number: string }> {
  allowed(actor, "create");
  return writeTx(actor, async (tx) => {
    const r = await readOrder(tx, input);
    const number = await nextNumber(tx, "purchase_order", r.values.date);
    const [row] = await tx
      .insert(purchaseOrders)
      .values({ ...r.values, number, shareToken: newShareToken(), createdBy: actor.id })
      .returning({ id: purchaseOrders.id });
    await insertLines(tx, row.id, r.lines);
    await syncOrdered(tx, r.requestIds);
    return { id: row.id, number };
  });
}

async function lock(tx: Tx, id: number) {
  const [o] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for("update");
  if (!o) throw new UserError("That order doesn't exist.");
  if (o.status === "cancelled") throw new UserError(`${o.number} is cancelled.`);
  return o;
}

/**
 * Draft / Sent only, until the first GRN: the lines are replaced (old ones kept, deactivated). A Sent order goes back
 * to Draft, to be sent again.
 */
export async function updateOrder(actor: SessionUser, id: number, input: OrderInput): Promise<void> {
  allowed(actor, "edit");
  await writeTx(actor, async (tx) => {
    const current = await lock(tx, id);
    await checkNothingReceived(tx, current, "changed");
    const r = await readOrder(tx, input, current);
    const old = await activeLines(tx, current.id);
    await tx.update(purchaseOrders).set({ ...r.values, status: "draft" }).where(eq(purchaseOrders.id, current.id));
    if (old.length) await tx.update(purchaseOrderLines).set({ active: false }).where(inArray(purchaseOrderLines.id, old.map((o) => o.id)));
    await insertLines(tx, current.id, r.lines);
    await syncOrdered(tx, [...r.oldRequestIds, ...r.requestIds]);
  });
}

/** Draft → Sent: it went to the vendor. */
export async function markOrderSent(actor: SessionUser, id: number) {
  allowed(actor, "edit");
  return writeTx(actor, async (tx) => {
    const o = await lock(tx, id);
    if (o.status !== "draft") throw new UserError(`${o.number} is already sent.`);
    await tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, o.id));
    return { message: "Marked as sent." };
  });
}

/** Only while nothing is received; its requests go back to Approved. */
export async function cancelOrder(actor: SessionUser, id: number) {
  allowed(actor, "cancel");
  return writeTx(actor, async (tx) => {
    const o = await lock(tx, id);
    await checkNothingReceived(tx, o, "cancelled");
    await tx.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, o.id));
    await syncOrdered(tx, await requestsOf(tx, (await activeLines(tx, o.id)).map((l) => l.requestLineId)));
    return { message: `Cancelled ${o.number}.` };
  });
}

// ---- Loaders (callers have checked purchaseOrders + can_view_cost)

/** Orders, newest first, with the status shown (receipts counted, T23). */
export async function listOrders() {
  const rows = await db
    .select({
      id: purchaseOrders.id,
      number: purchaseOrders.number,
      date: purchaseOrders.date,
      status: purchaseOrders.status,
      total: purchaseOrders.totalPaise,
      vendorId: purchaseOrders.vendorId,
      vendor: vendors.name,
    })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .orderBy(desc(purchaseOrders.id));
  const lines = await db
    .select({ id: purchaseOrderLines.id, orderId: purchaseOrderLines.orderId, qtyMilli: purchaseOrderLines.qtyMilli })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.active, true));
  const byOrder = Map.groupBy(lines, (l) => l.orderId);
  const received = await receivedByLine(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, shown: orderStatus(r.status, byOrder.get(r.id) ?? [], received) }));
}

export async function getOrder(id: number) {
  const [row] = await db
    .select({ order: purchaseOrders, vendor: vendors })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(eq(purchaseOrders.id, id));
  if (!row) return undefined;
  const lines = await db
    .select({
      line: purchaseOrderLines,
      name: stockItems.name,
      unit: stockItems.unit,
      hsnSac: stockItems.hsnSac,
      requestId: materialRequests.id,
      request: materialRequests.number,
    })
    .from(purchaseOrderLines)
    .innerJoin(stockItems, eq(stockItems.id, purchaseOrderLines.itemId))
    .leftJoin(materialRequestLines, eq(materialRequestLines.id, purchaseOrderLines.requestLineId))
    .leftJoin(materialRequests, eq(materialRequests.id, materialRequestLines.requestId))
    .where(and(eq(purchaseOrderLines.orderId, id), eq(purchaseOrderLines.active, true)))
    .orderBy(asc(purchaseOrderLines.position));
  const mode = gstMode(row.order.vendorStateCode, await companyState(db));
  const requests = new Map(lines.flatMap((l) => (l.requestId === null ? [] : [[l.requestId, l.request!] as const])));
  const received = await receivedByLine(db, [id]);
  return {
    ...row.order,
    vendor: row.vendor,
    mode,
    shown: orderStatus(row.order.status, lines.map((l) => l.line), received),
    totals: billTotals(lines.map((l) => l.line), mode),
    lines: lines.map((l) => ({
      ...l.line,
      name: l.name,
      unit: l.unit,
      hsnSac: l.hsnSac,
      request: l.request,
      requestId: l.requestId,
      received: received.get(l.line.id) ?? 0n,
    })),
    requests: [...requests].map(([rid, number]) => ({ id: rid, number })),
  };
}

/** The live orders made from a request (its chain). */
export async function ordersForRequest(requestId: number) {
  return db
    .selectDistinct({ id: purchaseOrders.id, number: purchaseOrders.number, status: purchaseOrders.status })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.orderId))
    .innerJoin(materialRequestLines, eq(materialRequestLines.id, purchaseOrderLines.requestLineId))
    .where(and(eq(materialRequestLines.requestId, requestId), eq(purchaseOrderLines.active, true)))
    .orderBy(asc(purchaseOrders.id));
}

/** Each item's last purchase rate: its latest line on a live purchase bill (bill date, then entry order). */
export async function lastPurchaseRates(itemIds?: number[]) {
  const rows = await db
    .selectDistinctOn([purchaseBillLines.stockItemId], { itemId: purchaseBillLines.stockItemId, rate: purchaseBillLines.ratePaise })
    .from(purchaseBillLines)
    .innerJoin(purchaseBills, eq(purchaseBills.id, purchaseBillLines.billId))
    .where(
      and(
        eq(purchaseBillLines.active, true),
        eq(purchaseBills.status, "active"),
        itemIds ? inArray(purchaseBillLines.stockItemId, [0, ...itemIds]) : sql`${purchaseBillLines.stockItemId} is not null`,
      ),
    )
    .orderBy(purchaseBillLines.stockItemId, desc(purchaseBills.date), desc(purchaseBills.id), desc(purchaseBillLines.id));
  return new Map(rows.map((r) => [r.itemId!, r.rate]));
}

/** A saved order's lines as the form's text (edit). */
export const formLines = (lines: (typeof purchaseOrderLines.$inferSelect)[]): OrderLineText[] =>
  lines.map((l) => ({
    itemId: String(l.itemId),
    description: l.description ?? "",
    qty: milliText(l.qtyMilli),
    rate: moneyText(l.ratePaise),
    gst: bpText(l.gstBp),
    requestLineId: l.requestLineId === null ? "" : String(l.requestLineId),
  }));

/** Approved requests' lines as order lines (rate = the last purchase rate, GST % = the item's; 0 if unregistered). */
export async function linesFromRequests(requestIds: number[]) {
  const approved = (await listRequests("approved")).filter((r) => requestIds.includes(r.id));
  const lines = approved.flatMap((r) => r.lines);
  const [rates, items] = await Promise.all([
    lastPurchaseRates(lines.map((l) => l.itemId)),
    lines.length ? db.select().from(stockItems).where(inArray(stockItems.id, lines.map((l) => l.itemId))) : [],
  ]);
  return {
    requests: approved.map((r) => ({ id: r.id, number: r.number })),
    lines: lines.map((l): OrderLineText => {
      const rate = rates.get(l.itemId);
      const gst = items.find((i) => i.id === l.itemId)?.gstBp;
      return { itemId: String(l.itemId), description: "", qty: milliText(l.qty), rate: rate === undefined ? "" : moneyText(rate), gst: gst == null ? "" : bpText(gst), requestLineId: String(l.id) };
    }),
  };
}

/** The approved requests a new order can be made from, with their items as text. */
export async function approvedRequests() {
  return (await listRequests("approved")).map((r) => ({ id: r.id, number: r.number, neededBy: r.neededBy, job: r.job, items: itemsText(r.lines) }));
}

/** Pick lists: active vendors and items (plus what this order already uses), each item's GST % and last rate. */
export async function orderFormOptions(keep: { vendorId?: number; itemIds?: number[] } = {}) {
  const [vendorRows, itemRows, rates, state] = await Promise.all([
    db.select().from(vendors).orderBy(asc(vendors.name)),
    db.select().from(stockItems).orderBy(asc(stockItems.name)),
    lastPurchaseRates(),
    companyState(db),
  ]);
  return {
    vendors: vendorRows
      .filter((v) => v.active || v.id === keep.vendorId)
      .map((v) => ({ id: v.id, name: v.name, stateCode: v.stateCode, registered: !!v.gstin })),
    items: itemRows
      .filter((i) => i.active || keep.itemIds?.includes(i.id))
      .map((i) => ({ id: i.id, name: i.name, unit: i.unit, gstBp: i.gstBp, lastRate: rates.get(i.id) ?? null })),
    companyState: state,
  };
}
