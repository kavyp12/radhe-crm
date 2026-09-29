import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { RECEIPT_MODES } from "../../lib/receipt-modes"; // relative: drizzle-kit does not read tsconfig paths
import { users } from "./auth";
import { accounts, customers, productCategories } from "./masters";

// Sales documents (A§2): quotation → job → invoice. Lines copy from one to the next (R0); every line has the same
// columns (A§2 quotation_lines). Amount = qty × rate − discount (A§4, D46); W × H is the board size, printed only.

/** The columns every sales line has. */
const lineColumns = () => ({
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  position: integer("position").notNull(), // 1, 2, 3 … as shown
  categoryId: bigint("category_id", { mode: "number" })
    .notNull()
    .references(() => productCategories.id),
  description: text("description"),
  hsnSac: text("hsn_sac"),
  widthMilli: bigint("width_milli", { mode: "bigint" }), // feet, thousandths
  heightMilli: bigint("height_milli", { mode: "bigint" }),
  qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
  unit: text("unit").notNull(),
  ratePaise: bigint("rate_paise", { mode: "bigint" }).notNull(),
  discountPaise: bigint("discount_paise", { mode: "bigint" }).notNull().default(sql`0`),
  gstBp: integer("gst_bp").notNull(),
});

const stamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  // Also the version an approval request was made against (D44): a request for an older version is refused.
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const QUOTATION_STATUSES = ["draft", "sent", "approved", "cancelled"] as const;

/** Quotations (S2): numbered on first save (A§6). Only draft and sent ones can be edited. Audited. */
export const quotations = pgTable(
  "quotations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    placeOfSupply: text("place_of_supply").notNull(), // the customer's state when saved (A§4)
    status: text("status", { enum: QUOTATION_STATUSES }).notNull().default("draft"),
    totalPaise: bigint("total_paise", { mode: "bigint" }).notNull(), // grand total of the lines, for lists
    terms: text("terms"),
    notes: text("notes"),
    shareToken: text("share_token").notNull().unique(), // public /share/<token> link to the PDF (D07)
    ...stamps(),
  },
  (t) => [
    index("quotations_customer_idx").on(t.customerId),
    check("quotations_status_check", sql`${t.status} in ('draft', 'sent', 'approved', 'cancelled')`),
  ],
);

export const quotationLines = pgTable(
  "quotation_lines",
  {
    quotationId: bigint("quotation_id", { mode: "number" })
      .notNull()
      .references(() => quotations.id),
    ...lineColumns(),
  },
  (t) => [index("quotation_lines_doc_idx").on(t.quotationId)],
);

export const JOB_STATUSES = ["in_production", "ready", "delivered", "invoiced", "cancelled"] as const;

/**
 * Jobs / work orders (S2, S3): RDS-YYYY-NNNNN by the job date's calendar year (D16). From an approved quotation (lines
 * copied, one job per quotation — D46) or blank. Invoiced is set only by issuing an invoice. Audited.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    quotationId: bigint("quotation_id", { mode: "number" }).references(() => quotations.id),
    placeOfSupply: text("place_of_supply").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("in_production"),
    totalPaise: bigint("total_paise", { mode: "bigint" }).notNull(),
    siteAddress: text("site_address"),
    siteReference: text("site_reference"),
    vehicleNo: text("vehicle_no"),
    salesPersonId: text("sales_person_id").references(() => users.id),
    targetDate: date("target_date"),
    notes: text("notes"),
    ...stamps(),
  },
  (t) => [
    index("jobs_customer_idx").on(t.customerId),
    // One live job per quotation (D46); a cancelled job frees the quotation for a new one.
    uniqueIndex("jobs_quotation_live_idx").on(t.quotationId).where(sql`${t.status} <> 'cancelled'`),
    check(
      "jobs_status_check",
      sql`${t.status} in ('in_production', 'ready', 'delivered', 'invoiced', 'cancelled')`,
    ),
  ],
);

export const jobLines = pgTable(
  "job_lines",
  {
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id),
    ...lineColumns(),
    quotationLineId: bigint("quotation_line_id", { mode: "number" }).references(() => quotationLines.id),
  },
  (t) => [index("job_lines_doc_idx").on(t.jobId)],
);

/** Every status a job moved to, with who and when (T11). Append-only. */
export const jobStatusHistory = pgTable(
  "job_status_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id),
    fromStatus: text("from_status", { enum: JOB_STATUSES }), // null = created
    toStatus: text("to_status", { enum: JOB_STATUSES }).notNull(),
    // Stamped by the DB from app.user_id (writeTx), like the journal.
    changedBy: text("changed_by")
      .notNull()
      .default(sql`nullif(current_setting('app.user_id', true), '')`)
      .references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_status_history_job_idx").on(t.jobId, t.id)],
);

export const INVOICE_KINDS = ["tax", "estimate"] as const;
export const INVOICE_STATUSES = ["draft", "issued", "cancelled"] as const;

/**
 * Tax invoices and estimates (S5, A§2–§6). Numbered at Issue (RDS/… or EST/…, D44), which also posts the journal
 * entry; issued invoices are frozen, a cancel reverses the entry and keeps the number. Payment status is never stored
 * (hard rule 6, T13). Audited.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: INVOICE_KINDS }).notNull(),
    number: text("number").unique(), // null while a draft
    date: date("date").notNull(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    placeOfSupply: text("place_of_supply").notNull(), // the customer's state (A§4)
    dueDate: date("due_date").notNull(), // date + the customer's credit days
    status: text("status", { enum: INVOICE_STATUSES }).notNull().default("draft"),
    totalPaise: bigint("total_paise", { mode: "bigint" }).notNull(), // grand total after round-off
    roundOffPaise: bigint("round_off_paise", { mode: "bigint" }).notNull(),
    terms: text("terms"),
    notes: text("notes"),
    shareToken: text("share_token").notNull().unique(),
    ...stamps(),
  },
  (t) => [
    index("invoices_customer_idx").on(t.customerId),
    check("invoices_kind_check", sql`${t.kind} in ('tax', 'estimate')`),
    check("invoices_status_check", sql`${t.status} in ('draft', 'issued', 'cancelled')`),
    check("invoices_number_when_issued", sql`${t.status} = 'draft' or ${t.number} is not null`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    invoiceId: bigint("invoice_id", { mode: "number" })
      .notNull()
      .references(() => invoices.id),
    ...lineColumns(),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
    quotationLineId: bigint("quotation_line_id", { mode: "number" }).references(() => quotationLines.id),
  },
  (t) => [
    index("invoice_lines_doc_idx").on(t.invoiceId),
    index("invoice_lines_job_idx").on(t.jobId),
    index("invoice_lines_quotation_line_idx").on(t.quotationLineId),
  ],
);

export const RECEIPT_STATUSES = ["active", "cancelled"] as const;

/**
 * Money received from a customer (S6, A§2). Numbered RC/… on save (A§6) and posted in the same transaction:
 * Dr money account / Cr ar (A§3). A cancel reverses the entry on the receipt's date (D45). Audited.
 */
export const receipts = pgTable(
  "receipts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    mode: text("mode", { enum: RECEIPT_MODES }).notNull(),
    moneyAccountId: bigint("money_account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    reference: text("reference"), // UTR / transaction id
    chequeNo: text("cheque_no"),
    chequeDate: date("cheque_date"),
    receivedBy: text("received_by").references(() => users.id),
    notes: text("notes"),
    status: text("status", { enum: RECEIPT_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [
    index("receipts_customer_idx").on(t.customerId),
    check("receipts_amount_positive", sql`${t.amountPaise} > 0`),
    check("receipts_mode_check", sql`${t.mode} in ('cash', 'upi', 'bank', 'cheque')`),
    check("receipts_status_check", sql`${t.status} in ('active', 'cancelled')`),
  ],
);

/**
 * Links money to what it pays (A§2): one source (a receipt) → one target (an invoice). A receipt's unallocated
 * remainder is on-account advance. Allocations never post (A§3) and are never deleted: a change deactivates the old
 * rows and adds new ones (D49). Open amounts count only active rows from sources that aren't cancelled. Audited.
 */
export const allocations = pgTable(
  "allocations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    receiptId: bigint("receipt_id", { mode: "number" }).references(() => receipts.id),
    invoiceId: bigint("invoice_id", { mode: "number" }).references(() => invoices.id),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    active: boolean("active").notNull().default(true),
    ...stamps(),
  },
  (t) => [
    index("allocations_receipt_idx").on(t.receiptId),
    index("allocations_invoice_idx").on(t.invoiceId),
    check("allocations_amount_positive", sql`${t.amountPaise} > 0`),
    check("allocations_one_source", sql`num_nonnulls(${t.receiptId}) = 1`),
    check("allocations_one_target", sql`num_nonnulls(${t.invoiceId}) = 1`),
  ],
);
