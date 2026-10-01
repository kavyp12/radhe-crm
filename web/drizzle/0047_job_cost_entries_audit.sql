-- Manual job costs are audited (S23) and never deleted (hard rule 3): a wrong one is deactivated.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON job_cost_entries FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON job_cost_entries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON job_cost_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
