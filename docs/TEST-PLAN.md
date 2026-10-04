# Manual test plan — Radhe CRM

For a guided walk-through on the local app (http://localhost:3000). The client is **Jay Patel**, owner of Radhe Digital Sign Board: he is the **owner login**. The test customer is **Shah Traders**. Each step says what to do and, after ✔, what you should see. Step ids (C5, F3 …) are used in docs/TEST-LOG.md.

Not testable yet: the Windows print popup (B15a / B15b), sending email (needs SMTP in web/.env), the live site (B17b).

## Step 0 — fresh start (Ronnie runs this himself)
1. In `web/.env` set `OWNER_USERNAME=jaypatel`, `OWNER_PASSWORD=` (8+ characters), `OWNER_NAME=Jay Patel`. Save.
2. Stop any running `pnpm dev`, then in PowerShell:
   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "DROP DATABASE radhe_dev WITH (FORCE);" -c "CREATE DATABASE radhe_dev OWNER radhe ENCODING 'UTF8' TEMPLATE template0;"
   cd D:\radhe-crm\web
   pnpm db:migrate
   pnpm db:seed
   pnpm dev
   ```
3. Log in as **jaypatel**. ✔ Top right shows Jay Patel · Owner.
Undo (old data): the backup `web/backups/radhe_dev-2026-10-03-1457.dump` (restore steps in docs/BACKUP.md).

## A — Set up the shop (as Jay Patel)
- **A1** Settings → Company: name Radhe Digital Sign Board, address, phone, email, bank details, UPI, invoice + quotation terms; upload logo and signature. ✔ Saved; History tab shows the change.
- **A2** Settings: discount limit 10 %, backdate days 3, default credit days 15. ✔ Saved.
- **A3** Settings → Books: books start date 01/04/2026; rename Bank 1 → "HDFC Bank"; openings Cash ₹10,000, HDFC Bank ₹1,00,000. ✔ Cash & Bank shows them.
- **A4** Users: create acc1 (Accountant), sales1 (Sales), prod1 (Production). ✔ Listed, active.
- **A5** Categories: 14 product + 21 expense categories present (GST 18 % default). ✔
- **A6** Print Jobs → Setup: machine "UV Roll to Roll", sale ₹25 / cost ₹12 per sq ft; printing type "UV print", category UV Printing. ✔
- **A7** Items → New: ACP Sheet, unit Nos, category ACP, GST 18 %, opening stock 10 @ ₹1,500. ✔ Stock 10, value ₹15,000.
- **A8** Vendors → New: Shree Acrylic, credit days 30. ✔

## B — Customer
- **B1** Customers → New: **Shah Traders** (contact Amit Shah), mobile, state Gujarat (24), billing + site address, credit limit ₹50,000, credit days 15, sales person sales1. ✔ Saved.
- **B2** Start another customer with the same mobile. ✔ Duplicate warning (not a block). Cancel it.

## C — Sales flow (most important)
- **C1** Quotations → New for Shah Traders: line 1 Flex Banner, size 10 × 3, unit Sq Ft → qty fills 30, rate ₹50; line 2 LED Sign Board, 1 Nos, ₹15,000, discount ₹500. ✔ Taxable ₹16,000 · CGST ₹1,440 · SGST ₹1,440 · Total ₹18,880.
- **C2** Save → QT/26-27/0001; PDF shows DRAFT; Send (try WhatsApp); Approve. ✔ Status Approved.
- **C3** On the quotation → Create job. ✔ RDS-2026-00001, every line copied.
- **C4** Receipts → New: Shah Traders ₹5,000 UPI, allocated to the job (advance). ✔ Job page shows the advance.
- **C5** As prod1 (separate window) → Jobs board. ✔ No ₹ anywhere. Move the job to Ready.
- **C6** As prod1 → Issue to job: ACP Sheet 2 Nos. ✔ Quantities only, no values.
- **C7** As prod1 → move the job to Delivered. ✔ History shows who / when.
- **C8** As Jay Patel → Print Jobs → New on job RDS-2026-00001, UV, 6 × 3 ft × 2. ✔ 36 sq ft, cost ₹432, no money asked.
- **C9** Expenses → New: Labour ₹2,000 cash on the job; Transport ₹500 on the job. ✔
- **C10** Job page → P&L card. ✔ Cost = material ₹3,000 + labour ₹2,000 + transport ₹500 + printing ₹432 = ₹5,932; "Expected sale / profit" shown as estimates.
- **C11** Invoices → New from job → Tax Invoice → Issue. ✔ RDS/26-27/0001 · Total ₹18,880 · Advance adjusted ₹5,000 · Balance ₹13,880; PDF has amount in words, bank, terms.
- **C12** Receipts → New: ₹13,880 cash. ✔ Invoice Paid; job P&L profit ₹10,068 (≈ 62.9 %).
- **C13** Shah Traders page: Overview, History (quotation → job → invoice → payments), Ledger, Statement PDF. ✔ Figures agree.

## D — Corrections & collections
- **D1** On the invoice → Credit note: LED line ₹1,000 returned → Issue. ✔ ₹1,180 credit on account.
- **D2** Invoices → New (blank): Shah Traders, Vinyl Printing ₹4,000 → Issue. ✔ ₹4,720.
- **D3** Customer page → Apply on-account: the ₹1,180 onto the new invoice. ✔ Part Payment, ₹3,540 open.
- **D4** Outstanding. ✔ Shah Traders ₹3,540 in the right aging bucket.
- **D5** Customer → Follow-ups → New: follow-up date 2 days ago, promise yesterday, expected ₹3,540. ✔ Alerts / bell: "Promise broken".
- **D6** Invoices → New → kind Estimate → Issue. ✔ EST/26-27/0001, no GST.
- **D7** Debit note on an invoice: extra ₹500. ✔ ₹590 due as its own receivable.

## E — Approvals & roles
- **E1** As sales1: quotation with ₹2,000 off a ₹15,000 line (over 10 %) → Send. ✔ "Sent for approval"; Jay Patel approves on Approvals.
- **E2** As acc1: receipt dated 7 days ago. ✔ Needs approval; approve as Jay Patel.
- **E3** As acc1: cancel RDS/26-27/0002. ✔ Approval request; after approval: Cancelled, number kept.
- **E4** As sales1: open /vendors and /settings. ✔ Sent away; dashboard shows no profit.
- **E5** As prod1: open the dashboard. ✔ Lands on Jobs.

## F — Purchase & stock
- **F1** As prod1 → Material Requests → New: ACP Sheet 20 Nos. As Jay Patel approve it (bell / Approvals). ✔
- **F2** On the request → Create PO: Shree Acrylic, rate ₹1,450 → PDF → Send. ✔ PO/26-27/0001.
- **F3** Material Receive: 10, then the other 10. ✔ PO Partly received → Received.
- **F4** Bill from the first GRN at ₹1,500 + 18 % GST. ✔ ₹17,700; ₹500 price difference.
- **F5** Vendor Payments → New: ₹10,000. ✔ Bill Part Payment; vendor Ledger and Statement agree.
- **F6** As acc1 → Stock Adjustments: ACP −1 (damaged). ✔ Needs approval; approve.
- **F7** Items → ACP Sheet stock card. ✔ 27 Nos with value and average.

## M — Money
- **M1** Cash & Bank: opening + received − paid = closing for each account; Transfer Cash → HDFC ₹5,000. ✔
- **M2** Cash Book (today): received / expense / deposited / refunds / other. ✔ Adds up to the closing.
- **M3** Cash count ₹100 below the book → post the difference. ✔ Cash short ₹100.
- **M4** Journal Vouchers → New: bank charges ₹100 (Dr Office Expense / Cr HDFC Bank). ✔
- **M5** Customer → Adjust → Write-off: the debit note's ₹590. ✔ Settled, posted to bad debts.

## P — Print jobs
- **P1** Print Jobs → New: Shah Traders, new work, UV, 6 × 3 × 2 → Unpaid with advance ₹500 UPI. ✔ 36 sq ft × ₹25 = ₹900; Part Payment 🟡.
- **P2** Print Jobs → Unbilled → Bill selected → Issue the draft. ✔ ₹1,062 invoice; the ₹500 moves onto it.
- **P3** Dashboard "Printing today" and the "Printed but payment pending" report. ✔ Figures agree.
- **P4** Settings → Devices → New pairing code. ✔ A code with a 10-minute expiry (the Windows app isn't built yet).

## R — Dashboard, reports, search
- **R1** Dashboard: Cash and Bank match Cash & Bank; Collection matches the receipts. ✔
- **R2** Reports: open all 20; on 3–4 try Excel, PDF, Print, Share — especially GST summary (this month) and Profit & loss. ✔
- **R3** Ctrl+K: `shah`, the mobile, `RDS-2026-1` (no zeros), `18,880`. ✔ Each finds the right documents.

## X — Data & phone
- **X1** Settings → Data → Download all data. ✔ Opens in Excel.
- **X2** Settings → Data → Import opening data: template, 2 new customers with old bills → Check → Import. ✔
- **X3** F12 → phone view (iPhone): dashboard, customer page, receipts, print jobs. ✔ No sideways scroll.
- **X4** Chrome's install icon → install as an app. ✔
