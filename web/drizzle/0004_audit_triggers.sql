-- Audit (A§7, S23): ONE generic trigger function records every insert / update / delete on an audited table with
-- old + new rows and the user from app.user_id, which writeTx() (src/db/index.ts) sets at the start of each write
-- transaction. Empty / unset = system (seed, migration).
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
BEGIN
  IF TG_OP = 'UPDATE' AND old_row = new_row THEN
    RETURN NEW; -- nothing changed, nothing to record
  END IF;
  INSERT INTO audit_log (table_name, row_id, action, old_data, new_data, user_id)
  VALUES (TG_TABLE_NAME, coalesce(new_row, old_row) ->> 'id', lower(TG_OP), old_row, new_row,
          nullif(current_setting('app.user_id', true), ''));
  RETURN coalesce(NEW, OLD);
END $$;
--> statement-breakpoint

-- Append-only tables (audit_log now; T06 reuses it for the journal).
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- The one settings row (state_code defaults to '24', everything else empty until Q3).
INSERT INTO settings (id) VALUES (1);
--> statement-breakpoint

-- Audited tables. Better Auth's sessions / auth_accounts / verifications are not audited.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION audit_row();
