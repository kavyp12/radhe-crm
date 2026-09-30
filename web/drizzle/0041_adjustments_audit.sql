-- JVs and their lines are audited (S23).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON adjustments FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON adjustment_lines FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Posted lines are never deleted (hard rule 3): a cancel reverses the entry.
CREATE TRIGGER no_delete BEFORE DELETE ON adjustment_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON adjustment_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- D55: a settlement discount posts Dr discount_allowed / Cr ar (an A§3 system account added here, next to bad_debts).
INSERT INTO accounts (code, name, type, system_key, is_money) VALUES ('5005', 'Discount Allowed', 'expense', 'discount_allowed', false);
