-- Purchase bills and their lines are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_bills FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_bill_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- A posted bill's lines are never deleted: an edit deactivates them and adds new ones (hard rule 3, D51).
CREATE TRIGGER no_delete BEFORE DELETE ON purchase_bill_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON purchase_bill_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
