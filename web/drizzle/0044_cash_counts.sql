CREATE TABLE "cash_counts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cash_counts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"date" date NOT NULL,
	"account_id" bigint NOT NULL,
	"counted_paise" bigint NOT NULL,
	"counted_by" text NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_counts_counted_check" CHECK ("cash_counts"."counted_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_counts_day_idx" ON "cash_counts" USING btree ("account_id","date");