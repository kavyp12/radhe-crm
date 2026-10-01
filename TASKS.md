# TASKS — Radhe CRM (full scope)
Only the REVIEWER ticks [x]. One task = one fresh builder chat = one commit.
Refs: S/P/R = docs/SPEC.md · A§ = docs/ARCHITECTURE.md · D = docs/DECISIONS.md
🚦 = Ronnie checks the app himself before the reviewer ticks.

## Phase 0 — Foundation
- [x] **T01 · Scaffold & dev environment** — D01–D03, D09
  Next.js app in web/ (App Router, TS, Tailwind, src/, alias @/*, pnpm); shadcn/ui init; Drizzle + postgres.js + drizzle-kit; create radhe_dev + radhe_test on local Postgres 16; Vitest wired to radhe_test (migrate before run); scripts dev / build / start / typecheck / lint / test / db:generate / db:migrate / db:seed; web/.env.example; fill the "Commands" section in CLAUDE.md.
  Done when: `pnpm dev` serves localhost:3000 · typecheck clean · one DB smoke test passes on radhe_test · migrations run on radhe_dev.

- [x] **T02 · Number, date & numbering helpers** — D13, D16, D23, A§4, A§6
  lib/num.ts: paise/milli parsing from strings (no floats), en-IN ₹ format, qty × rate with BigInt half-up, GST line calc (CGST+SGST vs IGST), invoice totals + round-off, amount in words (lakh/crore). lib/dates.ts: IST today, FY key "26-27", DD/MM/YYYY, period presets. counters table + nextNumber(tx, series, date) for every series in A§6.
  Done when: tests cover .5-paise rounding · same vs other state · round-off · ₹1,00,000.00 grouping · amount in words · FY boundary 31-Mar/1-Apr · two parallel transactions never get the same number.

- [x] **T03 · Login, users, roles** — S21, D04, A§8
  Better Auth (username + password); role + can_view_cost + active; login/logout; every app route requires login; lib/permissions.ts map + requireUser() / requirePermission(); seed owner from env; Users page (owner): create, role, can_view_cost, disable, reset password.
  Done when: tests for allowed/denied samples of each role · disabled user can't log in · unauthenticated → /login.

- [x] **T04 · App shell & design system** 🚦 — docs/DESIGN.md, R1, S19
  Sidebar (role-filtered), top bar (search placeholder, + New, bell placeholder, user menu), page header, DataTable (sort / filter / paginate / totals row), StatusBadge (all statuses), Money & Date components, form + line-items grid pattern, empty/loading states, toasts. Dashboard page with dummy data: the 8 numbers + S19 sections. Works at phone width.
  Done when: Ronnie approves the look (reviewer tells him exactly what to open).

- [x] **T05 · Audit log, settings, attachments** — S22–S24, A§7, D08
  audit_log + generic trigger (custom SQL migration) + write-transaction helper setting app.user_id (also wrap T03's user writes); reusable History tab (who / when / old → new). Settings page (company profile, logo, bank, UPI, terms, discount limit, backdate days, default credit days). lib/storage.ts (local driver; Supabase driver in T44 — D34); attachments table + upload (phone camera capture) + list/preview component with S24 kinds.
  Done when: test proves an app update writes an audit row with user + old/new · upload and view work locally · settings save.

- [x] **T06 · Ledger core** — D14, A§3
  accounts + seed chart; journal_entries / journal_lines; DB triggers: deferred balance check, append-only; posting service post() / reverse(); money accounts Cash, Petty Cash, UPI, Bank 1, Bank 2 with opening balance; ledger query helper (date range, running balance).
  Done when: tests: unbalanced entry rejected · UPDATE/DELETE on journal rejected · reverse nets to zero · running balance correct.

- [x] **T07 · Approvals framework** — S22, A§7
  approval_requests; helper: owner runs the action directly, others create a request; Approvals page (pending list, old → new view, approve/reject + note); executor registry; backdate-check and discount-limit-check helpers; bell count of pending approvals for owner.
  Done when: test with a dummy action: non-owner → request · approve → runs exactly once · reject → no change · all audited.

## Phase 1 — Masters
- [x] **T08 · Customers** — S1, A§2
  CRUD with all S1 fields + state, sales person, collection person, credit-customer flag; GSTIN format + state-code check; opening balance posts to journal; list (search, outstanding column); detail page with Overview (total business, received, outstanding, last payment date — from journal/docs), Attachments and History tabs.
  Done when: tests: GSTIN validation · opening balance appears in AR ledger · edit is audited.

- [x] **T09 · Vendors & categories** — S4, S9, S10
  Vendors CRUD (name, GSTIN, state, mobile, address, credit days, opening balance → journal). Product categories (14 seeded; HSN/SAC blank, GST % editable). Expense categories (21 seeded; each with its own expense account + cost bucket).
  Done when: seeds are idempotent · vendor opening shows in AP ledger.

## Phase 2 — Sales flow
- [x] **T10 · Quotations** — S2, S4, S5, A§4
  Line grid (category required, description, HSN/SAC, W × H ft optional, qty, unit, rate, discount, GST %); live totals (CGST+SGST or IGST, round-off); terms; statuses Draft / Sent / Approved / Cancelled; discount over limit → approval; duplicate; PDF (A4, ₹ + Gujarati fonts) + print + WhatsApp share link (public token) + email; list with filters.
  Done when: totals tests · PDF renders ₹ and a Gujarati name · status rules enforced on the server.

- [x] **T11 · Jobs (work orders)** — S2, S3, S26
  Create from an approved quotation (lines copied, nothing retyped) or blank; number RDS-YYYY-NNNNN; site address, site reference, vehicle no, sales person, target date; statuses In Production → Ready → Delivered with who/when; production board; production role gets no money fields (stripped on server); cancel.
  Done when: test: production user's job data has no rate/amount fields · status history recorded · quotation → job copies lines.

- [x] **T12 · Invoices** — S5, S2, A§3–§6
  From job(s) / quotation / blank; kind Tax Invoice or Estimate; place of supply auto; due date = date + credit days; Issue → number + journal post, then frozen; cancel via approval (reversal, number kept); credit-limit warning; jobs → Invoiced; PDF (amount in words, bank, terms) + print + WhatsApp + email.
  Done when: posting tests (same state, other state, estimate) · cancel reverses · issued invoice can't be edited · PDF correct.

- [x] **T13 · Receipts & allocation** — S6, A§2, A§5
  Receipt (customer, date, amount, mode → money account, cheque no/date, reference, received by, notes, screenshot attachment); allocation panel (open invoices, FIFO auto-fill, remainder = advance); posts Dr money / Cr AR; invoice status view (Unpaid / Part / Paid / Overdue); edit/cancel via approval.
  Done when: test reproduces the S6 example (50,000 → 20,000 + 25,000 + 5,000 advance) · over-allocation blocked · statuses update.

- [x] **T14 · Advances auto-adjust** — S12, S5
  Receipt allocated to a job as advance; on invoice issue the job's advances move to the invoice automatically (up to invoice total); invoice shows Advance Adjustment + Balance.
  Done when: test: 10,000 advance on job → 25,000 invoice → balance 15,000 · extra advance stays as advance.

- [x] **T15 · Customer 360 & ledger** — S1, S15
  Customer History timeline (quotation → job → invoice → payment → pending, all linked, derived pipeline status); Customer Ledger (date range, opening, running Dr/Cr); statement PDF / print / WhatsApp.
  Done when: ledger closing = AR balance · statement PDF correct.

- [x] **T16 · Credit & debit notes** — S16, S22
  Linked to the original invoice; reason; lines from the invoice (partial qty/amount); GST reversed; CN needs approval for non-owner; CN allocates to its invoice; DN adds receivable; PDFs.
  Done when: tests: CN reduces invoice open amount + GST output · DN increases them.

- [ ] **🚦 G1 · Sales-flow demo** — Ronnie (and client) walk through quotation → job → invoice → receipt → ledger on real-looking data. Confirm D17, D19, D24, D25, D30, D38, D41, D45. Reviewer records answers in DECISIONS.md.

## Phase 3 — Purchase, expenses, stock
- [x] **T17 · Stock core** — S17, D20, A§9
  Stock items (name, unit, category, HSN, GST %); stock_moves; weighted average; opening stock (→ journal); stock adjustment via approval; item stock card; current stock list.
  Done when: tests: avg cost after several ins · issue beyond stock blocked · adjustment posts correctly.

- [x] **T18 · Purchase bills** — S9, S24, A§3
  Vendor bill (vendor bill no unique per vendor, bill date, due date, lines = stock item or expense category + qty + rate + GST, optional job per line); bill photo; posting + stock-in; cancel via approval.
  Done when: posting tests (stock line, expense line, GST input) · stock qty/avg updated · duplicate vendor bill no blocked.

- [x] **T19 · Vendor payments & vendor ledger** — S9, S15
  Payment + allocation to bills (FIFO) + on-account; posting; bill status (derived); vendor ledger + statement PDF.
  Done when: tests: allocation + bill status · vendor ledger closing = AP balance.

- [x] **T20 · Expenses** — S10, S24
  Entry per S10; posts Dr category account / Cr money account; optional job tag; bill photo; list with filters; edit = reverse + repost, audited.
  Done when: posting test · job-tagged expense visible in job cost data · edit leaves reversal trail.

- [x] **T21 · Stock issue to jobs** — S17, S11
  Issue / return materials to a job at average cost; posting; blocked beyond stock; production role enters qty only (no values shown).
  Done when: tests: issue value = qty × avg · return restores stock · production user sees no values.

- [x] **T22 · Material requests & purchase orders** — S18
  Material request (production; optional job) → owner approval → purchase order (vendor, rates; PDF + WhatsApp to vendor); links between them.
  Done when: request → approve → PO flow works with permissions · PO PDF OK.

- [x] **T23 · Material receive & bill from GRN** — S18, D21
  GRN against PO (partial allowed; stock in at PO rate via grn_clearing); vendor bill created from GRN (price variance); chain view MR → PO → GRN → Bill → Payment on every document.
  Done when: posting tests (GRN, bill with price difference) · partial receipts tracked · chain links work both ways.

## Phase 4 — Money
- [x] **T24 · Adjustment entries (JV)** — S22, A§3
  Owner/accountant journal voucher (balanced lines, any account, optional party); customer outstanding adjustment (write-off/discount) that allocates to invoices; approval for non-owner and whenever a customer is touched.
  Done when: tests: unbalanced JV blocked · customer adjustment reduces invoice open amount · approval enforced.

- [x] **T25 · Cash & bank + transfers** — S13
  Money accounts page: opening + receipts − payments = closing per period for each account; transfers (cash → bank deposit, UPI → bank, bank → petty cash); account book view with running balance.
  Done when: tests: transfer posts both sides · closing = journal balance for each account.

- [x] **T26 · Daily cash book & cash count** — S14
  Daily view: opening cash, cash received, cash expense, cash purchase, deposit in bank, closing; enter counted cash → difference shown; owner can post the difference (cash short/excess).
  Done when: test: day totals match journal · difference posting works via approval.

## Phase 5 — Profit & collections
- [x] **T27 · Job costing** — S3, S11, A§10
  Job P&L card: sale, cost buckets (auto from stock issues, job-tagged expenses/purchase lines, attached print jobs; + manual internal cost entries), profit, margin, advance, balance. Hidden without can_view_cost.
  Done when: test reproduces the S11 example exactly (1,00,000 − 62,000 = 38,000) · sales/production users get no cost fields.

- [x] **T28 · Outstanding & aging** — S7, D17
  Total receivable, due today, overdue, aging buckets; customer-wise, invoice-wise, sales-person-wise, collection-person-wise views with drill-down.
  Done when: tests for bucket boundaries (7/8, 15/16, 30/31, 60/61 days) · totals equal AR open amounts.

- [x] **T29 · Follow-ups & alerts** — S8, S25
  Follow-up entries (date, person, response, promise date, expected amount, next reminder); "my follow-ups today"; alerts page + bell: payment due today, overdue, promise due, promise broken, vendor payment due, credit limit exceeded, pending approvals; credit-limit warning on quotation/job/invoice.
  Done when: test: broken promise (date passed, expected not received) raises alert · alert clears after payment.

## Phase 6 — Dashboard & reports
- [ ] **T30 · Owner dashboard (real data)** 🚦 — S19, R1, A§12
  The 8 numbers + Today / Current / Performance sections from real data; monthly charts; top customers and services; auto refresh 60 s; role-appropriate.
  Done when: each number matches a hand-checked query on seeded data · Ronnie approves.

- [ ] **T31 · Reports framework & export** — S20, S27
  Report page pattern (filters with Today/Yesterday/Week/Month/Custom, table, totals); Excel export (exceljs) for any report or list; PDF export (table PDF); print; share.
  Done when: one sample report exports correct Excel + PDF.

- [ ] **T32 · Reports A** — S20 #1, 2, 3, 11, 12, 17, 18
  Sales, Collection, Outstanding, Sales-person-wise, Collection-person-wise, Pending payment (D25), Advance received.
  Done when: each report's totals tie to journal/dashboard numbers on seeded data.

- [ ] **T33 · Reports B** — S20 #4, 5, 6, 7, 14, 15, 16
  Customer ledger, Vendor ledger, Purchase, Expense, Cash book, Bank book, Stock valuation.
  Done when: totals tie out on seeded data.

- [ ] **T34 · Reports C** — S20 #8, 9, 10, 13
  Profit (P&L), Job-wise profit, Product-wise sales & profit, GST summary (output by rate & HSN, B2B/B2C, CN/DN, input GST, net).
  Done when: GST summary ties to journal GST accounts · job profit ties to T27.

## Phase 7 — Search, export, backup
- [ ] **T35 · Universal search** — S26
  Ctrl+K palette; pg_trgm indexes; customers (name, firm, mobile, GSTIN), jobs (incl. unpadded RDS-2026-125), quotations, invoices, receipts, amounts, site reference / vehicle no.
  Done when: tests for each search type · results respect permissions.

- [ ] **T36 · Data export & backup** — S27
  Full Excel export (masters + all vouchers); journal export for the accountant (date, voucher type, no, ledger, Dr, Cr, narration); backup script (pg_dump) + restore steps documented.
  Done when: export opens in Excel correctly · backup + restore tested on a copy of radhe_dev.

## Phase 8 — Print jobs
- [ ] **T37 · Print jobs in CRM** — P2–P8, A§11, D19
  Machines + printing types masters (printer-name mapping, sale rate, cost rate); print_jobs; manual "New Print Job" form (same fields as the popup); Paid/Unpaid/Credit + amount received + mode → receipt; attach to existing job (job cost) vs new (sale); derived 🔴🟡🟢🔵 status; "Bill selected print jobs" → invoice/estimate; reprint (reprint_of); customer Print History tab; edit/cancel audited.
  Done when: tests: sq ft & amount calc (P3 example = 36 sq ft, ₹900) · statuses per A§5 · billing moves allocations · attached job gets printing cost.

- [ ] **T38 · Print dashboard, report, open file** — P6, P7, P9
  Dashboard tiles (today's print jobs, value, received, pending); "Printed But Payment Pending" report; unbilled print jobs list; Open File button (radhe-crm:// link) + thumbnail display.
  Done when: tile numbers tie to print job data · report lists exactly unpaid/part/credit jobs.

- [ ] **T39 · Agent API & device pairing** — A§11
  print_devices; owner creates a pairing code → agent exchanges it for a device token; revoke; proxy.ts must let /api/agent/* through (Bearer token, no cookie); endpoints: bootstrap, create print job (idempotent by client_uuid), reprint check, thumbnail upload.
  Done when: tests: same client_uuid twice → one print job · revoked token rejected · endpoints never accept user-session-only calls.

- [ ] **T40 · Print agent: hold + popup + offline queue** — P1, P2, P8, P10 · needs Q1 answer
  C# WinForms tray app in print-agent/: config (server URL, token, printer → machine map, file roots); pause new jobs on mapped printers; popup with auto fields (file name, machine, operator, date/time) + customer search (cached) + quick-add + existing/new job + sq ft/amount calc; PRINT → local queue → resume job; Cancel → delete job; background sync; reprint prompt.
  Done when: on Ronnie's PC with a test printer: print → popup → entry appears in CRM · Cancel prints nothing · internet off → prints, syncs later.

- [ ] **T41 · Print agent: open file, thumbnail, installer** — P7
  radhe-crm:// handler with root + extension allowlist; best-effort full file path; thumbnail via Windows shell; single-file publish + install script (startup, protocol registration); 1-page operator guide.
  Done when: Open File works for allowed files and refuses .exe/.bat/.lnk etc. · clean install on a second PC.

- [ ] **🚦 G2 · On-site print test at Radhe** — every PC and machine, offline test, reprint, payment flows; reviewer turns findings into fix tasks.

## Phase 9 — Go-live
- [ ] **T42 · Hardening**
  Automated check that every server action / route has a permission check; approvals verified in all modules; indexes for slow queries; error/404 pages (remove T04's "not built yet" catch-all); PWA manifest (install on phone); phone check of key screens.
  Done when: the permission check test passes · `pnpm build` clean · key screens OK at 390px.

- [ ] **T43 · Opening data import** — Q5
  Excel templates + import for customers (with bill-wise opening dues), vendors (opening dues), stock items (opening qty/rate), money account balances; validation preview before commit.
  Done when: sample import round-trips · trial balance = 0 after import.

- [ ] **T44 · Deploy** — D10
  Supabase prod (Mumbai) + storage bucket + Supabase driver for lib/storage.ts (D34); Vercel project (root web/, region bom1) + env; migrations; seed owner; Better Auth rate-limit storage in the DB (D42); domain; nightly pg_dump; prod smoke test; admin guide. (Pushing to GitHub/Vercel only with Ronnie's OK.)
  Done when: prod URL works end-to-end · backup job ran once · restore tested.

- [ ] **🚦 G3 · Client UAT & sign-off** — client uses it for real; reviewer converts feedback into fix tasks until sign-off.

## Batch plan (D42) — one builder chat per line; the reviewer checks each batch before the next
- ✅ B1 T01 · ✅ B2 T02 · ✅ B3 T03 + T04 + T05
- ✅ B4 T06 + T07 + T08 + T09 → Phases 0–1 done
- ✅ B5 T10 + T11 + T12
- ✅ B6 T13 + T14 + T15 + T16 → 🚦 G1 demo (open)
- ✅ B7 T17 + T18 + T19 + T20
- ✅ B8 T21 + T22 + T23
- ✅ B9 T24 + T25 + T26
- ✅ B10 T27 + T28 + T29
- B11 T31 + T30 🚦
- B12 T32 + T33 + T34
- B13 T35 + T36
- B14 T37 + T38 + T39
- B15 T40 + T41 (needs Q1) → 🚦 G2
- B16 T42 + T43
- B17 T44 (push only with Ronnie's OK) → 🚦 G3

## Spec coverage (reviewer keeps this in sync)
S1 T08, T15 · S2 T10–T12 · S3 T11, T27 · S4 T09, T10, T34 · S5 T12, T14 · S6 T13 · S7 T28 · S8 T29 · S9 T09, T18, T19 · S10 T09, T20 · S11 T21, T27 · S12 T14 · S13 T06, T25 · S14 T26 · S15 T15, T19 · S16 T16 · S17 T17, T21 · S18 T22, T23 · S19 T04, T30 · S20 T31–T34 · S21 T03 + every task · S22 T07 + modules · S23 T05 · S24 T05 + modules · S25 T29 · S26 T35 · S27 T31, T36, T44 · R0 all · R1 T30 · P1–P10 T37–T41
