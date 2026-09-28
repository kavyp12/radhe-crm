# Architecture — Radhe CRM
Read only the section your task needs. Changing anything here = reviewer + a DECISIONS.md entry.

## 1. The chain (enter once — R0)
```
Quotation ──approve──> Job (work order) ──> In Production → Ready → Delivered
    │                    │   ▲ job costs: stock issues, job-tagged expenses & purchase lines,
    │                    │   │            attached print jobs, manual internal costs
    │                    └──> Invoice (lines copied) ──issue──> Journal
    └─ advance receipt (allocated to job) ── auto-moves to the invoice on issue

Receipt ──allocate──> invoices | job (advance) | print job | on-account
Material Request → approve → Purchase Order → Material Receive (GRN) → Vendor Bill → Vendor Payment
Print Job (popup) → customer + (existing job = job cost | new = sale) → billed on an invoice later
```
Everything that moves money posts to ONE journal. Ledgers, cash book, bank book, outstanding, profit and GST summary are read from it.

## 2. Tables (key columns only; add the obvious: id, created_at, created_by, updated_at, status, notes)
Conventions: ids bigint identity. Money `*_paise` bigint. Qty/size `*_milli` bigint (thousandths). GST rate `gst_bp` int (1800 = 18%). Better Auth tables keep their own text ids; our user refs point to them.

**Masters**
- users (Better Auth) + role (owner | accountant | sales | production), can_view_cost, active
- settings (one row): company name, address, gstin, state_code ('24'), phone, email, bank details, upi id, logo, signature, invoice terms, discount_limit_bp, backdate_days, default_credit_days
- customers: name, firm_name, mobile, gstin, state_code, billing_address, site_address, credit_limit_paise, credit_days, is_credit_customer, sales_person_id, collection_person_id, opening_balance_paise (+Dr / −Cr)
- vendors: name, gstin, state_code, mobile, address, credit_days, opening_balance_paise
- product_categories (S4, 14 seeded): name, hsn_sac (blank until client gives), gst_bp (default 1800 — confirm Q2)
- expense_categories (S10, 21 seeded): name, account_id, cost_bucket (material | labour | printing | installation | transport | other | none)
- accounts: code, name, type (asset | liability | equity | income | expense), system_key (unique), is_money
- stock_items: name, unit, category, hsn_sac, gst_bp
- machines: name, printer_names (text[]), sale_rate_paise (per sq ft), cost_rate_paise (per sq ft)
- printing_types: name

**Sales**
- quotations + quotation_lines (category_id, description, hsn_sac, width_milli, height_milli, qty_milli, unit, rate_paise, discount_paise, gst_bp)
- jobs (number RDS-YYYY-NNNNN) + job_lines; job_status_history; quotation_id, site_address, site_reference, vehicle_no, target_date, sales_person_id
- invoices + invoice_lines: kind (tax | estimate), place_of_supply (state code), due_date, round_off_paise, share_token; lines carry job_id / print_job_id / quotation_line_id
- credit_notes / debit_notes (+ lines): invoice_id required, reason
- receipts: customer, date, amount, money_account_id, mode (cash | upi | bank | cheque), reference, cheque_no, cheque_date, received_by
- allocations: source (receipt_id | credit_note_id | adjustment_id) → target (invoice_id | debit_note_id | job_id | print_job_id), amount_paise. Unallocated remainder of a receipt = on-account advance.
- follow_ups: customer, invoice (optional), follow_up_date, person_id, response, promise_date, expected_paise, next_reminder_date

**Purchase / stock**
- purchase_bills + lines (stock_item_id OR expense_category_id, qty, rate, gst, job_id optional, grn_line_id optional); vendor_bill_no unique per vendor; due_date
- vendor_payments + vendor_allocations (→ purchase_bill_id | on-account)
- expenses: date, category, vendor (optional), job (optional), amount, money_account_id, mode
- stock_moves: item, date, qty_milli (+in / −out), value_paise (±), source (opening | purchase | grn | issue | return | adjustment), source_id, job_id
- material_requests + lines, purchase_orders + lines, goods_receipts (GRN) + lines
- job_cost_entries: manual internal costs (bucket, amount, note) — management only, not posted to the journal

**Money**
- journal_entries: date, number, doc_type, doc_id, narration, reverses_entry_id
- journal_lines: entry_id, account_id, debit_paise, credit_paise (exactly one > 0), customer_id, vendor_id, job_id
- transfers (contra), adjustments (JV + lines), cash_counts (date, account, counted_paise, counted_by)

**Control**
- counters (series, period_key, next_value)
- approval_requests: type, target_type, target_id, payload jsonb, reason, requested_by, status (pending | approved | rejected), decided_by, decided_at, decision_note
- audit_log: table_name, row_id, action, old_data jsonb, new_data jsonb, user_id, at
- attachments: entity_type, entity_id, kind (S24 list + other), path, file_name, mime, size
- print_jobs, print_devices (§11)

## 3. Chart of accounts & posting rules
Seed accounts (system_key): cash, petty_cash, upi, bank_1, bank_2 (is_money) · ar · stock · gst_in_cgst, gst_in_sgst, gst_in_igst · ap · gst_out_cgst, gst_out_sgst, gst_out_igst · grn_clearing · capital · opening_equity · sales · sales_returns · round_off · materials_consumed · price_variance · cash_short_excess · bad_debts · one expense account per expense category.

| Document | Debit | Credit |
|---|---|---|
| Opening balance (customer / vendor / money / stock) | ar / money / stock (or opening_equity) | opening_equity (or ap) |
| Tax invoice, same state | ar (customer) = grand total | sales (taxable), gst_out_cgst, gst_out_sgst, round_off (±) |
| Tax invoice, other state | ar | sales, gst_out_igst, round_off |
| Estimate (non-GST) | ar | sales, round_off |
| Credit note | sales_returns, gst_out_* | ar |
| Debit note | ar | sales, gst_out_* |
| Receipt | money account | ar (customer) |
| Purchase bill | stock (stock lines) / category expense account (other lines, job_id), gst_in_* | ap (vendor) |
| Material receive (GRN) | stock (at PO rate) | grn_clearing |
| Bill from GRN | grn_clearing (GRN value), price_variance (±), gst_in_* | ap |
| Vendor payment | ap (vendor) | money account |
| Expense | category expense account (job_id) | money account |
| Stock issue to job | materials_consumed (job_id) | stock |
| Stock adjustment | stock or cash_short_excess | the other one / opening_equity for opening stock |
| Transfer (contra) | to-account | from-account |
| Adjustment (JV) | as entered | as entered |
| Cash count difference | cash_short_excess or cash | cash or cash_short_excess |

Rules: each entry balances (DB deferred trigger). Cancel = reversing entry (Dr/Cr swapped) + document status cancelled. An approved edit = reverse + new entry for the same document. Allocations never post — they only link.

## 4. GST
- Company state '24' (Gujarat). Customer state = first 2 digits of GSTIN, else chosen state (unregistered). Same state → CGST + SGST, each = round(taxable × rate/2); different state → IGST.
- Per line: taxable = round(qty × rate) − discount; tax rounded half-up to paise per line. Invoice round-off to nearest rupee as a separate field.
- Estimates: no GST, own series, excluded from GST summary.
- Not handled (D26): GST on advances, reverse charge, e-invoice / e-way bill.

## 5. Derived statuses (SQL views / queries — never stored)
- **Invoice**: open = total − allocations (receipts, CN, JV). Cancelled → Cancelled; open = 0 → Paid; due_date < today and open > 0 → Overdue; open < total → Part Payment; else Unpaid.
- **Pipeline label** (customer history): invoice status if invoiced, else job status, else quotation status.
- **Print job**: mode job_cost → follows the job; billed → follows its invoice; otherwise open = amount − allocations → 0 Paid, partial Part Payment, full + customer.is_credit_customer → Credit Customer, else Unpaid.
- **Vendor bill**: same as invoice, using vendor allocations.

## 6. Numbering (counters table, SELECT … FOR UPDATE, same transaction as the document)
| Series | Example | Resets |
|---|---|---|
| quotation | QT/26-27/0001 | FY |
| job | RDS-2026-00125 | calendar year |
| tax invoice | RDS/26-27/0001 (≤16 chars — GST) | FY |
| estimate | EST/26-27/0001 | FY |
| credit note / debit note | CN/26-27/0001 · DN/26-27/0001 | FY |
| receipt · vendor payment · purchase bill (internal) · expense · transfer · adjustment | RC/ · VP/ · PB/ · EX/ · TR/ · JV/ + 26-27/0001 | FY |
| material request · purchase order · GRN · stock issue · stock adjustment | MR/ · PO/ · GRN/ · SI/ · SA/ + 26-27/0001 | FY |
| print job | PJ/26-27/00001 | FY |

Tax invoice / CN / DN get their number when ISSUED (drafts show "Draft"); everything else when first saved. Cancelled documents keep their number. Search must also match unpadded forms (RDS-2026-125).

## 7. Approvals & audit
- **Needs owner approval when done by anyone else** (owner runs it directly; still audited): invoice cancel · receipt edit/cancel · vendor payment edit/cancel · purchase bill cancel · discount above settings.discount_limit_bp · credit note issue · any document dated before today − settings.backdate_days · customer outstanding adjustment (JV touching a customer) · stock adjustment.
- **Mechanism**: action → needs approval? → create approval_request with the full payload → owner approves → the same server function runs with the stored payload. Reject → nothing changes.
- **Audit**: one Postgres trigger function on every business table writes old/new jsonb + `current_setting('app.user_id', true)`. The app sets it via `set_config('app.user_id', id, true)` at the start of each write transaction. journal_entries, journal_lines and audit_log are append-only (triggers block UPDATE/DELETE).

## 8. Permissions
Static map in web/src/lib/permissions.ts + per-user can_view_cost.

| Area | owner | accountant | sales | production |
|---|---|---|---|---|
| Customers | full | full | view / create / edit | — |
| Vendors | full | full | — | — |
| Quotations | full | view | full | — |
| Jobs | full | view | create / view | view + status changes (no money) |
| Invoices, CN/DN | full | full (CN via approval) | view (for follow-up) | — |
| Receipts, vendor payments | full | full | — | — |
| Follow-ups | full | full | full | — |
| Purchase bills, expenses, cash & bank, JV | full | full (JV via approval) | — | — |
| Material requests | full + approve | view / create | — | create / view |
| Stock issue | full | full | — | create (qty only) |
| Stock adjustment | full | request | — | — |
| Print jobs (web) | full | full | view | view (no money) |
| Dashboard & reports | all | all | sales / outstanding / follow-ups (no cost) | — |
| Settings, users, approvals, devices | full | — | — | — |

can_view_cost default: owner and accountant true; sales and production false. Strip cost / profit / purchase-rate fields in the server loader, not just the UI.

## 9. Stock
Weighted average per item: avg = Σ value ÷ Σ qty over its stock_moves. Issue value = qty × avg (half-up). Block an issue beyond available qty ("enter the purchase or an adjustment first"). One unit per item, no conversion.

## 10. Job costing
- Job sale = taxable value of issued invoice lines for the job − credit notes on them.
- Costs by bucket: **material** = stock issues + job-tagged purchase/expense lines with bucket material; **labour / installation / transport / printing / other** = job-tagged expense and purchase lines by their category bucket + manual job_cost_entries; **printing** also = attached print jobs (at machine cost rate).
- Profit = sale − total cost; margin %. Only for can_view_cost users. SPEC S11 example is the acceptance test.
- Product-wise profit = each job's profit split across its line categories pro-rata to taxable value.

## 11. Print jobs & agent
- **print_jobs**: number, client_uuid (unique, idempotency), customer_id, job_id (null = standalone), mode (sale | job_cost), file_name, file_path, thumbnail attachment, machine_id, printing_type_id, width_milli, height_milli (feet), qty_milli, sqft_milli (= w × h × qty), rate_paise, amount_paise, operator_user_id, operator_name, device_id, printed_at, reprint_of_id, status (active | cancelled).
- New job → mode sale, rate defaults to machine sale rate. Existing job → mode job_cost, rate defaults to machine cost rate, adds to the job's printing bucket and printed qty.
- Paid / advance at the popup → a Receipt (mode cash | upi) allocated to the print job. Credit → no receipt.
- Standalone print jobs become sales when billed: "Bill selected print jobs" → invoice or estimate (one per customer); their allocations move to the invoice.
- Reprint: same file path/name found → ask New vs Reprint. Reprint = new row with reprint_of_id and its own qty & amount.
- Edit/cancel: owner/accountant only, audited.
- **print_devices**: name, token_hash, last_seen_at, revoked_at. Agent API under /api/agent/* uses the device token (Bearer), not user sessions.
- **Agent endpoints**: POST pair (one-time code → token) · GET bootstrap (customers, open jobs, machines, printing types, users) · POST print-jobs (idempotent by client_uuid) · GET reprint-check · POST thumbnail.
- **Agent (C#)**: pauses new jobs on mapped Windows printers → popup → PRINT = save to local queue, then resume the job; Cancel = delete the job. Queue syncs in the background — printing never waits for the internet. Operator = Windows user mapped to a CRM user. Machine = from printer mapping. File name = from the spool job.
- **Open File**: CRM link `radhe-crm://open?path=…` handled by the agent — ONLY paths under configured roots and only design / image / PDF extensions (.cdr .ai .pdf .eps .psd .tif .tiff .jpg .jpeg .png). Never .exe .bat .cmd .ps1 .vbs .lnk .msi or anything else.
- If the client's RIP software bypasses the Windows spooler (Q1), T40 switches to hot-folder / RIP-log mode — reviewer decides with Ronnie.

## 12. Dashboard numbers (S19, R1)
- Sales = taxable value of issued invoices + estimates − credit notes (excl. GST) — confirm (D24)
- Collection = receipts total
- Outstanding = Σ open amount of issued invoices + debit notes (advances shown separately)
- Purchase = purchase bills taxable
- Expense = expenses total
- Profit = income − expense accounts from the journal for the period; Gross profit = sales − job costs
- Cash = cash + petty_cash; Bank = bank_1 + bank_2 + upi
- Server-rendered, auto refresh every 60 s. No WebSockets.

## 13. Reports → source (S20)
1 Sales: invoice lines (by date/customer/category/sales person) − CN · 2 Collection: receipts · 3 Outstanding: invoice status view + aging · 4 Customer ledger: journal (ar, customer) · 5 Vendor ledger: journal (ap, vendor) · 6 Purchase: purchase bill lines · 7 Expense: expenses · 8 Profit: journal income − expense · 9 Job-wise profit: §10 · 10 Product-wise sales: invoice lines by category + §10 split · 11 Sales-person-wise: invoices by sales person · 12 Collection-person-wise: receipts by customer's collection person (received_by as a column) · 13 GST summary: tax invoices + CN/DN by rate & HSN, B2B/B2C, input GST from bills, net · 14 Cash book: journal (cash accounts) · 15 Bank book: journal (bank/upi) · 16 Stock valuation: stock_moves up to date · 17 Pending payment: vendor bill status view (D25) · 18 Advance received: unallocated receipts + job/print-job allocations not yet invoiced.
Print: Printed But Payment Pending = print jobs with status Unpaid / Part / Credit.
