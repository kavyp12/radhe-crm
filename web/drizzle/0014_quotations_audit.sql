-- Quotations and their lines are audited (S23): every save, status change and line edit with who and old → new.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON quotations FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON quotation_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
