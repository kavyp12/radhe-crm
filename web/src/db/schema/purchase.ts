import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { RECEIPT_MODES } from "../../lib/receipt-modes"; // relative: drizzle-kit does not read tsconfig paths
import { users } from "./auth";
import { accounts, expenseCategories, openingBills, stockItems, vendors } from "./masters";
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

export const STOCK_ISSUE_KINDS = ["issue", "return"] as const;
export const STOCK_ISSUE_STATUSES = ["active", "cancelled"] as const;

/**
 * Stock issued to a job, or returned from it (S17, S11, A§3, D53): issues and returns share the SI/ series and post
 * when saved — an issue Dr materials_consumed (job) / Cr stock at the moving average, a return the other way at the
 * job's own issue average. Cancel = mirror moves + reversal on its own date. Audited.
 */
export const stockIssues = pgTable(
  "stock_issues",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    kind: text("kind", { enum: STOCK_ISSUE_KINDS }).notNull(),
    date: date("date").notNull(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id),
    notes: text("notes"),
    status: text("status", { enum: STOCK_ISSUE_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [
    index("stock_issues_job_idx").on(t.jobId),
    check("stock_issues_kind_check", sql`${t.kind} in ('issue', 'return')`),
    check("stock_issues_status_check", sql`${t.status} in ('active', 'cancelled')`),
  ],
);

/** An issue's / return's lines: each item once, the qty and the value it moved at (as posted; cost users only). */
export const stockIssueLines = pgTable(
  "stock_issue_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => stockIssues.id),
    position: integer("position").notNull(),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    valuePaise: bigint("value_paise", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stock_issue_lines_item_idx").on(t.issueId, t.itemId),
    check("stock_issue_lines_qty_positive", sql`${t.qtyMilli} > 0`),
  ],
);

export const MATERIAL_REQUEST_STATUSES = ["pending", "approved", "rejected", "ordered", "cancelled"] as const;

/**
 * Material requests (S18, A§8, D53): what the workshop needs, numbered MR/ when saved. Pending → Approved / Rejected
 * (the owner, with an optional note) → Ordered once a purchase order is made from it; its maker may cancel it while
 * pending. Never posts. Audited.
 */
export const materialRequests = pgTable(
  "material_requests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    neededBy: date("needed_by").notNull(),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
    notes: text("notes"),
    status: text("status", { enum: MATERIAL_REQUEST_STATUSES }).notNull().default("pending"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    ...stamps(),
  },
  (t) => [
    index("material_requests_status_idx").on(t.status),
    check("material_requests_status_check", sql`${t.status} in ('pending', 'approved', 'rejected', 'ordered', 'cancelled')`),
  ],
);

/** A request's lines: a stock item and the qty wanted (never changed: a wrong request is cancelled). */
export const materialRequestLines = pgTable(
  "material_request_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    requestId: bigint("request_id", { mode: "number" })
      .notNull()
      .references(() => materialRequests.id),
    position: integer("position").notNull(),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("material_request_lines_request_idx").on(t.requestId), check("material_request_lines_qty_positive", sql`${t.qtyMilli} > 0`)],
);

export const PURCHASE_ORDER_STATUSES = ["draft", "sent", "cancelled"] as const;

/**
 * Purchase orders (S18, A§8, D36, D53): numbered PO/ when saved; never posted. Draft → Sent (→ Partly received →
 * Received, computed from the GRNs in T23); cancelled only while nothing is received; editable until the first GRN.
 * vendor_state_code as for bills (ours → CGST + SGST, else IGST). Purchase rates: can_view_cost users only. Audited.
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    vendorId: bigint("vendor_id", { mode: "number" })
      .notNull()
      .references(() => vendors.id),
    vendorStateCode: text("vendor_state_code").notNull(),
    totalPaise: bigint("total_paise", { mode: "bigint" }).notNull(),
    status: text("status", { enum: PURCHASE_ORDER_STATUSES }).notNull().default("draft"),
    notes: text("notes"),
    shareToken: text("share_token").notNull().unique(), // public /share/<token> link to the PDF (D07)
    ...stamps(),
  },
  (t) => [
    index("purchase_orders_vendor_idx").on(t.vendorId),
    check("purchase_orders_status_check", sql`${t.status} in ('draft', 'sent', 'cancelled')`),
  ],
);

/**
 * A PO's lines: a stock item, qty × rate, GST %, and the request line it was copied from (if any). Never deleted: an
 * edit deactivates the old lines and adds new ones (the PO's lines = its active ones).
 */
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    position: integer("position").notNull(),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    description: text("description"),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    ratePaise: bigint("rate_paise", { mode: "bigint" }).notNull(),
    gstBp: integer("gst_bp").notNull(),
    requestLineId: bigint("request_line_id", { mode: "number" }).references(() => materialRequestLines.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchase_order_lines_order_idx").on(t.orderId),
    index("purchase_order_lines_request_line_idx").on(t.requestLineId),
    check("purchase_order_lines_qty_positive", sql`${t.qtyMilli} > 0`),
    check("purchase_order_lines_rate_check", sql`${t.ratePaise} >= 0`),
    check("purchase_order_lines_gst_check", sql`${t.gstBp} between 0 and 10000`),
  ],
);

export const GOODS_RECEIPT_STATUSES = ["active", "cancelled"] as const;

/**
 * Material receive / GRN (S18, A§3, D21, D53): goods received against a purchase order, numbered GRN/ and posted when
 * saved — Dr stock / Cr grn_clearing at the PO rate (excl. GST), with stock moves at that value. A bill made from it
 * clears grn_clearing. Cancel only while unbilled and none of its stock has gone out (D52). Audited.
 */
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => purchaseOrders.id),
    notes: text("notes"),
    status: text("status", { enum: GOODS_RECEIPT_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [index("goods_receipts_order_idx").on(t.orderId), check("goods_receipts_status_check", sql`${t.status} in ('active', 'cancelled')`)],
);

/** A GRN's lines: a PO line received, its qty, the PO rate and the value posted (qty × rate, excl. GST). */
export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    receiptId: bigint("receipt_id", { mode: "number" })
      .notNull()
      .references(() => goodsReceipts.id),
    position: integer("position").notNull(),
    orderLineId: bigint("order_line_id", { mode: "number" })
      .notNull()
      .references(() => purchaseOrderLines.id),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => stockItems.id),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    ratePaise: bigint("rate_paise", { mode: "bigint" }).notNull(),
    valuePaise: bigint("value_paise", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("goods_receipt_lines_receipt_idx").on(t.receiptId),
    index("goods_receipt_lines_order_line_idx").on(t.orderLineId),
    check("goods_receipt_lines_qty_positive", sql`${t.qtyMilli} > 0`),
  ],
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
    index("purchase_bills_date_idx").on(t.date), // T42: "today / this month" figures filter by date
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
    // Billed from a GRN line (T23): its stock came in with the GRN, so the line clears grn_clearing instead.
    grnLineId: bigint("grn_line_id", { mode: "number" }).references(() => goodsReceiptLines.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchase_bill_lines_bill_idx").on(t.billId),
    index("purchase_bill_lines_job_idx").on(t.jobId),
    index("purchase_bill_lines_grn_line_idx").on(t.grnLineId),
    check("purchase_bill_lines_grn_on_item", sql`${t.grnLineId} is null or ${t.stockItemId} is not null`),
    check("purchase_bill_lines_one_kind", sql`num_nonnulls(${t.stockItemId}, ${t.expenseCategoryId}) = 1`),
    check("purchase_bill_lines_job_on_expense", sql`${t.jobId} is null or ${t.expenseCategoryId} is not null`),
    check("purchase_bill_lines_qty_positive", sql`${t.qtyMilli} > 0`),
    check("purchase_bill_lines_rate_check", sql`${t.ratePaise} >= 0`),
    check("purchase_bill_lines_gst_check", sql`${t.gstBp} between 0 and 10000`),
  ],
);

export const VENDOR_PAYMENT_STATUSES = ["active", "cancelled"] as const;

/**
 * Vendor payments (S9, A§3): money paid to a vendor, numbered VP/ and posted on save (Dr ap / Cr money account). The
 * mode picks the money account as for receipts (D49). Edit / cancel: the owner at once, anyone else through approval
 * (A§7). Audited.
 */
export const vendorPayments = pgTable(
  "vendor_payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    vendorId: bigint("vendor_id", { mode: "number" })
      .notNull()
      .references(() => vendors.id),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    mode: text("mode", { enum: RECEIPT_MODES }).notNull(),
    moneyAccountId: bigint("money_account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    reference: text("reference"), // UTR / transaction id
    chequeNo: text("cheque_no"),
    chequeDate: date("cheque_date"),
    notes: text("notes"),
    status: text("status", { enum: VENDOR_PAYMENT_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [
    index("vendor_payments_vendor_idx").on(t.vendorId),
    index("vendor_payments_date_idx").on(t.date), // T42: "today / this month" figures filter by date
    check("vendor_payments_amount_positive", sql`${t.amountPaise} > 0`),
    check("vendor_payments_mode_check", sql`${t.mode} in ('cash', 'upi', 'bank', 'cheque')`),
    check("vendor_payments_status_check", sql`${t.status} in ('active', 'cancelled')`),
  ],
);

/**
 * Which payment pays which bill (A§2, D49, D51): never posted, never deleted — a change deactivates the old rows and
 * adds new ones. What a payment doesn't allocate is on account. Audited.
 */
export const vendorAllocations = pgTable(
  "vendor_allocations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    paymentId: bigint("payment_id", { mode: "number" })
      .notNull()
      .references(() => vendorPayments.id),
    purchaseBillId: bigint("purchase_bill_id", { mode: "number" }).references(() => purchaseBills.id),
    openingBillId: bigint("opening_bill_id", { mode: "number" }).references(() => openingBills.id), // T43
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    active: boolean("active").notNull().default(true),
    ...stamps(),
  },
  (t) => [
    index("vendor_allocations_payment_idx").on(t.paymentId),
    index("vendor_allocations_bill_idx").on(t.purchaseBillId),
    index("vendor_allocations_opening_bill_idx").on(t.openingBillId),
    check("vendor_allocations_amount_positive", sql`${t.amountPaise} > 0`),
    check("vendor_allocations_one_target", sql`num_nonnulls(${t.purchaseBillId}, ${t.openingBillId}) = 1`),
  ],
);

export const EXPENSE_STATUSES = ["active", "cancelled"] as const;

/**
 * Expenses (S10, A§2, A§3, D51): paid straight from a money account, numbered EX/ and posted on save — Dr the
 * category's expense account (with the job, if tagged) / Cr the money account. No GST split. Edit = reverse + repost,
 * cancel = reverse on its date. Audited.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    categoryId: bigint("category_id", { mode: "number" })
      .notNull()
      .references(() => expenseCategories.id),
    vendorId: bigint("vendor_id", { mode: "number" }).references(() => vendors.id),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    mode: text("mode", { enum: RECEIPT_MODES }).notNull(),
    moneyAccountId: bigint("money_account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    notes: text("notes"),
    status: text("status", { enum: EXPENSE_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [
    index("expenses_category_idx").on(t.categoryId),
    index("expenses_date_idx").on(t.date), // T42: "today / this month" figures filter by date
    index("expenses_job_idx").on(t.jobId),
    check("expenses_amount_positive", sql`${t.amountPaise} > 0`),
    check("expenses_mode_check", sql`${t.mode} in ('cash', 'upi', 'bank', 'cheque')`),
    check("expenses_status_check", sql`${t.status} in ('active', 'cancelled')`),
  ],
);
