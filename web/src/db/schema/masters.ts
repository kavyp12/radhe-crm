import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { attachments } from "./control";

/**
 * Company settings (A§2): exactly one row (id 1), created by migration 0004. Everything starts empty except the
 * company state code '24' (A§4); the real details arrive with Q3.
 */
export const settings = pgTable(
  "settings",
  {
    id: smallint("id").primaryKey().default(1),
    companyName: text("company_name"),
    address: text("address"),
    gstin: text("gstin"),
    stateCode: text("state_code").notNull().default("24"),
    phone: text("phone"),
    email: text("email"),
    bankDetails: text("bank_details"),
    upiId: text("upi_id"),
    logoAttachmentId: bigint("logo_attachment_id", { mode: "number" }).references(() => attachments.id),
    signatureAttachmentId: bigint("signature_attachment_id", { mode: "number" }).references(() => attachments.id),
    invoiceTerms: text("invoice_terms"),
    discountLimitBp: integer("discount_limit_bp"),
    backdateDays: integer("backdate_days"),
    defaultCreditDays: integer("default_credit_days"),
    booksStartDate: date("books_start_date"), // every opening balance posts on this date (D40)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

/**
 * Chart of accounts (A§3). The system accounts come from migration 0006 and are found by system_key; each expense
 * category adds its own expense account (T09). Money accounts can be renamed; code and system_key never change.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    systemKey: text("system_key").unique(), // null for expense category accounts
    isMoney: boolean("is_money").notNull().default(false),
    // Money accounts: the opening balance as entered (+Dr / −Cr); lib/ledger.ts setOpening() posts it (D40).
    openingBalancePaise: bigint("opening_balance_paise", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("accounts_type_check", sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`)],
);
