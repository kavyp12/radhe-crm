-- Stock issues / returns and their lines are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON stock_issues FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON stock_issue_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Posted lines are never deleted (hard rule 3): a cancel mirrors the stock moves and reverses the entry.
CREATE TRIGGER no_delete BEFORE DELETE ON stock_issue_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON stock_issue_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
