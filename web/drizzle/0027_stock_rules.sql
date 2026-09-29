-- Stock items and adjustments are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON stock_items FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Stock moves are append-only like the journal (A§9): a cancel / edit adds the mirror move; created_by is stamped.
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON stock_moves FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
