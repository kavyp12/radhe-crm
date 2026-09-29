import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  goodsReceiptLines,
  goodsReceipts,
  materialRequestLines,
  materialRequests,
  purchaseBillLines,
  purchaseBills,
  purchaseOrderLines,
  purchaseOrders,
  vendorAllocations,
  vendorPayments,
} from "@/db/schema";

// The purchase chain (S18, R0, T23): Material request → Purchase order → Material receive (GRN) → Bill → Payment.
// From any of them: what it came from (upstream) and what was made from it (downstream), so each step links both
// ways. Siblings aren't pulled in: a payment's other bills aren't part of this bill's chain.

export const CHAIN_STEPS = ["request", "order", "receipt", "bill", "payment"] as const;
export type ChainStep = (typeof CHAIN_STEPS)[number];
export type ChainDoc = { id: number; number: string; cancelled: boolean };

type Ids = number[];
const has = (ids: Ids) => [0, ...ids]; // never an empty IN ()
const uniq = (rows: { id: number | null }[]) => [...new Set(rows.flatMap((r) => (r.id === null ? [] : [r.id])))];

/** Between step i and i + 1: `down` = the next step's documents made from these, `up` = the ones these came from. */
const LINKS: { down: (ids: Ids) => Promise<Ids>; up: (ids: Ids) => Promise<Ids> }[] = [
  {
    // request ↔ order: an order's live lines copied from the request's lines
    down: async (ids) =>
      uniq(
        await db
          .select({ id: purchaseOrderLines.orderId })
          .from(purchaseOrderLines)
          .innerJoin(materialRequestLines, eq(materialRequestLines.id, purchaseOrderLines.requestLineId))
          .where(and(inArray(materialRequestLines.requestId, has(ids)), eq(purchaseOrderLines.active, true))),
      ),
    up: async (ids) =>
      uniq(
        await db
          .select({ id: materialRequestLines.requestId })
          .from(purchaseOrderLines)
          .innerJoin(materialRequestLines, eq(materialRequestLines.id, purchaseOrderLines.requestLineId))
          .where(and(inArray(purchaseOrderLines.orderId, has(ids)), eq(purchaseOrderLines.active, true))),
      ),
  },
  {
    // order ↔ receipt
    down: async (ids) => uniq(await db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(inArray(goodsReceipts.orderId, has(ids)))),
    up: async (ids) => uniq(await db.select({ id: goodsReceipts.orderId }).from(goodsReceipts).where(inArray(goodsReceipts.id, has(ids)))),
  },
  {
    // receipt ↔ bill: a bill's live lines billing the GRN's lines
    down: async (ids) =>
      uniq(
        await db
          .select({ id: purchaseBillLines.billId })
          .from(purchaseBillLines)
          .innerJoin(goodsReceiptLines, eq(goodsReceiptLines.id, purchaseBillLines.grnLineId))
          .where(and(inArray(goodsReceiptLines.receiptId, has(ids)), eq(purchaseBillLines.active, true))),
      ),
    up: async (ids) =>
      uniq(
        await db
          .select({ id: goodsReceiptLines.receiptId })
          .from(purchaseBillLines)
          .innerJoin(goodsReceiptLines, eq(goodsReceiptLines.id, purchaseBillLines.grnLineId))
          .where(and(inArray(purchaseBillLines.billId, has(ids)), eq(purchaseBillLines.active, true))),
      ),
  },
  {
    // bill ↔ payment: allocations in force
    down: async (ids) =>
      uniq(
        await db
          .select({ id: vendorAllocations.paymentId })
          .from(vendorAllocations)
          .where(and(inArray(vendorAllocations.purchaseBillId, has(ids)), eq(vendorAllocations.active, true))),
      ),
    up: async (ids) =>
      uniq(
        await db
          .select({ id: vendorAllocations.purchaseBillId })
          .from(vendorAllocations)
          .where(and(inArray(vendorAllocations.paymentId, has(ids)), eq(vendorAllocations.active, true))),
      ),
  },
];

const docs = (rows: { id: number; number: string; status: string }[]): ChainDoc[] =>
  rows.map((r) => ({ id: r.id, number: r.number, cancelled: r.status === "cancelled" }));

/** The chain through one document: every step's documents, oldest first. */
export async function purchaseChain(step: ChainStep, id: number): Promise<Record<ChainStep, ChainDoc[]>> {
  const at = CHAIN_STEPS.indexOf(step);
  const ids: Ids[] = CHAIN_STEPS.map((_, i) => (i === at ? [id] : []));
  for (let i = at; i > 0 && ids[i].length; i--) ids[i - 1] = await LINKS[i - 1].up(ids[i]);
  for (let i = at; i < CHAIN_STEPS.length - 1 && ids[i].length; i++) ids[i + 1] = await LINKS[i].down(ids[i]);
  const pick = <T extends typeof materialRequests | typeof purchaseOrders | typeof goodsReceipts | typeof purchaseBills | typeof vendorPayments>(
    t: T,
    wanted: Ids,
  ) =>
    db
      .select({ id: t.id, number: t.number, status: t.status })
      .from(t as typeof purchaseOrders)
      .where(inArray(t.id, has(wanted)))
      .orderBy(asc(t.id));
  const [request, order, receipt, bill, payment] = await Promise.all([
    pick(materialRequests, ids[0]),
    pick(purchaseOrders, ids[1]),
    pick(goodsReceipts, ids[2]),
    pick(purchaseBills, ids[3]),
    pick(vendorPayments, ids[4]),
  ]);
  return { request: docs(request), order: docs(order), receipt: docs(receipt), bill: docs(bill), payment: docs(payment) };
}
