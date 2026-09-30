-- Cash counts are audited (S23) and never changed: a recount is a new row (T26).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cash_counts FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON cash_counts FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON cash_counts FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
