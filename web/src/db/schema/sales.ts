import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { customers, productCategories } from "./masters";

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
