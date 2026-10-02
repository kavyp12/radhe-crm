CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("date");--> statement-breakpoint
CREATE INDEX "purchase_bills_date_idx" ON "purchase_bills" USING btree ("date");--> statement-breakpoint
CREATE INDEX "vendor_payments_date_idx" ON "vendor_payments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "invoices_date_idx" ON "invoices" USING btree ("date");--> statement-breakpoint
CREATE INDEX "receipts_date_idx" ON "receipts" USING btree ("date");