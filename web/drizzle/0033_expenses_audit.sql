-- Expenses are audited (S23): an edit keeps the old values here and the reversal in the journal.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION audit_row();
