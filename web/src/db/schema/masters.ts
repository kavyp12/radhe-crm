import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { COST_BUCKETS } from "../../lib/cost-buckets"; // relative: drizzle-kit does not read tsconfig paths
import { users } from "./auth";
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

/**
 * Customers (A§2, S1). Never deleted: deactivated. The opening balance is what was typed (+Dr = they owe us,
 * −Cr = we owe them); lib/customers.ts posts it to the journal (D40). Audited.
 */
export const customers = pgTable("customers", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  firmName: text("firm_name"),
  mobile: text("mobile"),
  gstin: text("gstin"),
  stateCode: text("state_code").notNull().default("24"), // GSTIN's first 2 digits, or chosen when unregistered
  billingAddress: text("billing_address"),
  siteAddress: text("site_address"),
  creditLimitPaise: bigint("credit_limit_paise", { mode: "bigint" }), // null = no limit set
  creditDays: integer("credit_days"),
  isCreditCustomer: boolean("is_credit_customer").notNull().default(false),
  salesPersonId: text("sales_person_id").references(() => users.id),
  collectionPersonId: text("collection_person_id").references(() => users.id),
  openingBalancePaise: bigint("opening_balance_paise", { mode: "bigint" }).notNull().default(sql`0`),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Vendors / suppliers (A§2, S9). Opening balance as typed: + = we owe them (Cr), − = they owe us. Audited. */
export const vendors = pgTable("vendors", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  gstin: text("gstin"),
  stateCode: text("state_code").notNull().default("24"),
  mobile: text("mobile"),
  address: text("address"),
  creditDays: integer("credit_days"),
  openingBalancePaise: bigint("opening_balance_paise", { mode: "bigint" }).notNull().default(sql`0`),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** S4 categories (14 inserted by migration 0012). HSN/SAC and GST % wait for the client's CA (Q2). Audited. */
export const productCategories = pgTable("product_categories", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  hsnSac: text("hsn_sac"),
  gstBp: integer("gst_bp").notNull().default(1800),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * S10 categories (21 inserted by migration 0012), each posting to its own expense account; cost_bucket puts
 * job-tagged amounts into job costing (A§10, D41; none = overhead). Audited.
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull().unique(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .unique()
      .references(() => accounts.id),
    costBucket: text("cost_bucket", { enum: COST_BUCKETS }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "expense_categories_bucket_check",
      sql`${t.costBucket} in ('material', 'labour', 'printing', 'installation', 'transport', 'other', 'none')`,
    ),
  ],
);
