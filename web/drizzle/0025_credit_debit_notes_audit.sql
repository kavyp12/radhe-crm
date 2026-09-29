-- Credit / debit notes and their lines are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON debit_notes FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON debit_note_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
