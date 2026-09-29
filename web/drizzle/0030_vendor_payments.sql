CREATE TABLE "vendor_allocations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" bigint NOT NULL,
	"purchase_bill_id" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_allocations_amount_positive" CHECK ("vendor_allocations"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"vendor_id" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"mode" text NOT NULL,
	"money_account_id" bigint NOT NULL,
	"reference" text,
	"cheque_no" text,
	"cheque_date" date,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payments_number_unique" UNIQUE("number"),
	CONSTRAINT "vendor_payments_amount_positive" CHECK ("vendor_payments"."amount_paise" > 0),
	CONSTRAINT "vendor_payments_mode_check" CHECK ("vendor_payments"."mode" in ('cash', 'upi', 'bank', 'cheque')),
	CONSTRAINT "vendor_payments_status_check" CHECK ("vendor_payments"."status" in ('active', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "statement_links" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_links" ADD COLUMN "vendor_id" bigint;--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD CONSTRAINT "vendor_allocations_payment_id_vendor_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD CONSTRAINT "vendor_allocations_purchase_bill_id_purchase_bills_id_fk" FOREIGN KEY ("purchase_bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_allocations" ADD CONSTRAINT "vendor_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_money_account_id_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_allocations_payment_idx" ON "vendor_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "vendor_allocations_bill_idx" ON "vendor_allocations" USING btree ("purchase_bill_id");--> statement-breakpoint
CREATE INDEX "vendor_payments_vendor_idx" ON "vendor_payments" USING btree ("vendor_id");--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_one_party" CHECK (num_nonnulls("statement_links"."customer_id", "statement_links"."vendor_id") = 1);