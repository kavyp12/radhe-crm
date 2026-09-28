-- Jobs and their lines are audited (S23). The status history is append-only: each row is who moved the job, when.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON job_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON job_status_history FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON job_status_history FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
