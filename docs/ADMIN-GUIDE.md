# Radhe CRM — guide for the owner

This is for you, the owner. It covers the jobs only an owner does: staff and their access, company settings,
approvals, backups, the print-shop PCs, bringing in old data, and what to do when something goes wrong.

## Staff and what they can see (Users)
Open **Users** in the left menu.

- **Add someone:** New user → name, a username (letters, numbers, dot or underscore), their role and a password of
  at least 8 characters. Give them the username and password in person. They can't sign up by themselves.
- **Roles** decide what each person can open:

  | Role | Can work on |
  |---|---|
  | Owner | Everything, including settings, users, approvals and devices. |
  | Accountant | Customers, vendors, invoices, receipts, payments, purchase bills, expenses, cash & bank, reports. Some actions go to you for approval (below). |
  | Sales | Customers, quotations, jobs, follow-ups; can view invoices and outstanding for collection. |
  | Production | Jobs (status only, no money), material requests, issuing stock, print jobs (no money). |

- **"Can see cost, profit and purchase rates":** a tick per person. On for owner and accountant by default, off for
  sales and production. Without it, a person never sees purchase rates, stock values or profit — the server leaves
  them out, it doesn't just hide them.
- **Forgotten password:** open the user → Reset password, type a new one, tell them. Staff can't change their own.
- **Someone leaves:** open the user → untick Active. They are signed out and can't sign in again; everything they
  entered stays, with their name on it. Nobody can disable or demote themselves, so there is always an owner.

## Company settings (Settings → Details)
Company name, address, GSTIN, phone, email, bank details, UPI id, logo and signature: these print on quotations,
invoices and statements. Invoice and quotation terms print at the bottom of those documents.

**Approval rules** (same page):
- **Discount limit (%)** — a bigger discount by anyone but you waits for your approval. Blank = every discount does.
- **Backdate days** — an entry dated further back than this waits for your approval. Blank = anything before today does.
- **Default credit days** — how long customers get to pay unless their own page says otherwise.

**Settings → Books** holds the books start date (the day your opening balances are counted from) and the opening
balances of cash, petty cash, UPI and bank accounts. The start date can't move once real entries exist.

## Approvals
When someone other than you does one of these, nothing happens until you approve it:
cancelling an invoice · changing or cancelling a receipt or vendor payment · cancelling a purchase bill · a discount
over the limit · issuing a credit note · anything dated further back than the backdate days · adjusting a
customer's outstanding (write-off, discount, refund) or any journal voucher · a stock adjustment.

The **Approvals** item in the menu shows a count. Open a request to see exactly what will change and why it was
asked, then **Approve** (it is done there and then) or **Reject** (nothing changes). When you do these
things yourself they happen at once. Every change, by anyone, is kept in the record's **History** / **Changes** tab.

## Backups
- Every night a full copy of the database is saved automatically (set up at go-live; where the copy is kept is your
  choice — for example your Google Drive or an external disk at home). Supabase also keeps its own copies for 7 days.
- Copies kept: the last 7 days, 4 weeks and 12 months.
- **Settings → Data → All data as Excel** downloads everything as one Excel file for reading or for your accountant.
  It is not a backup that can be restored; the nightly copy is.
- Once a month, ask Ronnie to test a restore. A backup that has never been restored is not proven.
- Backups hold everything, including customer details. Keep them private; never send one by WhatsApp or email.

## Print-shop PCs (Settings → Devices)
Each PC that runs the Radhe print agent is paired once:
1. On that PC, open the agent's settings; it asks for the CRM address and a pairing code.
2. In the CRM, Settings → Devices → **New pairing code**. A code like `K7QM-3XRD` appears once.
3. Type it into the agent within **10 minutes**. The PC then shows in the Devices list with its name.

A code works for one PC only. If a PC is lost, sold or replaced, click **Revoke** next to it: it stops sending prints
at once. Pair the new PC with a new code. You can rename a device to match the machine it sits next to.

## Bringing in your old data (Settings → Data → Import opening data)
Do this once, before staff start entering bills.
1. Set the **books start date** first (Settings → Books).
2. **Download the template.** It has a "Read me" sheet explaining every column, then sheets for customers, their
   unpaid old bills, vendors, their unpaid bills, stock items with the stock in hand, and cash / bank balances.
3. Fill it in. Amounts as plain numbers (12500 or 12,500.50). Dates as DD/MM/YYYY, on or before the books start date.
   A customer without a mobile or GSTIN is matched by their exact name.
4. **Upload → Check.** Nothing is saved yet. Fix every row it lists and upload again.
5. **Import.** Everything goes in at once, or nothing does. Customers and vendors can come first and their old dues
   in a later file, as long as that party has no opening balance yet.
6. An old bill that went in by mistake (and has no payment against it) can be cancelled from the customer's or
   vendor's **History** tab — the opening balance is corrected for you. Old dues that will never be paid: use
   **Adjust outstanding → Write-off** on the customer's page.

## When something goes wrong
- **Someone can't sign in:** check they are Active (Users) and reset their password. Several wrong passwords in a few
  seconds from one place make the sign-in wait briefly; try again after a minute.
- **A wrong entry:** don't ask for the database to be edited. Cancel or edit the entry in the app (with approval if
  needed); the books then correct themselves and the history shows what happened.
- **A print didn't arrive from a PC:** the agent keeps prints while the internet is down and sends them later. If a PC
  says it isn't paired, make a new pairing code.
- **The site is down or every page shows an error:** call Ronnie. He checks the hosting logs; a bad update can be
  rolled back in a minute.
- **Lost data or a big mistake across many records:** call Ronnie before anyone enters more. The nightly backups can
  bring the data back to an earlier day.
