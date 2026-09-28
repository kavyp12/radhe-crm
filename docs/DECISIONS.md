# Decisions (locked) — Radhe CRM
To change one: Ronnie agrees → the reviewer adds a NEW dated entry below. Never edit old entries silently.

## 2026-09-28 — setup
- **D01 Stack**: TypeScript + Next.js (App Router) in web/, pnpm. One app = UI + server actions + route handlers. No separate backend.
- **D02 Database**: PostgreSQL. Dev: local PostgreSQL 16 (installed) with databases `radhe_dev` + `radhe_test`. Prod: Supabase Postgres (Mumbai). Don't use features newer than PG16.
- **D03 ORM**: Drizzle + postgres.js + drizzle-kit migrations. Triggers/functions live in custom SQL migrations.
- **D04 Auth**: Better Auth, username + password, no email verification. Roles in ARCHITECTURE §8.
- **D05 UI**: Tailwind + shadcn/ui, TanStack Table, Recharts (charts), lucide icons. Rules in docs/DESIGN.md.
- **D06 PDF**: @react-pdf/renderer on the server. Register Noto Sans + Noto Sans Gujarati (built-in Helvetica has no ₹ glyph and no Gujarati).
- **D07 Sharing**: Excel via exceljs. Email via nodemailer (SMTP from env). WhatsApp = wa.me link with message + public share link (random token) to the PDF. No paid WhatsApp API.
- **D08 Files**: local disk (web/uploads) in dev, Supabase Storage (private bucket, signed URLs) in prod, behind one small lib/storage.ts.
- **D09 Tests**: Vitest against the real Postgres test DB (radhe_test). Money / GST / allocation / posting / numbering / permission logic must have tests.
- **D10 Hosting**: Vercel (functions region bom1 Mumbai, root dir web/) + Supabase (Mumbai). Free tiers during build; paid at go-live (Vercel Pro + Supabase Pro ≈ ₹4k/month, client pays). Backups: Supabase daily + our nightly pg_dump.
- **D11 Print agent**: C# WinForms tray app, .NET 10 LTS (machine has SDK 9.0.101 → install 10 in T40; fall back to net9 only if blocked), single-file publish.
- **D12 Single tenant** (Radhe only). Reselling later = separate deployment + DB per shop. No multi-tenant code.
- **D13 Numbers**: money integer paise; qty/size integer thousandths; GST rate basis points (1800 = 18%). Rounding half-up per line; invoice round-off to nearest rupee.
- **D14 Double-entry journal** is the only source for balances (ARCHITECTURE §3).
- **D15 Posted docs frozen**; cancel/edit via reversal + approval (ARCHITECTURE §7). Never hard delete.
- **D16 Numbering** per ARCHITECTURE §6. Job number uses calendar year (client example RDS-2026-00125).
- **D17 Aging** buckets 0–7 / 8–15 / 16–30 / 31–60 / 60+ by invoice-date age; "Overdue" = past due date (invoice date + customer credit days). — confirm at G1.
- **D18 Estimate (non-GST)** = separate document kind + series; counted in ledger/outstanding; excluded from GST summary.
- **D19 Print jobs**: attached to an existing job = job cost (printing bucket, machine cost rate); new job = sale, billed later on an invoice/estimate; money received at the popup = receipt allocated to the print job. — confirm at G1.
- **D20 Stock**: weighted average cost, no negative stock, no unit conversion (purchases entered in the stock unit).
- **D21 Material receive (GRN)** posts stock at PO rate via grn_clearing; bill difference → price_variance.
- **D22 Alerts/reminders** = dashboard queries + bell count. No SMS/WhatsApp auto-reminders, no background worker.
- **D23 Locale**: English UI. DD/MM/YYYY, Asia/Kolkata, FY April–March, ₹ en-IN grouping. Sizes in feet (decimals allowed).
- **D24 Dashboard** definitions per ARCHITECTURE §12. "Sales" excludes GST. — confirm at G1.
- **D25 "Pending Payment Report"** (S20 #17) = vendor bills pending payment (customer side = Outstanding report). — confirm at G1.
- **D26 Not built unless the client asks**: GST on advances, reverse charge, e-invoice / e-way bill, GSTR JSON, Tally XML (journal Excel export instead), delivery challan PDF, multi-language, dark mode, native mobile app (PWA instead), cheque clearing, purchase returns, unit conversion, per-user custom permissions (only the can_view_cost toggle), WebSockets.

## Open questions (reviewer: when answered, add a new decision above and strike the question)
- **Q1** Print workflow per PC: machines list; CorelDRAW → Windows printer, or RIP software (Maintop / PhotoPrint / Onyx / Caldera / other)? Where are job files saved (local D:\ or shared drive)? — blocks T40.
- **Q2** HSN/SAC + GST % per product category (from their CA). — before go-live; invoices work with blanks until then.
- **Q3** Company details for invoices: legal name, address, GSTIN, phone, email, bank, UPI, logo, signature, terms; sample of current invoice + quotation. — placeholders until then (T10/T12).
- **Q4** Staff list with roles; sales persons; collection persons.
- **Q5** Opening data: customer dues (bill-wise?), vendor dues, stock, cash/bank — source Tally or Excel? — needed by T43.
- **Q6** Confirm D17, D19, D24, D25 at G1.
- **Q7** Machines: selling rate and internal cost rate per sq ft.
