CREATE TABLE "quotation_lines" (
	"quotation_id" bigint NOT NULL,
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quotation_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
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
	"gst_bp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "quotations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"customer_id" bigint NOT NULL,
	"place_of_supply" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_paise" bigint NOT NULL,
	"terms" text,
	"notes" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_number_unique" UNIQUE("number"),
	CONSTRAINT "quotations_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "quotations_status_check" CHECK ("quotations"."status" in ('draft', 'sent', 'approved', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "quotation_terms" text;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotation_lines_doc_idx" ON "quotation_lines" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "quotations_customer_idx" ON "quotations" USING btree ("customer_id");