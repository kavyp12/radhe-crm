import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import {
  expenseCategories,
  goodsReceipts,
  jobs,
  purchaseBills,
  settings,
  stockAdjustments,
  stockIssues,
  stockItems,
  stockMoves,
  type StockSource,
} from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { registerExecutor, runOrRequest } from "@/lib/approvals";
import { gstBp, hsnSac } from "@/lib/categories";
import { formatDate } from "@/lib/dates";
import { checkBooksDate, post, setOpening } from "@/lib/ledger";
import { divRound, formatMoney, milliText, parseMoney, parseQty } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";
import { addMove, checkNotNegative, lockItems, outValue, pair, reverseMoves, type StockItem } from "@/lib/stock-moves";

// Stock (S17, A§9, D20, D51): items, opening stock, adjustments and the stock card. The move helpers (locking,
// valuing at the average, no negative stock) are in stock-moves.ts. Stock value, averages and rates only for
// can_view_cost users.

type Totals = { qty: bigint; value: bigint };

// ---- Items

/** The item form as typed. openingQty / openingRate: undefined = not shown (not owner / accountant with cost). */
export type ItemInput = {
  name: string;
  unit: string;
  categoryId: string;
  hsnSac: string;
  gstPercent: string;
  active?: boolean;
  openingQty?: string;
  openingRate?: string;
};

async function readItem(tx: Tx, input: ItemInput, current?: StockItem) {
  const name = formText(input.name, "name", 100);
  if (!name) throw new UserError("Enter the item's name.", "name");
  const [taken] = await tx.select({ id: stockItems.id }).from(stockItems).where(sql`lower(${stockItems.name}) = lower(${name})`);
  if (taken && taken.id !== current?.id) throw new UserError("There is already an item with this name.", "name");
  const unit = formText(input.unit, "unit", 20) ?? "Nos";
  const categoryId = Number(input.categoryId);
  const [category] = Number.isSafeInteger(categoryId)
    ? await tx.select().from(expenseCategories).where(eq(expenseCategories.id, categoryId))
    : [];
  if (!category || (!category.active && category.id !== current?.categoryId)) throw new UserError("Pick a category.", "categoryId");
  return {
    name,
    unit,
    categoryId,
    hsnSac: hsnSac(input.hsnSac),
    gstBp: input.gstPercent.trim() ? gstBp(input.gstPercent) : null,
  };
}

/** Opening stock as typed: qty (≥ 0) and rate (≥ 0). Owner / accountant who see cost only (D40, D51). */
function openingFrom(actor: SessionUser, input: ItemInput): { qty: bigint; rate: bigint } | undefined {
  if (input.openingQty === undefined) return undefined;
  if (!can(actor, "openingBalances", "edit") || !canViewCost(actor)) {
    throw new UserError("Only the owner or the accountant can set opening stock.", "openingQty");
  }
  const read = (text: string, field: string, parse: (s: string) => bigint, example: string) => {
    if (!text.trim()) return 0n;
    let v = -1n;
    try {
      v = parse(text);
    } catch {
      // below
    }
    if (v < 0n) throw new UserError(`Enter it like ${example}.`, field);
    return v;
  };
  return {
    qty: read(input.openingQty, "openingQty", parseQty, "10 or 2.5"),
    rate: read(input.openingRate ?? "", "openingRate", parseMoney, "1,250 or 99.50"),
  };
}

/**
 * Opening stock (A§3, D40): the old opening move and entry are reversed on their own date, the new ones posted on the
 * books start date — a move (source opening) + Dr stock / Cr opening_equity at qty × rate. Lock the item first.
 */
async function postOpeningStock(tx: Tx, item: StockItem, qty: bigint, rate: bigint) {
  const [s] = await tx.select({ date: settings.booksStartDate }).from(settings).where(eq(settings.id, 1));
  if (!s.date && qty !== 0n) {
    throw new UserError("Set the books start date in Settings first: opening stock is posted on it.", "openingQty");
  }
  const value = divRound(qty * rate, 1000n);
  await reverseMoves(tx, "opening", item.id);
  if (qty !== 0n) await addMove(tx, { itemId: item.id, date: s.date!, qty, value, source: "opening", sourceId: item.id });
  const doc = { type: "stock_items" as const, id: item.id, narration: `Opening stock: ${item.name}` };
  await setOpening(tx, doc, value, { account: "stock" }, { account: "opening_equity" });
  await checkNotNegative(tx, [item.id]);
}

export async function createItem(actor: SessionUser, input: ItemInput): Promise<number> {
  if (!can(actor, "stockItems", "create")) throw new Error("Not allowed");
  const opening = openingFrom(actor, input);
  return writeTx(actor, async (tx) => {
    const v = await readItem(tx, input);
    const [row] = await tx
      .insert(stockItems)
      .values({ ...v, openingQtyMilli: opening?.qty ?? 0n, openingRatePaise: opening?.rate ?? 0n, createdBy: actor.id })
      .returning();
    if (opening && opening.qty !== 0n) await postOpeningStock(tx, row, opening.qty, opening.rate);
    return row.id;
  });
}

export async function updateItem(actor: SessionUser, id: number, input: ItemInput): Promise<void> {
  if (!can(actor, "stockItems", "edit")) throw new Error("Not allowed");
  const opening = openingFrom(actor, input);
  await writeTx(actor, async (tx) => {
    const current = (await lockItems(tx, [id])).get(id);
    if (!current) throw new UserError("That item doesn't exist.");
    const v = await readItem(tx, input, current);
    const active = input.active ?? current.active;
    if (active !== current.active && !can(actor, "stockItems", "cancel")) throw new UserError("You can't deactivate an item.", "active");
    const qty = opening?.qty ?? current.openingQtyMilli;
    const rate = opening?.rate ?? current.openingRatePaise;
    const [row] = await tx
      .update(stockItems)
      .set({ ...v, active, openingQtyMilli: qty, openingRatePaise: rate })
      .where(eq(stockItems.id, id))
      .returning();
    if (qty !== current.openingQtyMilli || rate !== current.openingRatePaise) await postOpeningStock(tx, row, qty, rate);
  });
}

// ---- Stock adjustments (A§3, A§7): ± qty with a reason; the owner at once, the accountant through approval.

export type AdjustmentInput = { itemId: string; date: string; qty: string; rate: string; reason: string };

/** The adjustment as it would post now: a minus qty at the average; a plus qty at the average, or at the typed rate if the item has no stock. */
async function planAdjustment(tx: Tx, input: AdjustmentInput) {
  const itemId = Number(input.itemId);
  const item = Number.isSafeInteger(itemId) ? (await lockItems(tx, [itemId])).get(itemId) : undefined;
  if (!item) throw new UserError("Pick the item.", "itemId");
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  let qty = 0n;
  try {
    qty = parseQty(input.qty);
  } catch {
    throw new UserError("Enter the qty like 5, or -2.5 for less stock.", "qty");
  }
  if (qty === 0n) throw new UserError("Enter the qty to add (5) or take off (-5).", "qty");
  const reason = formText(input.reason, "reason", 500);
  if (!reason) throw new UserError("Say why the stock is adjusted.", "reason");

  let value: bigint;
  if (qty < 0n) value = -outValue(-qty, item);
  else if (item.qty > 0n) value = divRound(qty * item.value, item.qty);
  else {
    let rate = -1n;
    try {
      rate = input.rate.trim() ? parseMoney(input.rate) : -1n;
    } catch {
      // below
    }
    if (rate < 0n) throw new UserError(`${item.name} has no stock, so there is no average: enter the rate for this qty.`, "rate");
    value = divRound(qty * rate, 1000n);
  }
  return { item, date, qty, value, reason };
}

type Plan = Awaited<ReturnType<typeof planAdjustment>>;
const qtyText = (p: Pick<Plan, "qty" | "item">) => `${p.qty > 0n ? "+" : ""}${milliText(p.qty)} ${p.item.unit}`;

async function doAdjust(tx: Tx, actor: SessionUser, input: AdjustmentInput) {
  const a = await planAdjustment(tx, input);
  const number = await nextNumber(tx, "stock_adjustment", a.date);
  const [row] = await tx
    .insert(stockAdjustments)
    .values({ number, date: a.date, itemId: a.item.id, qtyMilli: a.qty, valuePaise: a.value, reason: a.reason, createdBy: actor.id })
    .returning({ id: stockAdjustments.id });
  await addMove(tx, { itemId: a.item.id, date: a.date, qty: a.qty, value: a.value, source: "adjustment", sourceId: row.id });
  // A§3: more stock → Dr stock / Cr cash_short_excess; less → the other way.
  const lines = pair(a.value, "stock", "cash_short_excess");
  if (lines.length) {
    await post(tx, {
      date: a.date,
      docType: "stock_adjustments",
      docId: row.id,
      number,
      narration: `Stock adjustment ${number} · ${a.item.name} ${qtyText(a)}: ${a.reason}`,
      lines,
    });
  }
  return { id: row.id, number };
}

type AdjustPayload = { input: AdjustmentInput };

registerExecutor<AdjustPayload>("stock_adjustment.create", {
  async describe(tx, p) {
    const a = await planAdjustment(tx, p.input);
    return {
      summary: `Stock adjustment: ${a.item.name} ${qtyText(a)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(a.date) },
        { label: "Qty", old: `${milliText(a.item.qty)} ${a.item.unit} in stock`, new: `${milliText(a.item.qty + a.qty)} ${a.item.unit}` },
        { label: "Value", old: null, new: `${formatMoney(a.value)} (at the average when requested)` },
        { label: "Reason", old: null, new: a.reason },
      ],
    };
  },
  run: (tx, owner, p) => doAdjust(tx, owner, p.input),
});

/** The owner adjusts at once; the accountant's adjustment becomes an approval request (A§7, A§8). */
export async function createStockAdjustment(actor: SessionUser, input: AdjustmentInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "stockAdjustment", "create")) throw new Error("Not allowed");
  const outcome = await runOrRequest(actor, "stock_adjustment.create", { input } satisfies AdjustPayload, input.reason);
  if (!outcome.done) return { id: null, message: outcome.message };
  const done = outcome.result as { id: number; number: string };
  return { id: done.id, message: `Saved ${done.number}.` };
}

// ---- Loaders. Values (stock value, average, rates) only for can_view_cost users: stripped here (hard rule 5, D51).

/** Average per unit (paise per 1 unit), or null without stock. */
const average = (t: Totals) => (t.qty > 0n ? divRound(t.value * 1000n, t.qty) : null);

const itemTotals = () =>
  db
    .select({
      itemId: stockMoves.itemId,
      qty: sql<string>`sum(${stockMoves.qtyMilli})`.as("qty"),
      value: sql<string>`sum(${stockMoves.valuePaise})`.as("value"),
    })
    .from(stockMoves)
    .groupBy(stockMoves.itemId)
    .as("totals");

export async function listItems(user: SessionUser) {
  const totals = itemTotals();
  const rows = await db
    .select({
      id: stockItems.id,
      name: stockItems.name,
      unit: stockItems.unit,
      category: expenseCategories.name,
      active: stockItems.active,
      qty: totals.qty,
      value: totals.value,
    })
    .from(stockItems)
    .innerJoin(expenseCategories, eq(expenseCategories.id, stockItems.categoryId))
    .leftJoin(totals, eq(totals.itemId, stockItems.id))
    .orderBy(asc(stockItems.name));
  return rows.map(({ value, ...r }) => {
    const t = { qty: BigInt(r.qty ?? 0), value: BigInt(value ?? 0) };
    const row = { ...r, qty: t.qty };
    return canViewCost(user) ? { ...row, cost: { value: t.value, average: average(t) } } : row;
  });
}

export const SOURCE_LABEL: Record<StockSource, string> = {
  opening: "Opening stock",
  purchase: "Purchase",
  grn: "Material receive",
  issue: "Issue to job",
  return: "Return from job",
  adjustment: "Adjustment",
};

/** An item with its stock card: every move with a running qty (and value for cost users), oldest first. */
export async function getItem(user: SessionUser, id: number) {
  const [row] = await db
    .select({ item: stockItems, category: expenseCategories.name })
    .from(stockItems)
    .innerJoin(expenseCategories, eq(expenseCategories.id, stockItems.categoryId))
    .where(eq(stockItems.id, id));
  if (!row) return undefined;
  const moves = await db
    .select({
      id: stockMoves.id,
      date: stockMoves.date,
      qty: stockMoves.qtyMilli,
      value: stockMoves.valuePaise,
      source: stockMoves.source,
      sourceId: stockMoves.sourceId,
      reverses: stockMoves.reversesMoveId,
      adjustment: stockAdjustments.number,
      bill: purchaseBills.number,
      issue: stockIssues.number,
      grn: goodsReceipts.number,
      job: jobs.number,
    })
    .from(stockMoves)
    .leftJoin(stockAdjustments, and(eq(stockMoves.source, "adjustment"), eq(stockAdjustments.id, stockMoves.sourceId)))
    .leftJoin(purchaseBills, and(eq(stockMoves.source, "purchase"), eq(purchaseBills.id, stockMoves.sourceId)))
    .leftJoin(stockIssues, and(inArray(stockMoves.source, ["issue", "return"]), eq(stockIssues.id, stockMoves.sourceId)))
    .leftJoin(goodsReceipts, and(eq(stockMoves.source, "grn"), eq(goodsReceipts.id, stockMoves.sourceId)))
    .leftJoin(jobs, eq(jobs.id, stockMoves.jobId))
    .where(eq(stockMoves.itemId, id))
    .orderBy(asc(stockMoves.date), asc(stockMoves.id));
  const cost = canViewCost(user);
  let qty = 0n;
  let value = 0n;
  const card = moves.map((m) => {
    qty += m.qty;
    value += m.value;
    const line = {
      id: m.id,
      date: m.date,
      source: m.source,
      sourceId: m.sourceId,
      reversal: m.reverses !== null,
      number: m.adjustment ?? m.bill ?? m.issue ?? m.grn,
      job: m.job,
      qty: m.qty,
      balance: qty,
    };
    return cost ? { ...line, cost: { value: m.value, balance: value } } : line;
  });
  const { openingRatePaise, ...item } = row.item;
  const totals = { qty, value };
  return {
    ...item,
    category: row.category,
    qty,
    moves: card,
    ...(cost ? { cost: { openingRatePaise, value, average: average(totals) } } : {}),
  };
}

/** Pick list for the adjustment form: active items with their qty (and average for cost users). */
export async function itemOptions(user: SessionUser) {
  return (await listItems(user)).filter((i) => i.active);
}

export async function listAdjustments(user: SessionUser) {
  const rows = await db
    .select({
      id: stockAdjustments.id,
      number: stockAdjustments.number,
      date: stockAdjustments.date,
      item: stockItems.name,
      itemId: stockItems.id,
      unit: stockItems.unit,
      qty: stockAdjustments.qtyMilli,
      value: stockAdjustments.valuePaise,
      reason: stockAdjustments.reason,
    })
    .from(stockAdjustments)
    .innerJoin(stockItems, eq(stockItems.id, stockAdjustments.itemId))
    .orderBy(desc(stockAdjustments.id));
  return rows.map(({ value, ...r }) => (canViewCost(user) ? { ...r, cost: { value } } : r));
}
