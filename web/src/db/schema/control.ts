import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { ATTACHMENT_KINDS } from "../../lib/attachment-kinds"; // relative: drizzle-kit does not read tsconfig paths
import { users } from "./auth";

// Document number counters (ARCHITECTURE §6); only lib/numbering.ts touches them.
// next_value = the number the next document of this series + period will get.
export const counters = pgTable(
  "counters",
  {
    series: text("series").notNull(),
    periodKey: text("period_key").notNull(),
    nextValue: integer("next_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.series, t.periodKey] })],
);

/**
 * One row per insert / update / delete on an audited table (A§7, S23), written only by the audit_row() trigger
 * (migration 0004). Append-only: another trigger rejects UPDATE, DELETE and TRUNCATE.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(), // text: Better Auth ids are text
    action: text("action", { enum: ["insert", "update", "delete"] }).notNull(),
    oldData: jsonb("old_data").$type<Record<string, unknown>>(),
    newData: jsonb("new_data").$type<Record<string, unknown>>(),
    userId: text("user_id").references(() => users.id), // null = system (seed, migration)
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_row_idx").on(t.tableName, t.rowId, t.id)],
);

/** Files attached to any record; the bytes live in lib/storage.ts under `path`. */
export const attachments = pgTable(
  "attachments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entityType: text("entity_type").notNull(),
    entityId: bigint("entity_id", { mode: "number" }).notNull(),
    kind: text("kind", { enum: ATTACHMENT_KINDS }).notNull(),
    path: text("path").notNull().unique(),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => [
    index("attachments_entity_idx").on(t.entityType, t.entityId),
    check(
      "attachments_kind_check",
      sql`${t.kind} in ('purchase_bill_photo', 'payment_screenshot', 'cheque', 'customer_po', 'quotation', 'delivery_challan', 'installation_photo', 'other', 'print_thumbnail')`,
    ),
  ],
);

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;

/**
 * A sensitive action by someone other than the owner, waiting for the owner (A§7, S22). Written only by
 * lib/approvals.ts: on approval the executor for `type` runs with `payload`, exactly once. Audited.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    type: text("type").notNull(), // the registered executor
    targetType: text("target_type"), // the record it is about: its table and id
    targetId: bigint("target_id", { mode: "number" }),
    payload: jsonb("payload").notNull(), // the executor's input, as requested (JSON: amounts as text)
    summary: text("summary").notNull(), // "Cancel invoice RDS/26-27/0012"
    // What will change, captured when requested, so the owner (and history) sees old → new.
    changes: jsonb("changes").$type<{ label: string; old: string | null; new: string | null }[]>().notNull(),
    reason: text("reason"),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.id),
    check("approval_requests_status_check", sql`${t.status} in ('pending', 'approved', 'rejected')`),
  ],
);
