-- Statement share links are audited (S23: who shared which statement).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON statement_links FOR EACH ROW EXECUTE FUNCTION audit_row();
