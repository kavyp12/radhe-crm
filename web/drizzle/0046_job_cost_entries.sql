CREATE TABLE "job_cost_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_cost_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"bucket" text NOT NULL,
	"date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_cost_entries_amount_positive" CHECK ("job_cost_entries"."amount_paise" > 0),
	CONSTRAINT "job_cost_entries_bucket_check" CHECK ("job_cost_entries"."bucket" in ('material', 'labour', 'installation', 'transport', 'printing', 'other'))
);
--> statement-breakpoint
ALTER TABLE "job_cost_entries" ADD CONSTRAINT "job_cost_entries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cost_entries" ADD CONSTRAINT "job_cost_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_cost_entries_job_idx" ON "job_cost_entries" USING btree ("job_id");