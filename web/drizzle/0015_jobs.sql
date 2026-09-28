CREATE TABLE "job_lines" (
	"job_id" bigint NOT NULL,
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
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
	"quotation_line_id" bigint
);
--> statement-breakpoint
CREATE TABLE "job_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by" text DEFAULT nullif(current_setting('app.user_id', true), '') NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"customer_id" bigint NOT NULL,
	"quotation_id" bigint,
	"place_of_supply" text NOT NULL,
	"status" text DEFAULT 'in_production' NOT NULL,
	"total_paise" bigint NOT NULL,
	"site_address" text,
	"site_reference" text,
	"vehicle_no" text,
	"sales_person_id" text,
	"target_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_number_unique" UNIQUE("number"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('in_production', 'ready', 'delivered', 'invoiced', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_lines" ADD CONSTRAINT "job_lines_quotation_line_id_quotation_lines_id_fk" FOREIGN KEY ("quotation_line_id") REFERENCES "public"."quotation_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_history" ADD CONSTRAINT "job_status_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_history" ADD CONSTRAINT "job_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sales_person_id_users_id_fk" FOREIGN KEY ("sales_person_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_lines_doc_idx" ON "job_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_status_history_job_idx" ON "job_status_history" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "jobs_customer_idx" ON "jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_quotation_live_idx" ON "jobs" USING btree ("quotation_id") WHERE "jobs"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;