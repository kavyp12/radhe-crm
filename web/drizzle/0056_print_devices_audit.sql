-- Devices and pairing codes are audited (S23) and never deleted (hard rule 3): a device is revoked instead. Every agent
-- call stamps last_seen_at (lib/agent.ts, at most once a minute); that alone is not a change worth an audit row.
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF name, token_hash, revoked_at ON print_devices FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON print_devices FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON print_devices FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON print_pairing_codes FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON print_pairing_codes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON print_pairing_codes FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- Reprint check (P8): the same file by full path or by name, case ignored as on Windows.
CREATE INDEX print_jobs_file_path_lower_idx ON print_jobs (lower(file_path));
--> statement-breakpoint
CREATE INDEX print_jobs_file_name_lower_idx ON print_jobs (lower(file_name));
