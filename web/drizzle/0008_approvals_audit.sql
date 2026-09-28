-- Approval requests are audited: who asked, who decided, and when (A§7).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON approval_requests FOR EACH ROW EXECUTE FUNCTION audit_row();
