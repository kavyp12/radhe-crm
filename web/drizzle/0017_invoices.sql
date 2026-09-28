CREATE TABLE "invoice_lines" (
	"invoice_id" bigint NOT NULL,
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoice_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"position" integer NOT NULL,
	"category_id" bigint NOT NULL,
	"description" text,
	"hsn_sac" text,
	"width_milli" bigint,
	"height_milli" bigint,
	"qty_milli" bigint NOT NULL,
	"unit" text NOT NULL,
	"rate_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"gst_bp" integer NOT NULL,
	"job_id" bigint,
	"quotation_line_id" bigint
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"customer_id" bigint NOT NULL,
	"place_of_supply" text NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"terms" text,
	"notes" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('tax', 'estimate')),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('draft', 'issued', 'cancelled')),
	CONSTRAINT "invoices_number_when_issued" CHECK ("invoices"."status" = 'draft' or "invoices"."number" is not null)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quotation_line_id_quotation_lines_id_fk" FOREIGN KEY ("quotation_line_id") REFERENCES "public"."quotation_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_doc_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_job_idx" ON "invoice_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_quotation_line_idx" ON "invoice_lines" USING btree ("quotation_line_id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");