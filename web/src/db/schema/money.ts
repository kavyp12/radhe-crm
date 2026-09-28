import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, check, date, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { accounts, customers, vendors } from "./masters";
import { jobs } from "./sales";

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
