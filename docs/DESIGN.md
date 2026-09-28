# Design — Radhe CRM
Goal: looks like a proper modern CRM, fast for daily data entry, numbers easy to read. Calm, dense, clear. Nothing flashy.

## Layout
- Left sidebar (collapsible; drawer on phone), grouped:
  - Dashboard
  - Sales: Customers, Quotations, Jobs, Invoices, Credit/Debit Notes, Print Jobs, Follow-ups
  - Money: Receipts, Vendor Payments, Expenses, Cash & Bank, Cash Book
  - Purchase: Vendors, Material Requests, Purchase Orders, Material Receive, Purchase Bills
  - Stock: Items, Issue to Job, Adjustments
  - Reports · Approvals · Settings
  - Show only what the user's role can open.
- Top bar: universal search (Ctrl+K), "+ New" menu, alerts bell with count, user menu.
- Page header: title, status badge, primary action on the right, secondary actions in a "⋯" menu.

## Page patterns
- **List**: filter bar (search, date preset Today/Yesterday/Week/Month/Custom, status) → table (sortable, sticky header, right-aligned money, totals row) → pagination. Row click opens detail.
- **Detail**: header (number, party, status, amount) + tabs (Details · Payments/Allocations · Attachments · History). Links to previous/next doc in the chain (Quotation ⇄ Job ⇄ Invoice ⇄ Receipts).
- **Form**: sections in cards; line-items grid (Tab moves across cells, Enter adds a row); live totals panel on the right (stacks below on phone); Save Draft / Issue buttons sticky at the bottom.
- Empty states: one line + primary action. Loading: skeletons. Errors: inline under the field + toast.

## Visual tokens
- Font: Geist Sans (ships with Next.js). All numbers `tabular-nums`.
- Base: neutral zinc greys, white cards on a zinc-50 background, 1px borders, radius 8px, shadows only on popovers/dialogs.
- Primary: indigo-600 — placeholder until Radhe's logo colour arrives (swap one CSS variable).
- Density: table rows 40px, inputs 36px. Body 14px, tables 13–14px.
- No dark mode for now.

## Status colours (one StatusBadge component everywhere)
| Status | Colour |
|---|---|
| Draft | grey |
| Sent | blue |
| Approved | violet |
| In Production | amber |
| Ready | cyan |
| Delivered | teal |
| Invoiced | indigo |
| Part Payment | yellow 🟡 |
| Paid | green 🟢 |
| Unpaid / Overdue | red 🔴 |
| Credit Customer | blue 🔵 |
| Pending approval | orange |
| Cancelled | grey, number struck through |

## Formatting
- Money: `₹1,00,000.00` via Intl en-IN; negatives red with minus; ledgers show Dr/Cr.
- Dates DD/MM/YYYY; times hh:mm a (IST).
- Sizes `6 × 3 ft`; sq ft to 2 decimals.

## Phone
Owner dashboard, customer page, follow-ups, receipts and print jobs must work well at 390px wide. Wide tables scroll inside their card, never the whole page.

## Accessibility basics
Every input has a label; visible focus ring; colour is never the only signal (badges have text); AA contrast.

## PDFs (invoice, quotation, statements, PO)
A4, company header with logo + GSTIN, clean table, totals block, amount in words (lakh/crore), bank details + terms, signature. Fonts per DECISIONS D06.
