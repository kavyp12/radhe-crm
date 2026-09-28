# Radhe CRM — rules for every Claude chat in this folder

CRM + accounting + print-job tracking for **Radhe Digital Sign Board** (Ahmedabad, Gujarat).
Owner of this build: Ronnie. Client requirements: docs/SPEC.md.

## Who are you in this chat?
- First message is a **BUILDER prompt** ("You are the BUILDER for T..") → do ONLY that task, then stop.
- First message is the **REVIEWER boot prompt** → follow docs/REVIEWER.md.
- Anything else → ask Ronnie which one before touching code.

## Source of truth (higher wins on conflict)
1. docs/DECISIONS.md — locked choices. Don't re-decide them.
2. docs/ARCHITECTURE.md — data model, posting rules, permissions, numbering.
3. docs/SPEC.md — what the client asked for (S1–S27, P1–P10, R0–R1).
4. docs/client/ — client's original text. Check here when meaning is unclear.

Unclear or missing → STOP and ask. Never invent business rules, GST rates, HSN/SAC codes, legal rules or client preferences. Write `TODO(ask):` and report it.

## Layout
- web/ — Next.js app (UI + server actions + API). Created in T01.
- print-agent/ — C# Windows tray app (Phase 8).
- docs/ — spec, decisions, architecture, design, reviewer manual, progress log, client originals.
- TASKS.md — the task list. Only the reviewer ticks [x].

## Commands (run inside web/)
- `pnpm dev` — dev server on http://localhost:3000
- `pnpm build` / `pnpm start` — production build / serve it
- `pnpm typecheck` — `next typegen` + `tsc --noEmit`
- `pnpm lint` — ESLint
- `pnpm test` — Vitest on radhe_test: wipes its schemas, runs migrations, then test files one at a time. Refuses any DB not named *_test.
- `pnpm db:generate` — drizzle-kit migration from src/db/schema.ts (custom SQL: `pnpm db:generate --custom --name=<name>`)
- `pnpm db:migrate` — apply migrations in drizzle/ to DATABASE_URL (radhe_dev). "already exists, skipping" NOTICEs on repeat runs are normal.
- `pnpm db:seed` — run src/db/seed.ts

One-time DB setup (new machine):
1. As the postgres superuser, create the app role and DBs — the app, migrations and tests never use the superuser:
   `CREATE ROLE radhe LOGIN PASSWORD '<random>';` · `CREATE DATABASE radhe_dev OWNER radhe ENCODING 'UTF8' TEMPLATE template0;` · same for `radhe_test`.
   (psql: `& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost`)
2. Copy web/.env.example → web/.env and put the password in both URLs.
3. `pnpm install` → `pnpm db:migrate` → `pnpm test`.

## Hard rules
1. Money = integer paise (bigint). Qty / size / sq ft = integer thousandths. Never JS floats for money or qty — use web/src/lib/num.ts helpers only.
2. Every money-moving document posts through the posting service, in the same DB transaction as the document. Never write journal rows by hand.
3. Posted documents are frozen. Change = cancel/reverse (+ repost) through approvals. Never DELETE business rows. The journal is append-only (DB enforces it).
4. Every write transaction sets the audit user (helper from T05). No silent edits.
5. Permission check on the server in every server action, route handler and data loader. Hiding a button is not security. Cost / profit / purchase rates only for users with can_view_cost — strip them in the loader.
6. Payment statuses (Unpaid / Part / Paid / Overdue / Credit) are computed, never stored or typed.
7. Document numbers only from the numbering service (formats in ARCHITECTURE §6).
8. Dates in Asia/Kolkata, shown DD/MM/YYYY. Financial year April–March. Money shown ₹1,00,000.00 (en-IN).
9. No new npm/NuGet dependency unless DECISIONS.md lists it or the reviewer approved it.
10. Library APIs change — check current docs (context7 MCP, or types in node_modules), not memory.

## Keep it cheap
- Grep/Glob first. Read only files you will touch; read big files in ranges.
- Smallest diff that meets "Done when". No refactors outside the task. No speculative abstractions.
- Don't paste whole files back into chat — summarize.

## Git
- One task = one commit: `T07: approvals framework`. Never commit .env files. Never force-push. Never push without Ronnie's OK.

## Finishing a task (builder)
1. Run typecheck + tests (+ lint) in web/ and paste the result lines. Never claim a pass you didn't run.
2. Commit.
3. Append your entry to docs/PROGRESS.md (format at the top of that file).
4. Reply: 5-line summary + anything the reviewer must decide. Do NOT tick TASKS.md.

## Windows machine
Default shell: PowerShell 5.1 (no `&&` — use `;` or `if ($?) { }`). Bash tool = Git Bash.
Installed: Node 22, pnpm 10, git, .NET SDK 9, PostgreSQL 16 (C:\Program Files\PostgreSQL\16). No Docker.
