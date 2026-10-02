CREATE TABLE "opening_bills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opening_bills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint,
	"vendor_id" bigint,
	"bill_no" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_bills_one_party" CHECK (num_nonnulls("opening_bills"."customer_id", "opening_bills"."vendor_id") = 1),
	CONSTRAINT "opening_bills_amount_positive" CHECK ("opening_bills"."amount_paise" > 0),
	CONSTRAINT "opening_bills_due_after_bill" CHECK ("opening_bills"."due_date" >= "opening_bills"."bill_date")
);
--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_target";--> statement-breakpoint
ALTER TABLE "vendor_allocations" ALTER COLUMN "purchase_bill_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD COLUMN "opening_bill_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "opening_bill_id" bigint;--> statement-breakpoint
ALTER TABLE "opening_bills" ADD CONSTRAINT "opening_bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_bills" ADD CONSTRAINT "opening_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_bills" ADD CONSTRAINT "opening_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_bills_customer_idx" ON "opening_bills" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "opening_bills_vendor_idx" ON "opening_bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_bills_customer_bill_no" ON "opening_bills" USING btree ("customer_id",lower("bill_no"));--> statement-breakpoint
CREATE UNIQUE INDEX "opening_bills_vendor_bill_no" ON "opening_bills" USING btree ("vendor_id",lower("bill_no"));--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD CONSTRAINT "vendor_allocations_opening_bill_id_opening_bills_id_fk" FOREIGN KEY ("opening_bill_id") REFERENCES "public"."opening_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_opening_bill_id_opening_bills_id_fk" FOREIGN KEY ("opening_bill_id") REFERENCES "public"."opening_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_allocations_opening_bill_idx" ON "vendor_allocations" USING btree ("opening_bill_id");--> statement-breakpoint
CREATE INDEX "allocations_opening_bill_idx" ON "allocations" USING btree ("opening_bill_id");--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD CONSTRAINT "vendor_allocations_one_target" CHECK (num_nonnulls("vendor_allocations"."purchase_bill_id", "vendor_allocations"."opening_bill_id") = 1);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."invoice_id", "allocations"."job_id", "allocations"."debit_note_id", "allocations"."refund_adjustment_id", "allocations"."print_job_id", "allocations"."opening_bill_id") = 1);