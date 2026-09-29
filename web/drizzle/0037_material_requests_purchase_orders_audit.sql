-- Material requests, purchase orders and their lines are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON material_requests FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON material_request_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Lines are never deleted (hard rule 3): a PO edit deactivates them; a request's lines never change.
CREATE TRIGGER no_delete BEFORE DELETE ON material_request_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON material_request_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON purchase_order_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
