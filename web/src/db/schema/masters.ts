import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);
