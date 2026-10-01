CREATE TABLE "follow_ups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "follow_ups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"invoice_id" bigint,
	"follow_up_date" date NOT NULL,
	"person_id" text NOT NULL,
	"response" text,
	"promise_date" date,
	"expected_paise" bigint,
	"next_reminder_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_ups_expected_positive" CHECK ("follow_ups"."expected_paise" is null or "follow_ups"."expected_paise" > 0),
	CONSTRAINT "follow_ups_promise_pair" CHECK (("follow_ups"."promise_date" is null) = ("follow_ups"."expected_paise" is null))
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_person_id_users_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_customer_idx" ON "follow_ups" USING btree ("customer_id","id");--> statement-breakpoint
CREATE INDEX "follow_ups_person_idx" ON "follow_ups" USING btree ("person_id");