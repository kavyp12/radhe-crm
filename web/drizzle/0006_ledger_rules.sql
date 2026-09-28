-- Journal rules (A§3, D14). Checked at COMMIT (deferred), so post() can insert the entry and then its lines:
-- every entry has at least 2 lines and its debits equal its credits. Fires for the entry row (catches an entry
-- with no lines) and for every line row (catches a line added to any entry).
CREATE FUNCTION journal_entry_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e_id bigint;
  n bigint;
  dr numeric;
  cr numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    e_id := NEW.id;
  ELSE
    e_id := NEW.entry_id;
  END IF;
  SELECT count(*), coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0) INTO n, dr, cr
    FROM journal_lines WHERE entry_id = e_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); an entry needs at least 2 lines', e_id, n;
  END IF;
  IF dr <> cr THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits % (paise)', e_id, dr, cr;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_check();
--> statement-breakpoint

-- Append-only (forbid_change() from 0004): a posted entry is changed only by a reversing entry (hard rule 3).
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON journal_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

-- System accounts (A§3, D40). Codes: 1xxx assets · 2xxx liabilities · 3xxx equity · 4xxx income · 5xxx expenses ·
-- 6xxx one per expense category (T09). lib/ledger.ts SYSTEM_KEYS lists the same keys.
INSERT INTO accounts (code, name, type, system_key, is_money) VALUES
  ('1001', 'Cash', 'asset', 'cash', true),
  ('1002', 'Petty Cash', 'asset', 'petty_cash', true),
  ('1003', 'UPI', 'asset', 'upi', true),
  ('1004', 'Bank 1', 'asset', 'bank_1', true),
  ('1005', 'Bank 2', 'asset', 'bank_2', true),
  ('1006', 'Accounts Receivable', 'asset', 'ar', false),
  ('1007', 'Stock', 'asset', 'stock', false),
  ('1008', 'Input CGST', 'asset', 'gst_in_cgst', false),
  ('1009', 'Input SGST', 'asset', 'gst_in_sgst', false),
  ('1010', 'Input IGST', 'asset', 'gst_in_igst', false),
  ('2001', 'Accounts Payable', 'liability', 'ap', false),
  ('2002', 'Output CGST', 'liability', 'gst_out_cgst', false),
  ('2003', 'Output SGST', 'liability', 'gst_out_sgst', false),
  ('2004', 'Output IGST', 'liability', 'gst_out_igst', false),
  ('2005', 'Goods Received Not Billed', 'liability', 'grn_clearing', false),
  ('3001', 'Capital', 'equity', 'capital', false),
  ('3002', 'Opening Balance Equity', 'equity', 'opening_equity', false),
  ('4001', 'Sales', 'income', 'sales', false),
  ('4002', 'Sales Returns', 'income', 'sales_returns', false),
  ('4003', 'Round Off', 'income', 'round_off', false),
  ('5001', 'Materials Consumed', 'expense', 'materials_consumed', false),
  ('5002', 'Purchase Price Variance', 'expense', 'price_variance', false),
  ('5003', 'Cash Short / Excess', 'expense', 'cash_short_excess', false),
  ('5004', 'Bad Debts', 'expense', 'bad_debts', false);
--> statement-breakpoint

-- Accounts are audited (money account renames and opening balances show who changed them).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_row();
