-- Customers are audited (S23): every create / edit / deactivation with who and old → new.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION audit_row();
