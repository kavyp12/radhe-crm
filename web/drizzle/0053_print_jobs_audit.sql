-- Machines, printing types and print jobs are audited (S23, P10) and never deleted (hard rule 3): deactivated / cancelled.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON machines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON machines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON machines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON printing_types FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON printing_types FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON printing_types FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON print_jobs FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON print_jobs FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON print_jobs FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- Search (S26, D63): print jobs by number (unpadded, like 0050) and file name.
CREATE INDEX print_jobs_number_trgm_idx ON print_jobs USING gin (regexp_replace(number, '([/-])0+([0-9]+)$', '\1\2') gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX print_jobs_file_name_trgm_idx ON print_jobs USING gin (file_name gin_trgm_ops);
