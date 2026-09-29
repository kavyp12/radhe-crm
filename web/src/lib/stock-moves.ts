import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { stockItems, stockMoves, type StockSource } from "@/db/schema";
import { UserError } from "@/lib/action";
import type { LineTarget, PostLine, SystemKey } from "@/lib/ledger";
import { divRound, milliText } from "@/lib/num";

// Stock moves (A§9, D20, D51, D52): the low-level helpers every stock document uses (opening, adjustment, purchase, issue).
// An item's qty and value are the sums of its moves; the average is never stored. Lock the items (lockItems) before
// valuing or adding their moves; moves are append-only, a cancel / edit adds the mirror move. No lib imports that lead
// back to approvals / settings, so Settings can move opening stock (moveOpeningStock).

type Q = Tx | typeof db;
export type StockItem = typeof stockItems.$inferSelect;
type Totals = { qty: bigint; value: bigint };

/** Σ qty / Σ value per item over all its moves. */
async function totalsOf(q: Q, ids: number[]): Promise<Map<number, Totals>> {
  if (!ids.length) return new Map();
  const rows = await q
    .select({
      itemId: stockMoves.itemId,
      qty: sql<string>`sum(${stockMoves.qtyMilli})`,
      value: sql<string>`sum(${stockMoves.valuePaise})`,
    })
    .from(stockMoves)
    .where(inArray(stockMoves.itemId, ids))
    .groupBy(stockMoves.itemId);
  return new Map(rows.map((r) => [r.itemId, { qty: BigInt(r.qty), value: BigInt(r.value) }]));
}

/**
 * Locks the items (id order, so two documents can't deadlock, D51) and returns each with its totals. Call it before
 * valuing or adding any move of these items in the transaction.
 */
export async function lockItems(tx: Tx, ids: number[]) {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (!unique.length) return new Map<number, StockItem & Totals>();
  const items = await tx.select().from(stockItems).where(inArray(stockItems.id, unique)).orderBy(asc(stockItems.id)).for("update");
  const totals = await totalsOf(tx, unique);
  return new Map(items.map((i) => [i.id, { ...i, ...(totals.get(i.id) ?? { qty: 0n, value: 0n }) }]));
}

/** A§9: the value of `qty` going out at the item's average. Refuses more than is in stock (D20). */
export function outValue(qty: bigint, item: Pick<StockItem, "name" | "unit"> & Totals): bigint {
  if (qty > item.qty) {
    const have = item.qty > 0n ? `Only ${milliText(item.qty)} ${item.unit}` : "Nothing";
    throw new UserError(`${have} of ${item.name} in stock: enter the purchase or an adjustment first.`);
  }
  return divRound(qty * item.value, item.qty);
}

export type NewMove = {
  itemId: number;
  date: string;
  qty: bigint;
  value: bigint;
  source: StockSource;
  sourceId: number;
  jobId?: number | null;
};

/** Adds one move; the caller has locked the item (lockItems) in this transaction. */
export async function addMove(tx: Tx, m: NewMove) {
  await tx.insert(stockMoves).values({
    itemId: m.itemId,
    date: m.date,
    qtyMilli: m.qty,
    valuePaise: m.value,
    source: m.source,
    sourceId: m.sourceId,
    jobId: m.jobId ?? null,
  });
}

const mirror = alias(stockMoves, "mirror");

/** A document's moves in force: not reversals, not reversed. */
export function liveMoves(q: Q, source: StockSource, sourceId: number) {
  return q
    .select({ move: stockMoves })
    .from(stockMoves)
    .leftJoin(mirror, eq(mirror.reversesMoveId, stockMoves.id))
    .where(and(eq(stockMoves.source, source), eq(stockMoves.sourceId, sourceId), isNull(stockMoves.reversesMoveId), isNull(mirror.id)))
    .orderBy(asc(stockMoves.id))
    .then((rows) => rows.map((r) => r.move));
}

/**
 * Mirrors a document's moves in force (−qty, −value) on each move's own date (D45): a cancel, or the first half of
 * an edit. Lock the items first. Returns the item ids touched.
 */
export async function reverseMoves(tx: Tx, source: StockSource, sourceId: number): Promise<number[]> {
  const moves = await liveMoves(tx, source, sourceId);
  for (const m of moves) {
    await tx.insert(stockMoves).values({
      itemId: m.itemId,
      date: m.date,
      qtyMilli: -m.qtyMilli,
      valuePaise: -m.valuePaise,
      source,
      sourceId,
      jobId: m.jobId,
      reversesMoveId: m.id,
    });
  }
  return moves.map((m) => m.itemId);
}

/** D20 / D51: after a document's moves, none of these items may be below zero. */
export async function checkNotNegative(tx: Tx, itemIds: number[]) {
  const ids = [...new Set(itemIds)];
  const totals = await totalsOf(tx, ids);
  const short = ids.filter((id) => (totals.get(id)?.qty ?? 0n) < 0n);
  if (!short.length) return;
  const [item] = await tx.select().from(stockItems).where(eq(stockItems.id, short[0]));
  const have = totals.get(item.id)!.qty;
  throw new UserError(
    `${item.name} would go below zero stock (${milliText(have)} ${item.unit}): part of it has been used or issued already.`,
  );
}

const later = alias(stockMoves, "later_move");

/**
 * The name of an item that has a move in force (not a reversal, not reversed) matching `where`, entered after the
 * document first moved that item — or undefined.
 */
async function movedSince(tx: Tx, source: StockSource, sourceId: number, itemIds: number[], where: SQL) {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return undefined;
  const [hit] = await tx
    .select({ name: stockItems.name })
    .from(later)
    .innerJoin(stockItems, eq(stockItems.id, later.itemId))
    .leftJoin(mirror, eq(mirror.reversesMoveId, later.id))
    .where(
      and(
        inArray(later.itemId, ids),
        where,
        isNull(later.reversesMoveId),
        isNull(mirror.id),
        sql`${later.id} > (select min(d.id) from stock_moves d where d.source = ${source} and d.source_id = ${sourceId} and d.item_id = ${later.itemId})`,
      ),
    )
    .limit(1);
  return hit?.name;
}

/**
 * D52: a document's stock can't be taken back (a cancel, or an edit that changes its stock lines) once any of that item
 * has gone out after the document first moved it — a later outgoing move still in force. Otherwise the value left
 * wouldn't match what is physically left (value stuck on zero qty). A later cancelled pair, or another document's
 * mirror move, took out exactly what it brought, so it doesn't count. Lock the items first.
 */
export async function checkNothingOutSince(tx: Tx, source: StockSource, sourceId: number, itemIds: number[], what: string) {
  const name = await movedSince(tx, source, sourceId, itemIds, sql`${later.qtyMilli} < 0`);
  if (name) {
    throw new UserError(
      `${name} has been used or issued since this ${what} was entered, so its stock can't be taken back: correct it with a stock adjustment instead.`,
    );
  }
}

/**
 * An issue to a job can't be cancelled once the job returned any of its items after it: the return was valued on that
 * issue (D53) and would outlive it. Cancel the return first.
 */
export async function checkNoReturnSince(tx: Tx, issueId: number, jobId: number, itemIds: number[]) {
  const name = await movedSince(tx, "issue", issueId, itemIds, and(eq(later.source, "return"), eq(later.jobId, jobId))!);
  if (name) throw new UserError(`${name} came back from this job after this issue: cancel that return first.`);
}

type Side = SystemKey | number | LineTarget;
const target = (s: Side): LineTarget => (typeof s === "object" ? s : { account: s });

/** Dr `a` / Cr `b` for a positive value, the other way for a negative one; nothing for zero. */
export function pair(value: bigint, a: Side, b: Side): PostLine[] {
  if (value === 0n) return [];
  return value > 0n
    ? [{ ...target(a), debit: value }, { ...target(b), credit: value }]
    : [{ ...target(b), debit: -value }, { ...target(a), credit: -value }];
}

/** The books start date moved (Settings, D43): opening stock moves go with it, like the opening entries. */
export async function moveOpeningStock(tx: Tx, date: string) {
  const moves = await tx
    .select({ move: stockMoves })
    .from(stockMoves)
    .leftJoin(mirror, eq(mirror.reversesMoveId, stockMoves.id))
    .where(and(eq(stockMoves.source, "opening"), ne(stockMoves.date, date), isNull(stockMoves.reversesMoveId), isNull(mirror.id)));
  for (const { move: m } of moves) {
    await lockItems(tx, [m.itemId]);
    await reverseMoves(tx, "opening", m.itemId);
    await addMove(tx, { itemId: m.itemId, date, qty: m.qtyMilli, value: m.valuePaise, source: "opening", sourceId: m.itemId });
  }
}

