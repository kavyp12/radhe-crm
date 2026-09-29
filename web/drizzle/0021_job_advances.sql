ALTER TABLE "allocations" DROP CONSTRAINT "allocations_one_target";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "job_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "from_job_id" bigint;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_from_job_id_jobs_id_fk" FOREIGN KEY ("from_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_job_idx" ON "allocations" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_from_job_on_invoice" CHECK ("allocations"."from_job_id" is null or "allocations"."invoice_id" is not null);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_target" CHECK (num_nonnulls("allocations"."invoice_id", "allocations"."job_id") = 1);