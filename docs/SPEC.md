# SPEC — what the client asked for (English)
Faithful English version of docs/client/*. No additions here — design choices live in DECISIONS.md and ARCHITECTURE.md.
IDs: S1–S27 = accounting module · R0–R1 = main rules · P1–P10 = print jobs.

## S1 Customer account
Fields per customer: customer name, firm name, mobile number, GST number, billing address, delivery/site address, opening balance, credit limit, credit days, total business, total received, total outstanding, last payment date.
Opening a customer shows their complete history: Quotation → Order → Invoice → Payment → Pending amount.

## S2 Quotation → invoice flow
The same data must never be entered again and again.
Flow: Quotation → customer approves → Work order generated → Production → Delivery → Invoice generated → Payment entry.
Quotation details transfer directly into the invoice.
Statuses: Draft, Sent, Approved, In Production, Ready, Delivered, Invoiced, Part Payment, Paid, Overdue.

## S3 Job / order-wise accounting
Every job gets a unique job number, e.g. RDS-2026-00125.
A job has: customer, product, size, qty, rate, GST, total amount, advance, balance, material cost, labour cost, installation cost, transport cost, other expense, final profit.
Purpose: the owner knows the actual profit of each particular board/job.

## S4 Product / service category (compulsory for accounting reports)
LED Sign Board · Acrylic Channel Letter · ACP Elevation · Glow Sign Board · Flex Banner · Vinyl Printing · One Way Vision · Frosted Film · UV Printing · CNC Cutting · Laser Cutting · Aluminium Channel Letter · Installation/Fitting · Other.
Report: how much sales and profit came from each service.

## S5 Sales invoice
Fields: invoice number, date, customer, GST number, product description, HSN/SAC, qty, rate, discount, taxable amount, CGST, SGST / IGST, round off, grand total, advance adjustment, balance.
Options: GST invoice · non-GST / estimate as required · print · PDF · WhatsApp share · email.

## S6 Payment collection
Receipt fields: customer, invoice number, amount, date, payment mode (cash, UPI, bank, cheque), reference number, received by, notes.
If a customer pays several invoices at once → payment allocation.
Example: received ₹50,000 → Invoice A ₹20,000 · Invoice B ₹25,000 · Advance ₹5,000.

## S7 Outstanding management
Dashboard shows clearly: total receivable, today due, overdue, 0–7 days, 8–15 days, 16–30 days, 31–60 days, 60+ days.
Outstanding customer-wise, invoice-wise, sales-person-wise, collection-responsible-person-wise.

## S8 Payment follow-up
For customers with outstanding: follow-up date, follow-up person, customer response, promise-to-pay date, expected amount, next reminder.
Example: customer ABC Enterprise · outstanding ₹42,500 · promise date 30/09/2026 · expected payment ₹25,000 · follow-up person Jaydeep.
When the promise date passes → dashboard alert.

## S9 Purchase account
Vendor/supplier: vendor name, GST number, mobile, purchase bill number, bill date, material, amount, GST, total, paid, pending, due date.
Supplier ledger works like the customer ledger.

## S10 Expense management
Categories: Acrylic · ACP · LED Module · SMPS · Aluminium · Flex · Vinyl · Ink · Welding Material · Electrical Material · Labour · Installation · Transport · Diesel/Petrol · Machine Repair · Electricity · Rent · Salary · Office Expense · Marketing · Miscellaneous.
Expense entry: date, category, vendor, job number (optional), amount, payment mode, bill photo, notes.

## S11 Job costing (very important for Radhe)
Example: job sale ₹1,00,000 · material ₹42,000 · labour ₹8,000 · printing ₹4,000 · installation ₹6,000 · transport ₹2,000 → total cost ₹62,000 → gross profit ₹38,000.
Must be calculated automatically.

## S12 Advance payment
When the customer approves a quotation and an advance is received: advance entry → customer account → attached to that particular job.
When the invoice is generated, the advance is adjusted automatically.

## S13 Cash & bank
Accounts: Cash · Bank Account 1 · Bank Account 2 · UPI · Petty Cash.
Dashboard: opening balance + receipts − payments = closing balance.

## S14 Daily cash book
Daily report: opening cash, cash received, cash expense, cash purchase, cash deposited in bank, closing cash.
Facility to match the system-calculated balance with the actual (counted) balance.

## S15 Ledger (generated automatically)
Customer ledger: invoice, payment, debit/credit, balance. Vendor ledger: purchase, payment, balance.
Date-wise statement can be printed / PDF / shared.

## S16 Credit note / debit note
For invoice correction, returns, discount adjustment etc. Must be linked to the original invoice.

## S17 Stock + accounting
Material purchase → stock increases. Material issued to a job → stock reduces.
Items e.g. acrylic, ACP sheet, LED module, SMPS, aluminium coil, vinyl, flex, ink, glue, wire.
Stock cost can be added to job cost automatically.

## S18 Purchase request / approval
Production team requests material: Material request → approval → purchase → material receive → stock → vendor bill → payment. All connected in the same chain.

## S19 Dashboard (owner, at a glance)
Today: sales, collection, purchase, expense.
Current: total receivable, total payable, cash balance, bank balance.
Performance: monthly sales, monthly collection, monthly expense, gross profit, outstanding, top customers, top services.

## S20 Reports
Filters: Today / Yesterday / Week / Month / Custom date.
1 Sales · 2 Collection · 3 Outstanding · 4 Customer ledger · 5 Vendor ledger · 6 Purchase · 7 Expense · 8 Profit · 9 Job-wise profit · 10 Product-wise sales · 11 Sales-person-wise sales · 12 Collection-person-wise collection · 13 GST summary · 14 Cash book · 15 Bank book · 16 Stock valuation · 17 Pending payment · 18 Advance received.

## S21 User rights
Not every employee sees everything.
- Owner/Admin: full access.
- Accountant: invoice, payment, purchase, expense, ledger, reports.
- Sales person: customer, quotation, order, collection follow-up. Profit / purchase cost can be hidden.
- Production team: only job / production details.

## S22 Approval system
Need Owner/Admin approval: invoice delete, payment delete/edit, purchase bill delete, discount above limit, credit note, old-date entry, customer outstanding adjustment.
Instead of delete, preferably Cancel/Void with history.

## S23 Audit log
Track: who created, who edited, old value, new value, date & time. Accounting entries can't be silently edited or deleted.

## S24 Document attachment
Attach to entries: purchase bill photo, payment screenshot, cheque, customer PO, quotation, delivery challan, installation photo.

## S25 Automatic reminders (system alerts)
Payment due today · payment overdue · promise-to-pay due · vendor payment due · customer credit limit exceeded.

## S26 Search
One universal search by: customer name, mobile, GST number, job number, quotation number, invoice number, amount, vehicle/site reference (if used).

## S27 Data export / backup
Excel export compulsory. Reports downloadable/shareable as PDF. Regular backup system. Keep accounting data export/integration possible so data can be exchanged with external accounting software in future.

## R0 Most important rule
The same information is entered only once. Quotation → Order → Job → Delivery → Invoice → Payment → Ledger — all automatically connected.

## R1 Owner dashboard — main numbers (real-time)
Sales | Collection | Outstanding | Purchase | Expense | Profit | Cash | Bank

---

# Print jobs (client document 2, originally in Gujarati)

## P1 Goal & flow
When any Radhe computer sends a file for printing, a Print Job entry is created in the CRM automatically.
Flow: computer file → print command → small CRM popup → select customer → job details → Print → automatic CRM entry.

## P2 Popup (appears before printing)
Customer name · mobile number · existing job no. / new job · file name (automatic) · machine select · printing type · width · height · quantity · sq ft (automatic calculation) · rate · total amount (automatic) · Paid / Unpaid / Credit · advance received · balance · operator name (automatic) · date & time (automatic).
Actual printing starts only when PRINT is pressed.

## P3 Automatic CRM entry
Example: customer ABC Enterprise · file ABC_FRONT_BOARD.cdr · machine UV Roll to Roll · size 6 × 3 ft · qty 2 · total 36 sq ft · rate ₹25 · amount ₹900.
Payment status shown as 🔴 PAYMENT PENDING – ₹900 or 🟢 PAYMENT RECEIVED – ₹900.

## P4 Existing customer job
If the printing is for an order/job already running → "Attach to Existing Job" option (e.g. Job No RDS-2026-125). All printing cost / quantity is added to that job automatically.

## P5 Payment status
Separate statuses for print jobs: 🔴 Unpaid · 🟡 Part Payment · 🟢 Paid · 🔵 Credit Customer.
When payment is received, the print job status updates automatically. Invoice payments and print job payments must be linked to each other.

## P6 Print history
Opening a customer shows all print history: Print Date | File | Machine | Size | Qty | Amount | Payment.

## P7 File link
Store the original file's location in the CRM (e.g. D:\RADHE JOBS\ABC\ABC_FRONT_BOARD.cdr). "Open File" button in the CRM. Show preview/thumbnail if possible.

## P8 Reprint
If the same file is printed again, the system asks: New Print Job or Reprint Existing Job. Reprint quantity and cost are recorded separately.

## P9 Owner alert
Dashboard: today's print jobs (e.g. 42) · print value (₹28,450) · received (₹19,000) · pending (₹9,450).
Special report "Printed But Payment Pending": work already printed but not yet paid must be visible immediately.

## P10 Important
Just opening a file without printing must NOT create a CRM entry. A print job is created only after the actual print command / print confirmation. If a print job is deleted/edited, audit history must remain.
