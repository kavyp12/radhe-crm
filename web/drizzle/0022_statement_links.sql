CREATE TABLE "statement_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "statement_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token" text NOT NULL,
	"customer_id" bigint NOT NULL,
	"from_date" date,
	"to_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "statement_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;