-- Vendor payments and their allocations are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON vendor_allocations FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Vendor allocation rows are never deleted (D49, D51): a change deactivates the old rows and adds new ones.
CREATE TRIGGER no_delete BEFORE DELETE ON vendor_allocations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON vendor_allocations FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
