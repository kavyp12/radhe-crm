import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { customers, productCategories } from "./masters";
import { jobs } from "./sales";

// Print jobs (P1–P10, A§11, D19, D64): every print on a Radhe machine becomes a CRM entry.

const stamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Printing machines (A§2): the Windows printer names that feed each one (the agent's printer → machine map) and the
 * rates per sq ft — sale for new print jobs, cost for print jobs on an existing job (cost: can_view_cost only). Blank
 * until Q7. Never deleted: deactivated. Audited.
 */
export const machines = pgTable(
  "machines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull().unique(),
    printerNames: text("printer_names").array().notNull().default(sql`'{}'`),
    saleRatePaise: bigint("sale_rate_paise", { mode: "bigint" }),
    costRatePaise: bigint("cost_rate_paise", { mode: "bigint" }),
    active: boolean("active").notNull().default(true),
    ...stamps(),
  },
  (t) => [
    check("machines_sale_rate_check", sql`${t.saleRatePaise} is null or ${t.saleRatePaise} >= 0`),
    check("machines_cost_rate_check", sql`${t.costRatePaise} is null or ${t.costRatePaise} >= 0`),
  ],
);

/** Printing types (flex, vinyl, UV …): the product category a billed print job's invoice line takes (optional). Audited. */
export const printingTypes = pgTable("printing_types", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  categoryId: bigint("category_id", { mode: "number" }).references(() => productCategories.id),
  active: boolean("active").notNull().default(true),
  ...stamps(),
});

/**
 * A PC running the Radhe print agent (A§11, D64, T39). It signs every /api/agent/* call with its token; only the
 * token's SHA-256 is stored. Revoked = its token stops working at once. Never deleted. Audited (not last_seen_at).
 */
export const printDevices = pgTable("print_devices", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id), // the owner whose pairing code it used
});

/** A one-time pairing code the owner makes in Settings → Devices: 10 minutes, single use; only its SHA-256 is kept. */
export const pairingCodes = pgTable("print_pairing_codes", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  deviceId: bigint("device_id", { mode: "number" }).references(() => printDevices.id), // the device it paired
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
});

export const PRINT_JOB_MODES = ["sale", "job_cost"] as const;
export const PRINT_JOB_STATUSES = ["active", "cancelled"] as const;

/**
 * A print (A§11, D64). New → mode sale at the typed rate (the machine's sale rate by default): posts nothing until it
 * is billed on an invoice / estimate. On an existing job → mode job_cost at the machine's cost rate: a printing cost
 * of that job (T27), never posted. sq ft = W × H × qty and amount = sq ft × rate, each rounded half-up. Money taken
 * at the print is a receipt allocated to it. Payment status is computed (A§5), never stored. Numbered PJ/ on save.
 * Edit / cancel: owner / accountant, never once billed. Never deleted. Audited.
 */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    number: text("number").notNull().unique(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    jobId: bigint("job_id", { mode: "number" }).references(() => jobs.id), // null = new (sale)
    mode: text("mode", { enum: PRINT_JOB_MODES }).notNull(),
    fileName: text("file_name").notNull(),
    filePath: text("file_path"),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id),
    printingTypeId: bigint("printing_type_id", { mode: "number" })
      .notNull()
      .references(() => printingTypes.id),
    widthMilli: bigint("width_milli", { mode: "bigint" }).notNull(), // feet, thousandths
    heightMilli: bigint("height_milli", { mode: "bigint" }).notNull(),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    sqftMilli: bigint("sqft_milli", { mode: "bigint" }).notNull(),
    ratePaise: bigint("rate_paise", { mode: "bigint" }).notNull(), // per sq ft: sale rate, or cost rate (job_cost)
    amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => users.id),
    printedAt: timestamp("printed_at", { withTimezone: true }).notNull(),
    // The India date of printed_at: lists, reports, the dashboard and the PJ/ year go by it.
    date: date("date")
      .notNull()
      .generatedAlwaysAs(sql`(timezone('Asia/Kolkata', printed_at))::date`),
    reprintOfId: bigint("reprint_of_id", { mode: "number" }).references((): AnyPgColumn => printJobs.id),
    // The agent's id for this print (T39): a print sent twice — a retry, or two copies at once — is saved once.
    clientUuid: uuid("client_uuid").unique(),
    deviceId: bigint("device_id", { mode: "number" }).references(() => printDevices.id), // null = the web form
    status: text("status", { enum: PRINT_JOB_STATUSES }).notNull().default("active"),
    notes: text("notes"),
    ...stamps(),
  },
  (t) => [
    index("print_jobs_customer_idx").on(t.customerId),
    index("print_jobs_job_idx").on(t.jobId),
    index("print_jobs_date_idx").on(t.date),
    check("print_jobs_mode_check", sql`${t.mode} in ('sale', 'job_cost')`),
    check("print_jobs_mode_job", sql`(${t.mode} = 'job_cost') = (${t.jobId} is not null)`),
    check("print_jobs_status_check", sql`${t.status} in ('active', 'cancelled')`),
    check("print_jobs_size_positive", sql`${t.widthMilli} > 0 and ${t.heightMilli} > 0 and ${t.qtyMilli} > 0 and ${t.sqftMilli} > 0`),
    check("print_jobs_money_check", sql`${t.ratePaise} >= 0 and ${t.amountPaise} >= 0`),
  ],
);
