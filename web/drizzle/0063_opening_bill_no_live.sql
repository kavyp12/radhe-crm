DROP INDEX "opening_bills_customer_bill_no";--> statement-breakpoint
DROP INDEX "opening_bills_vendor_bill_no";--> statement-breakpoint
CREATE UNIQUE INDEX "opening_bills_customer_bill_no" ON "opening_bills" USING btree ("customer_id",lower("bill_no")) WHERE "opening_bills"."cancelled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_bills_vendor_bill_no" ON "opening_bills" USING btree ("vendor_id",lower("bill_no")) WHERE "opening_bills"."cancelled_at" is null;