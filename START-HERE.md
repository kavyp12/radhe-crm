# START HERE (Ronnie)

## How we build — the loop
1. Open **D:\radhe-crm** in VS Code.
2. Start a new Claude chat → paste the **REVIEWER BOOT PROMPT** (below). This is your **Reviewer chat**. Keep it open.
3. The reviewer gives you a prompt for the next task (it starts with "You are the BUILDER for T01…").
4. Open a **new** Claude chat → paste that prompt → let it build. One task = one fresh chat.
5. When the builder says done → go back to the Reviewer chat and type: `T01 done`
6. The reviewer checks the real code and runs the tests:
   - **PASS** → it ticks [x] in TASKS.md and gives you the next prompt.
   - **FIX** → it gives you a fix prompt → paste it in a new chat → then type `T01 fix done` in the Reviewer chat.
7. Repeat until everything in TASKS.md is [x].

## Rules of thumb
- A builder asks something you can't answer → paste the question into the Reviewer chat.
- Reviewer chat gets long, slow or confused → close it, open a new chat, paste the boot prompt again. Nothing is lost: all progress lives in files (TASKS.md, docs/PROGRESS.md, git).
- 🚦 in TASKS.md = you open the app and check it yourself (sometimes with the client) before we continue.
- Client answers (print software, HSN codes, company details…) → tell the Reviewer. It writes them into docs/DECISIONS.md so every future chat follows them.

## REVIEWER BOOT PROMPT — copy everything inside the box

```
You are the REVIEWER for the Radhe CRM project in D:\radhe-crm.
Read docs/REVIEWER.md and follow it exactly — you review and write prompts, you do not build features.
Now: read TASKS.md, the last 2 entries of docs/PROGRESS.md, and run `git log --oneline -10`.
Tell me in 3 lines where the project stands, then give me the BUILDER prompt for the next unticked task in one copy-paste code block.
```

## Collect from the client (full list: docs/DECISIONS.md → Open questions)
1. How each PC prints: CorelDRAW straight to a Windows printer, or through RIP software (Maintop / PhotoPrint / Onyx / Caldera / other)? List of machines. Where job files are saved.
2. HSN/SAC code + GST % for each product category (from their CA).
3. Company details for invoices: legal name, address, GSTIN, phone, email, bank, UPI, logo, signature, terms + a sample of their current invoice and quotation.
4. List of staff with roles (owner / accountant / sales / production).
5. Opening balances: customer dues (bill-wise if possible), vendor dues, stock, cash & bank — from Tally or Excel?
6. Machine rates per sq ft (selling rate and internal cost rate).
