-- Receipts and allocations are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Allocation rows are never deleted (D49): a change deactivates the old rows and adds new ones.
CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON allocations FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
