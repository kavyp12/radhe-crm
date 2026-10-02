-- Opening bills (T43) are audited (S23) and never deleted (hard rule 3).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON opening_bills FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON opening_bills FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON opening_bills FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
