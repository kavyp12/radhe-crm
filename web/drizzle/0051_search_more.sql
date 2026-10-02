-- Search by number for material requests, POs, GRNs, stock issues, stock adjustments, transfers and JVs (D63),
-- unpadded like 0050: MR/26-27/0007 → MR/26-27/7.
CREATE INDEX material_requests_number_trgm_idx ON material_requests USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_orders_number_trgm_idx ON purchase_orders USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX goods_receipts_number_trgm_idx ON goods_receipts USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX stock_issues_number_trgm_idx ON stock_issues USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX stock_adjustments_number_trgm_idx ON stock_adjustments USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX transfers_number_trgm_idx ON transfers USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX adjustments_number_trgm_idx ON adjustments USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
