CREATE TABLE "transfers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"date" date NOT NULL,
	"from_account_id" bigint NOT NULL,
	"to_account_id" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reference" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_number_unique" UNIQUE("number"),
	CONSTRAINT "transfers_amount_positive" CHECK ("transfers"."amount_paise" > 0),
	CONSTRAINT "transfers_two_accounts" CHECK ("transfers"."from_account_id" <> "transfers"."to_account_id"),
	CONSTRAINT "transfers_status_check" CHECK ("transfers"."status" in ('active', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;