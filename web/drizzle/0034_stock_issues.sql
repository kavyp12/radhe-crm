CREATE TABLE "stock_issue_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_issue_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"qty_milli" bigint NOT NULL,
	"value_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_issue_lines_qty_positive" CHECK ("stock_issue_lines"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_issues" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_issues_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"job_id" bigint NOT NULL,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_issues_number_unique" UNIQUE("number"),
	CONSTRAINT "stock_issues_kind_check" CHECK ("stock_issues"."kind" in ('issue', 'return')),
	CONSTRAINT "stock_issues_status_check" CHECK ("stock_issues"."status" in ('active', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "stock_issue_lines" ADD CONSTRAINT "stock_issue_lines_issue_id_stock_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."stock_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_issue_lines" ADD CONSTRAINT "stock_issue_lines_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_issues" ADD CONSTRAINT "stock_issues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_issue_lines_item_idx" ON "stock_issue_lines" USING btree ("issue_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_issues_job_idx" ON "stock_issues" USING btree ("job_id");