-- Follow-ups are audited (S23) and never changed: the next follow-up is a new row (T29).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON follow_ups FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON follow_ups FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON follow_ups FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
