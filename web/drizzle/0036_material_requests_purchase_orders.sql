CREATE TABLE "material_request_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "material_request_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"qty_milli" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_request_lines_qty_positive" CHECK ("material_request_lines"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "material_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "material_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"needed_by" date NOT NULL,
	"job_id" bigint,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_requests_number_unique" UNIQUE("number"),
	CONSTRAINT "material_requests_status_check" CHECK ("material_requests"."status" in ('pending', 'approved', 'rejected', 'ordered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"description" text,
	"qty_milli" bigint NOT NULL,
	"rate_paise" bigint NOT NULL,
	"gst_bp" integer NOT NULL,
	"request_line_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_lines_qty_positive" CHECK ("purchase_order_lines"."qty_milli" > 0),
	CONSTRAINT "purchase_order_lines_rate_check" CHECK ("purchase_order_lines"."rate_paise" >= 0),
	CONSTRAINT "purchase_order_lines_gst_check" CHECK ("purchase_order_lines"."gst_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"vendor_id" bigint NOT NULL,
	"vendor_state_code" text NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_orders_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" in ('draft', 'sent', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_request_id_material_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."material_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_request_line_id_material_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "public"."material_request_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_request_lines_request_idx" ON "material_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "material_requests_status_idx" ON "material_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_order_idx" ON "purchase_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_request_line_idx" ON "purchase_order_lines" USING btree ("request_line_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id");