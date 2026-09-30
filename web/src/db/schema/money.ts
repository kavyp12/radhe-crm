import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, check, date, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { accounts, customers, vendors } from "./masters";
import { jobs } from "./sales";

const stamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  // Also the version an approval request was made against (D44).
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * The journal (A§3, D14): each money-moving document posts one balanced entry through lib/ledger.ts post(), the
 * only code that inserts here (hard rule 2). Migration 0006 checks balance at commit and makes both tables
 * append-only; a change is a reversing entry. Not audited: rows never change and carry created_by.
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    date: date("date").notNull(),
    // The posting document's number (D32); a reversal repeats it. Null for opening balances.
    number: text("number"),
    // The row that posted it: its table and id ("invoices", 12). Opening balances: the master row ("customers", 7).
    docType: text("doc_type").notNull(),
    docId: bigint("doc_id", { mode: "number" }).notNull(),
    narration: text("narration"),
    reversesEntryId: bigint("reverses_entry_id", { mode: "number" })
      .unique() // an entry is reversed at most once
      .references((): AnyPgColumn => journalEntries.id),
    // Stamped by the DB from app.user_id (writeTx); no user, no entry.
    createdBy: text("created_by")
      .notNull()
      .default(sql`nullif(current_setting('app.user_id', true), '')`)
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("journal_entries_doc_idx").on(t.docType, t.docId), index("journal_entries_date_idx").on(t.date)],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => journalEntries.id),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    debitPaise: bigint("debit_paise", { mode: "bigint" }).notNull().default(sql`0`),
    creditPaise: bigint("credit_paise", { mode: "bigint" }).notNull().default(sql`0`),
    // Sub-ledgers.
    customerId: bigint("customer_id", { mode: "number" }).references(() => customers.id),
    vendorId: bigint("vendor_id", { mode: "number" }).references(() => vendors.id),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
  },
  (t) => [
    check(
      "journal_lines_one_side",
      sql`${t.debitPaise} >= 0 and ${t.creditPaise} >= 0 and (${t.debitPaise} > 0) <> (${t.creditPaise} > 0)`,
    ),
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.accountId),
    index("journal_lines_customer_idx").on(t.customerId),
    index("journal_lines_vendor_idx").on(t.vendorId),
    index("journal_lines_job_idx").on(t.jobId),
  ],
);

/**
 * A public statement link (D49): the random token opens this customer's (or vendor's, T19) statement for the range as
 * a PDF, and nothing else (/share/<token>). The figures are read from the journal when it is opened. Audited.
 */
export const statementLinks = pgTable(
  "statement_links",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    token: text("token").notNull().unique(),
    customerId: bigint("customer_id", { mode: "number" }).references(() => customers.id),
    vendorId: bigint("vendor_id", { mode: "number" }).references(() => vendors.id),
    fromDate: date("from_date"), // null = from the first entry
    toDate: date("to_date"), // null = up to the day it is opened
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => [check("statement_links_one_party", sql`num_nonnulls(${t.customerId}, ${t.vendorId}) = 1`)],
);

export const ADJUSTMENT_KINDS = ["journal", "write_off", "discount", "refund"] as const;
export const ADJUSTMENT_STATUSES = ["active", "cancelled"] as const;

/**
 * Adjustment entries (JV, S22, A§3, D55): numbered JV/ and posted as entered. A customer adjustment (write-off,
 * settlement discount, refund of customer credit) is a guided JV for one customer; its allocations settle invoices /
 * debit notes (write-off, discount) or use up on-account money (refund). No edit: cancel = reverse. Audited.
 */
export const adjustments = pgTable(
  "adjustments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    date: date("date").notNull(),
    kind: text("kind", { enum: ADJUSTMENT_KINDS }).notNull(),
    customerId: bigint("customer_id", { mode: "number" }).references(() => customers.id), // customer adjustments
    narration: text("narration").notNull(),
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(), // Σ debits = Σ credits, as posted
    status: text("status", { enum: ADJUSTMENT_STATUSES }).notNull().default("active"),
    ...stamps(),
  },
  (t) => [
    index("adjustments_customer_idx").on(t.customerId),
    check("adjustments_amount_positive", sql`${t.amountPaise} > 0`),
    check("adjustments_kind_check", sql`${t.kind} in ('journal', 'write_off', 'discount', 'refund')`),
    check("adjustments_status_check", sql`${t.status} in ('active', 'cancelled')`),
    check("adjustments_customer_kinds", sql`(${t.kind} = 'journal') = (${t.customerId} is null)`),
  ],
);

/** A JV's lines as entered (and posted): never changed or deleted. */
export const adjustmentLines = pgTable(
  "adjustment_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    adjustmentId: bigint("adjustment_id", { mode: "number" })
      .notNull()
      .references(() => adjustments.id),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    debitPaise: bigint("debit_paise", { mode: "bigint" }).notNull().default(sql`0`),
    creditPaise: bigint("credit_paise", { mode: "bigint" }).notNull().default(sql`0`),
    customerId: bigint("customer_id", { mode: "number" }).references(() => customers.id),
    vendorId: bigint("vendor_id", { mode: "number" }).references(() => vendors.id),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id),
  },
  (t) => [
    index("adjustment_lines_adjustment_idx").on(t.adjustmentId),
    check(
      "adjustment_lines_one_side",
      sql`${t.debitPaise} >= 0 and ${t.creditPaise} >= 0 and (${t.debitPaise} > 0) <> (${t.creditPaise} > 0)`,
    ),
  ],
);
