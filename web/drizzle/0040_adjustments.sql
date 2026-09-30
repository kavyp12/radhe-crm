CREATE TABLE "adjustment_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "adjustment_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"adjustment_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"customer_id" bigint,
	"vendor_id" bigint,
	"job_id" bigint,
	CONSTRAINT "adjustment_lines_one_side" CHECK ("adjustment_lines"."debit_paise" >= 0 and "adjustment_lines"."credit_paise" >= 0 and ("adjustment_lines"."debit_paise" > 0) <> ("adjustment_lines"."credit_paise" > 0))
);
--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "adjustments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"customer_id" bigint,
	"narration" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustments_number_unique" UNIQUE("number"),
	CONSTRAINT "adjustments_amount_positive" CHECK ("adjustments"."amount_paise" > 0),
	CONSTRAINT "adjustments_kind_check" CHECK ("adjustments"."kind" in ('journal', 'write_off', 'discount', 'refund')),
	CONSTRAINT "adjustments_status_check" CHECK ("adjustments"."status" in ('active', 'cancelled')),
	CONSTRAINT "adjustments_customer_kinds" CHECK (("adjustments"."kind" = 'journal') = ("adjustments"."customer_id" is null))
);
--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_source";--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_target";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "adjustment_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "refund_adjustment_id" bigint;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_adjustment_id_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_lines" ADD CONSTRAINT "adjustment_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adjustment_lines_adjustment_idx" ON "adjustment_lines" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "adjustments_customer_idx" ON "adjustments" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_adjustment_id_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_refund_adjustment_id_adjustments_id_fk" FOREIGN KEY ("refund_adjustment_id") REFERENCES "public"."adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_adjustment_idx" ON "allocations" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "allocations_refund_adjustment_idx" ON "allocations" USING btree ("refund_adjustment_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_adjustment_settles" CHECK ("allocations"."adjustment_id" is null or "allocations"."invoice_id" is not null or "allocations"."debit_note_id" is not null);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_source" CHECK (num_nonnulls("allocations"."receipt_id", "allocations"."credit_note_id", "allocations"."adjustment_id") = 1);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."invoice_id", "allocations"."job_id", "allocations"."debit_note_id", "allocations"."refund_adjustment_id") = 1);