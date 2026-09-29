CREATE TABLE "credit_note_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_note_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"note_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"invoice_line_id" bigint NOT NULL,
	"qty_milli" bigint,
	"taxable_paise" bigint NOT NULL,
	"gst_bp" integer NOT NULL,
	CONSTRAINT "credit_note_lines_taxable_positive" CHECK ("credit_note_lines"."taxable_paise" > 0),
	CONSTRAINT "credit_note_lines_qty_positive" CHECK ("credit_note_lines"."qty_milli" is null or "credit_note_lines"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text,
	"date" date NOT NULL,
	"invoice_id" bigint NOT NULL,
	"customer_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_date" date,
	"total_paise" bigint NOT NULL,
	"notes" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_number_unique" UNIQUE("number"),
	CONSTRAINT "credit_notes_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "credit_notes_status_check" CHECK ("credit_notes"."status" in ('draft', 'issued', 'cancelled')),
	CONSTRAINT "credit_notes_number_when_issued" CHECK ("credit_notes"."status" = 'draft' or "credit_notes"."number" is not null)
);
--> statement-breakpoint
CREATE TABLE "debit_note_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "debit_note_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"note_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"invoice_line_id" bigint NOT NULL,
	"qty_milli" bigint,
	"taxable_paise" bigint NOT NULL,
	"gst_bp" integer NOT NULL,
	CONSTRAINT "debit_note_lines_taxable_positive" CHECK ("debit_note_lines"."taxable_paise" > 0),
	CONSTRAINT "debit_note_lines_qty_positive" CHECK ("debit_note_lines"."qty_milli" is null or "debit_note_lines"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "debit_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "debit_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text,
	"date" date NOT NULL,
	"invoice_id" bigint NOT NULL,
	"customer_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_date" date,
	"total_paise" bigint NOT NULL,
	"notes" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debit_notes_number_unique" UNIQUE("number"),
	CONSTRAINT "debit_notes_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "debit_notes_status_check" CHECK ("debit_notes"."status" in ('draft', 'issued', 'cancelled')),
	CONSTRAINT "debit_notes_number_when_issued" CHECK ("debit_notes"."status" = 'draft' or "debit_notes"."number" is not null)
);
--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_source";--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_target";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "credit_note_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "debit_note_id" bigint;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_note_id_credit_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_note_id_debit_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."debit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_note_idx" ON "credit_note_lines" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "credit_note_lines_invoice_line_idx" ON "credit_note_lines" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_notes_customer_idx" ON "credit_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "debit_note_lines_note_idx" ON "debit_note_lines" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "debit_note_lines_invoice_line_idx" ON "debit_note_lines" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX "debit_notes_invoice_idx" ON "debit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "debit_notes_customer_idx" ON "debit_notes" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_debit_note_id_debit_notes_id_fk" FOREIGN KEY ("debit_note_id") REFERENCES "public"."debit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_credit_note_idx" ON "allocations" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "allocations_debit_note_idx" ON "allocations" USING btree ("debit_note_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_source" CHECK (num_nonnulls("allocations"."receipt_id", "allocations"."credit_note_id") = 1);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."invoice_id", "allocations"."job_id", "allocations"."debit_note_id") = 1);