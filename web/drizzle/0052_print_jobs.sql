CREATE TABLE "machines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "machines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"printer_names" text[] DEFAULT '{}' NOT NULL,
	"sale_rate_paise" bigint,
	"cost_rate_paise" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_name_unique" UNIQUE("name"),
	CONSTRAINT "machines_sale_rate_check" CHECK ("machines"."sale_rate_paise" is null or "machines"."sale_rate_paise" >= 0),
	CONSTRAINT "machines_cost_rate_check" CHECK ("machines"."cost_rate_paise" is null or "machines"."cost_rate_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "print_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"customer_id" bigint NOT NULL,
	"job_id" bigint,
	"mode" text NOT NULL,
	"file_name" text NOT NULL,
	"file_path" text,
	"machine_id" bigint NOT NULL,
	"printing_type_id" bigint NOT NULL,
	"width_milli" bigint NOT NULL,
	"height_milli" bigint NOT NULL,
	"qty_milli" bigint NOT NULL,
	"sqft_milli" bigint NOT NULL,
	"rate_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"operator_user_id" text NOT NULL,
	"printed_at" timestamp with time zone NOT NULL,
	"date" date GENERATED ALWAYS AS ((timezone('Asia/Kolkata', printed_at))::date) STORED NOT NULL,
	"reprint_of_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_jobs_number_unique" UNIQUE("number"),
	CONSTRAINT "print_jobs_mode_check" CHECK ("print_jobs"."mode" in ('sale', 'job_cost')),
	CONSTRAINT "print_jobs_mode_job" CHECK (("print_jobs"."mode" = 'job_cost') = ("print_jobs"."job_id" is not null)),
	CONSTRAINT "print_jobs_status_check" CHECK ("print_jobs"."status" in ('active', 'cancelled')),
	CONSTRAINT "print_jobs_size_positive" CHECK ("print_jobs"."width_milli" > 0 and "print_jobs"."height_milli" > 0 and "print_jobs"."qty_milli" > 0 and "print_jobs"."sqft_milli" > 0),
	CONSTRAINT "print_jobs_money_check" CHECK ("print_jobs"."rate_paise" >= 0 and "print_jobs"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "printing_types" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "printing_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"category_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printing_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_target";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "print_job_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "from_print_job_id" bigint;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "print_job_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printing_type_id_printing_types_id_fk" FOREIGN KEY ("printing_type_id") REFERENCES "public"."printing_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_reprint_of_id_print_jobs_id_fk" FOREIGN KEY ("reprint_of_id") REFERENCES "public"."print_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printing_types" ADD CONSTRAINT "printing_types_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printing_types" ADD CONSTRAINT "printing_types_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_jobs_customer_idx" ON "print_jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "print_jobs_job_idx" ON "print_jobs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "print_jobs_date_idx" ON "print_jobs" USING btree ("date");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_print_job_id_print_jobs_id_fk" FOREIGN KEY ("print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_from_print_job_id_print_jobs_id_fk" FOREIGN KEY ("from_print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_print_job_id_print_jobs_id_fk" FOREIGN KEY ("print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_print_job_idx" ON "allocations" USING btree ("print_job_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_print_job_idx" ON "invoice_lines" USING btree ("print_job_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_from_print_job_on_invoice" CHECK ("allocations"."from_print_job_id" is null or "allocations"."invoice_id" is not null);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."invoice_id", "allocations"."job_id", "allocations"."debit_note_id", "allocations"."refund_adjustment_id", "allocations"."print_job_id") = 1);