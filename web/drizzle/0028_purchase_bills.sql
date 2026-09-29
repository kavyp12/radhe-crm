CREATE TABLE "purchase_bill_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_bill_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bill_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"stock_item_id" bigint,
	"expense_category_id" bigint,
	"description" text,
	"qty_milli" bigint NOT NULL,
	"rate_paise" bigint NOT NULL,
	"gst_bp" integer NOT NULL,
	"job_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_bill_lines_one_kind" CHECK (num_nonnulls("purchase_bill_lines"."stock_item_id", "purchase_bill_lines"."expense_category_id") = 1),
	CONSTRAINT "purchase_bill_lines_job_on_expense" CHECK ("purchase_bill_lines"."job_id" is null or "purchase_bill_lines"."expense_category_id" is not null),
	CONSTRAINT "purchase_bill_lines_qty_positive" CHECK ("purchase_bill_lines"."qty_milli" > 0),
	CONSTRAINT "purchase_bill_lines_rate_check" CHECK ("purchase_bill_lines"."rate_paise" >= 0),
	CONSTRAINT "purchase_bill_lines_gst_check" CHECK ("purchase_bill_lines"."gst_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "purchase_bills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_bills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"vendor_id" bigint NOT NULL,
	"vendor_bill_no" text NOT NULL,
	"date" date NOT NULL,
	"due_date" date NOT NULL,
	"vendor_state_code" text NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_bills_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_bills_total_positive" CHECK ("purchase_bills"."total_paise" > 0),
	CONSTRAINT "purchase_bills_round_off_check" CHECK ("purchase_bills"."round_off_paise" between -100 and 100),
	CONSTRAINT "purchase_bills_status_check" CHECK ("purchase_bills"."status" in ('active', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_expense_category_id_expense_categories_id_fk" FOREIGN KEY ("expense_category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_bill_lines_bill_idx" ON "purchase_bill_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "purchase_bill_lines_job_idx" ON "purchase_bill_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "purchase_bills_vendor_idx" ON "purchase_bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_bills_vendor_bill_no_idx" ON "purchase_bills" USING btree ("vendor_id",upper("vendor_bill_no")) WHERE "purchase_bills"."status" <> 'cancelled';