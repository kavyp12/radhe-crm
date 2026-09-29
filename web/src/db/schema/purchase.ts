import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, check, date, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { stockItems } from "./masters";
import { jobs } from "./sales";

// Purchase / stock (A§2): stock moves and adjustments; purchase bills, vendor payments and expenses follow.

const stamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  // Also the version an approval request was made against (D44).
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const STOCK_SOURCES = ["opening", "purchase", "grn", "issue", "return", "adjustment"] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

/**
 * Stock moves (A§2, A§9): + in / − out, at a value. An item's qty and average come from its moves (never stored,
 * D51). Append-only like the journal (migration 0027): a cancel / edit adds the mirror move (reverses_move_id).
 * source_id = the document's id (opening: the item's own id).
 */
export const stockMoves = pgTable(
  "stock_moves",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    date: date("date").notNull(),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    valuePaise: bigint("value_paise", { mode: "bigint" }).notNull(),
    source: text("source", { enum: STOCK_SOURCES }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
    reversesMoveId: bigint("reverses_move_id", { mode: "number" })
      .unique() // a move is reversed at most once
      .references((): AnyPgColumn => stockMoves.id),
    createdBy: text("created_by")
      .notNull()
      .default(sql`nullif(current_setting('app.user_id', true), '')`)
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_moves_item_idx").on(t.itemId),
    index("stock_moves_source_idx").on(t.source, t.sourceId),
    check("stock_moves_qty_nonzero", sql`${t.qtyMilli} <> 0`),
    check("stock_moves_source_check", sql`${t.source} in ('opening', 'purchase', 'grn', 'issue', 'return', 'adjustment')`),
  ],
);

/** Stock adjustments (A§3, A§7): ± qty with a reason, valued at the average when posted. Numbered SA/. Audited. */
export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    valuePaise: bigint("value_paise", { mode: "bigint" }).notNull(), // as posted, ±
    reason: text("reason").notNull(),
    ...stamps(),
  },
  (t) => [index("stock_adjustments_item_idx").on(t.itemId), check("stock_adjustments_qty_nonzero", sql`${t.qtyMilli} <> 0`)],
);
