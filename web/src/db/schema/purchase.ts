import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { expenseCategories, stockItems, vendors } from "./masters";
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

export const PURCHASE_BILL_STATUSES = ["active", "cancelled"] as const;

/**
 * Purchase bills (S9, A§2, D51): numbered PB/ and posted when saved. The vendor's bill no is unique per vendor among
 * live bills (a cancelled one frees it). vendor_state_code is the vendor's state when saved: ours → CGST + SGST,
 * else IGST (A§4). Edit = reverse + repost, cancel = reverse on the bill date. Payment status is computed (A§5). Audited.
 */
export const purchaseBills = pgTable(
  "purchase_bills",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    vendorId: bigint("vendor_id", { mode: "number" })
      .notNull()
      .references(() => vendors.id),
    vendorBillNo: text("vendor_bill_no").notNull(),
    date: date("date").notNull(), // the bill date
    dueDate: date("due_date").notNull(), // date + the vendor's credit days
    vendorStateCode: text("vendor_state_code").notNull(),
    roundOffPaise: bigint("round_off_paise", { mode: "bigint" }).notNull().default(sql`0`),
    totalPaise: bigint("total_paise", { mode: "bigint" }).notNull(),
    status: text("status", { enum: PURCHASE_BILL_STATUSES }).notNull().default("active"),
    notes: text("notes"),
    ...stamps(),
  },
  (t) => [
    index("purchase_bills_vendor_idx").on(t.vendorId),
    uniqueIndex("purchase_bills_vendor_bill_no_idx")
      .on(t.vendorId, sql`upper(${t.vendorBillNo})`)
      .where(sql`${t.status} <> 'cancelled'`),
    check("purchase_bills_total_positive", sql`${t.totalPaise} > 0`),
    check("purchase_bills_round_off_check", sql`${t.roundOffPaise} between -100 and 100`),
    check("purchase_bills_status_check", sql`${t.status} in ('active', 'cancelled')`),
  ],
);

/**
 * A bill's lines: a stock item OR an expense category, qty × rate (taxable), GST %; a job only on an expense line
 * (D51). Never deleted: an edit deactivates the old lines and adds new ones (the bill's lines = its active ones).
 */
export const purchaseBillLines = pgTable(
  "purchase_bill_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    billId: bigint("bill_id", { mode: "number" })
      .notNull()
      .references(() => purchaseBills.id),
    position: integer("position").notNull(),
    stockItemId: bigint("stock_item_id", { mode: "number" }).references(() => stockItems.id),
    expenseCategoryId: bigint("expense_category_id", { mode: "number" }).references(() => expenseCategories.id),
    description: text("description"),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    ratePaise: bigint("rate_paise", { mode: "bigint" }).notNull(),
    gstBp: integer("gst_bp").notNull(),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchase_bill_lines_bill_idx").on(t.billId),
    index("purchase_bill_lines_job_idx").on(t.jobId),
    check("purchase_bill_lines_one_kind", sql`num_nonnulls(${t.stockItemId}, ${t.expenseCategoryId}) = 1`),
    check("purchase_bill_lines_job_on_expense", sql`${t.jobId} is null or ${t.expenseCategoryId} is not null`),
    check("purchase_bill_lines_qty_positive", sql`${t.qtyMilli} > 0`),
    check("purchase_bill_lines_rate_check", sql`${t.ratePaise} >= 0`),
    check("purchase_bill_lines_gst_check", sql`${t.gstBp} between 0 and 10000`),
  ],
);
