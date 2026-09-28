-- Reference data (D40): the 14 S4 product categories (HSN/SAC blank, GST 18 % until Q2, D41) and the 21 S10
-- expense categories, each with its own expense account (codes 6001–6021, S10 order) and its D41 cost bucket.
-- Names copied from docs/SPEC.md S4 / S10.
INSERT INTO product_categories (name) VALUES
  ('LED Sign Board'),
  ('Acrylic Channel Letter'),
  ('ACP Elevation'),
  ('Glow Sign Board'),
  ('Flex Banner'),
  ('Vinyl Printing'),
  ('One Way Vision'),
  ('Frosted Film'),
  ('UV Printing'),
  ('CNC Cutting'),
  ('Laser Cutting'),
  ('Aluminium Channel Letter'),
  ('Installation/Fitting'),
  ('Other');
--> statement-breakpoint
WITH cats (n, name, bucket) AS (VALUES
  (1, 'Acrylic', 'material'),
  (2, 'ACP', 'material'),
  (3, 'LED Module', 'material'),
  (4, 'SMPS', 'material'),
  (5, 'Aluminium', 'material'),
  (6, 'Flex', 'material'),
  (7, 'Vinyl', 'material'),
  (8, 'Ink', 'material'),
  (9, 'Welding Material', 'material'),
  (10, 'Electrical Material', 'material'),
  (11, 'Labour', 'labour'),
  (12, 'Installation', 'installation'),
  (13, 'Transport', 'transport'),
  (14, 'Diesel/Petrol', 'transport'),
  (15, 'Machine Repair', 'none'),
  (16, 'Electricity', 'none'),
  (17, 'Rent', 'none'),
  (18, 'Salary', 'none'),
  (19, 'Office Expense', 'none'),
  (20, 'Marketing', 'none'),
  (21, 'Miscellaneous', 'other')
), accs AS (
  INSERT INTO accounts (code, name, type) SELECT (6000 + n)::text, name, 'expense' FROM cats RETURNING id, code
)
INSERT INTO expense_categories (name, account_id, cost_bucket)
SELECT c.name, a.id, c.bucket FROM cats c JOIN accs a ON a.code = (6000 + c.n)::text ORDER BY c.n;
--> statement-breakpoint

-- Audited, like every business table.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON vendors FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON product_categories FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON expense_categories FOR EACH ROW EXECUTE FUNCTION audit_row();
