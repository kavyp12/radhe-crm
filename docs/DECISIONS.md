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

## 2026-09-28 — T01 review / T02 prompt
- **D27 Dev DB access**: app, migrations and tests connect as login role `radhe` (owner of radhe_dev + radhe_test), never as the postgres superuser. `pnpm test` wipes and re-migrates radhe_test every run and refuses any DB not named *_test.
- **D28 Packages approved at T01**: tsx (dev, runs TS scripts). From shadcn init: radix-ui, class-variance-authority, lucide-react, tw-animate-css, shadcn (CSS import), cn (shadcn-ui's clsx + tailwind-merge replacement). pnpm install scripts stay blocked (esbuild, sharp, unrs-resolver ignored; prebuilt binaries work) — allowing one needs reviewer OK.
- **D29 Next agent files**: keep web/AGENTS.md + web/CLAUDE.md written by `next dev`; they point agents to the Next docs in node_modules/next/dist/docs (hard rule 10).
- **D30 Rounding & display defaults**: half-up = half away from zero (negatives mirror positives, so reversals net to zero). Invoice round-off: 50 paise and above rounds up. Date presets: Week = Monday → today, Month = 1st → today. Amount in words: "Rupees One Lakh Twenty Thousand and Fifty Paise Only" (Indian system; match the client's invoice sample when Q3 arrives). — confirm presets at G1.

## 2026-09-28 — T02 review
- **D31 Numbering lock**: nextNumber = one `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the document's transaction (same row lock as SELECT … FOR UPDATE, and it creates a period's first row). Replaces the "SELECT … FOR UPDATE" wording in ARCHITECTURE §6.
- **D32 Journal entry number**: journal_entries.number = the number of the document that posted it (the "voucher no" in the T36 accountant export); no journal series of its own. A reversal entry carries the same number as the entry it reverses (+ reverses_entry_id). Entries with no numbered document (opening balances) leave it null.
- **D33 Two tasks per builder chat** (Ronnie, to go faster): from T03 a builder prompt may carry 2 linked tasks. Builder does them in order, runs checks and commits after each, and stops if the first fails. Reviewer reviews both commits together. Plan for Phase 0: T03 + T04 → T05 → T06 + T07.
- **D34 Batch T03 + T04 + T05** (Ronnie, amends D33's plan): one builder chat, one commit per task, with a pause after T04 so Ronnie approves the look before T05 builds more screens on it. Then T06 + T07. The Supabase driver for lib/storage.ts moves to T44 (can't be tested without the real bucket); T05 builds the local driver only.

## 2026-09-28 — design input (Ronnie)
- **D35 Look**: font Roboto everywhere (replaces Geist in DESIGN.md; next/font/google, subsets latin + latin-ext so ₹ renders in Roboto). The left sidebar is the main navigation: every module is its own item with an icon, grouped as DESIGN.md lists, count badges where useful (e.g. Approvals), collapsible to icons on desktop, drawer on phone. Quality bar: top-tier modern CRM (Attio / Linear / HubSpot level polish) while staying calm and dense per DESIGN.md.

## 2026-09-28 — T03–T05 review
- **D36 Areas missing from A§8**: purchase orders + material receive (GRN) = owner + accountant (like purchase bills). Stock items = owner + accountant full; production may view items without any values (needed to raise material requests and issue stock). Product / expense categories = owner + accountant.
- **D37 URLs**: the T04 URLs stand, except stock adjustments → /stock-adjustments (JV adjustment entries will use /journal-vouchers in T24).
- **D38 Users**: the owner resets passwords; staff can't change their own for now — confirm at G1. More than one owner is allowed (S21 "Owner/Admin"); nobody can disable or demote themselves, so an owner always remains. users.password_changed_at stays (puts resets on History).
- **D39 Approval thresholds while Settings are empty**: fail-safe. Empty discount limit = 0 (any discount by a non-owner needs approval); empty backdate days = 0 (any date before today needs approval). The owner fills real values in Settings.
- **D40 Opening balances**: one "books start date" in Settings; every opening balance (customer, vendor, money account; stock in T17) posts on that date per A§3. Only owner + accountant enter or change opening balances (they post to the journal); a change = reverse + repost. Reference data (system accounts, categories, their expense accounts) is inserted by migrations so the test DB has it too.
- **D41 Expense category cost buckets** (defaults, editable — confirm at G1): Acrylic, ACP, LED Module, SMPS, Aluminium, Flex, Vinyl, Ink, Welding Material, Electrical Material → material · Labour → labour · Installation → installation · Transport, Diesel/Petrol → transport · Miscellaneous → other · Machine Repair, Electricity, Rent, Salary, Office Expense, Marketing → none (overheads). Product categories start at gst_bp 1800 (A§2) until Q2.
- **D42 Batches** (amends D33/D34, Ronnie wants speed): up to 4 linked tasks per builder chat, one commit per task, stop if a task's checks fail. A 🚦 task is last in its batch (or the builder pauses after it). Plan: TASKS.md "Batch plan". Also settled: bank details stay one text block (printed as-is); attachments have no remove (soft-hide only if the client asks); login rate-limit moves to the DB at T44; Better Auth session tables stay unaudited.

## 2026-09-28 — B4 review / B5 prompt
- **D43 Books start date**: can change (openings move with it) only while the journal holds nothing but opening balances; locked once any document has posted. No document may be dated before it.
- **D44 Sales-document gates**: estimates get their number at Issue, like tax invoices (A§6 said "first saved"; changed so abandoned drafts leave no gaps). The A§7 discount and backdate approvals apply when a document leaves Draft: quotation Send, invoice Issue. Drafts may hold anything. Executors re-check the document's state when they run (the request may be stale).
- **D45 Cancel date**: a cancelled document's reversal is dated on the document's own date, so it nets to zero in its own period (same as openings). Once that month's GST return is filed, use a credit note (T16) instead; the cancel dialog says so. — confirm with the client's CA at G1.
- **D46 Sales details**: quotation / job / invoice lines: W × H ft is the board size (printed `6 × 3 ft`); the amount is always qty × rate (A§4). With unit "Sq Ft" and both sizes filled, qty defaults to W × H (editable). Unit = free text with suggestions (Nos, Sq Ft, Rft, Set). One job per approved quotation. Customers get an optional email (for sending PDFs); a new Settings field holds default quotation terms. Share link = random token → public /share/<token> serving that PDF only. PDFs of drafts say DRAFT, of cancelled documents CANCELLED. B5 also adds a duplicate GSTIN / mobile warning (not a block) on customers and vendors, and the check-digit test for the Settings GSTIN.

## Open questions (reviewer: when answered, add a new decision above and strike the question)
- **Q1** Print workflow per PC: machines list; CorelDRAW → Windows printer, or RIP software (Maintop / PhotoPrint / Onyx / Caldera / other)? Where are job files saved (local D:\ or shared drive)? — blocks T40.
- **Q2** HSN/SAC + GST % per product category (from their CA). — before go-live; invoices work with blanks until then.
- **Q3** Company details for invoices: legal name, address, GSTIN, phone, email, bank, UPI, logo, signature, terms; sample of current invoice + quotation. — placeholders until then (T10/T12).
- **Q4** Staff list with roles; sales persons; collection persons.
- **Q5** Opening data: customer dues (bill-wise?), vendor dues, stock, cash/bank — source Tally or Excel? — needed by T43.
- **Q6** Confirm D17, D19, D24, D25 at G1.
- **Q7** Machines: selling rate and internal cost rate per sq ft.
