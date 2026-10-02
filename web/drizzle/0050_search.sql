-- Universal search (S26, D62). pg_trgm is a trusted extension: the DB owner may create it (Supabase has it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Names, firm names, site references, vendor bill nos: ILIKE '%…%' and word similarity (<%) on GIN trigram indexes.
CREATE INDEX customers_name_trgm_idx ON customers USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX customers_firm_name_trgm_idx ON customers USING gin (firm_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_name_trgm_idx ON vendors USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX jobs_site_reference_trgm_idx ON jobs USING gin (site_reference gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_bills_vendor_bill_no_trgm_idx ON purchase_bills USING gin (vendor_bill_no gin_trgm_ops);
--> statement-breakpoint
-- GSTINs are stored upper case without spaces.
CREATE INDEX customers_gstin_trgm_idx ON customers USING gin (gstin gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_gstin_trgm_idx ON vendors USING gin (gstin gin_trgm_ops);
--> statement-breakpoint
-- Mobiles as digits only ("+91 98250-12345" → 919825012345), vehicle nos as letters + digits (GJ-01-AB-1234 → GJ01AB1234).
-- lib/search.ts uses the same expressions, so these indexes serve its queries.
CREATE INDEX customers_mobile_trgm_idx ON customers USING gin (regexp_replace(mobile, '[^0-9]', '', 'g') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_mobile_trgm_idx ON vendors USING gin (regexp_replace(mobile, '[^0-9]', '', 'g') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX jobs_vehicle_no_trgm_idx ON jobs USING gin (regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g') gin_trgm_ops);
--> statement-breakpoint
-- Document numbers without the zero padding of their last group (A§6): RDS-2026-00125 → RDS-2026-125, QT/26-27/0014 → QT/26-27/14.
CREATE INDEX jobs_number_trgm_idx ON jobs USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX quotations_number_trgm_idx ON quotations USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX invoices_number_trgm_idx ON invoices USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX credit_notes_number_trgm_idx ON credit_notes USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX debit_notes_number_trgm_idx ON debit_notes USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX receipts_number_trgm_idx ON receipts USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendor_payments_number_trgm_idx ON vendor_payments USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_bills_number_trgm_idx ON purchase_bills USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX expenses_number_trgm_idx ON expenses USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
-- Amount search: documents whose total equals the amount typed.
CREATE INDEX jobs_total_idx ON jobs (total_paise);
--> statement-breakpoint
CREATE INDEX quotations_total_idx ON quotations (total_paise);
--> statement-breakpoint
CREATE INDEX invoices_total_idx ON invoices (total_paise);
--> statement-breakpoint
CREATE INDEX credit_notes_total_idx ON credit_notes (total_paise);
--> statement-breakpoint
CREATE INDEX debit_notes_total_idx ON debit_notes (total_paise);
--> statement-breakpoint
CREATE INDEX receipts_amount_idx ON receipts (amount_paise);
--> statement-breakpoint
CREATE INDEX vendor_payments_amount_idx ON vendor_payments (amount_paise);
--> statement-breakpoint
CREATE INDEX purchase_bills_total_idx ON purchase_bills (total_paise);
--> statement-breakpoint
CREATE INDEX expenses_amount_idx ON expenses (amount_paise);
