# Go-live runbook — Radhe CRM (T44b)

Step by step, for Ronnie and the T44b builder. T44a (B17a) made the app ready; nothing below has been run yet.
Stack (D10, D69): Vercel (functions in **bom1** Mumbai, root `web/`) + Supabase Postgres and Storage (Mumbai).
Commands are PowerShell on the dev PC, inside `web/`, unless a step says otherwise.

**Never** paste a password, key or connection string into chat, a commit, an issue or a screenshot. They live in
Vercel's environment variables, the office PC's `web/.env` (gitignored) and a password manager.

---

## 0. Before you start (Ronnie)
Prepare these first. Each one is used in a step below.

| What | Where it comes from | Used in |
|---|---|---|
| Supabase account, on the plan the client pays for (Pro at go-live, D10) | supabase.com | §1 |
| Vercel account / team (Pro at go-live) | vercel.com | §3 |
| The GitHub repo connected to Vercel, and your OK to push (CLAUDE.md: never push without it) | GitHub | §3 |
| The domain for the CRM (e.g. `crm.<client-domain>`) and access to its DNS | the client's registrar | §6 |
| The owner's sign-in: username, display name, a strong password | the client | §5 |
| SMTP for emailing PDFs (host, port, user, password, from address) — optional | the client's mail provider | §2 |
| Q8: where the off-site backup copy lives | the client | §7 |
| PostgreSQL client tools of the **same major version as Supabase** (§1) on the PC that runs backups | postgresql.org | §4, §7 |

---

## 1. Supabase project (Mumbai) and private bucket
1. New project → **Region: South Asia (Mumbai) `ap-south-1`**. Save the database password in the password manager.
2. Note the **Postgres version** (Project Settings → Infrastructure). New projects run PG 17: install the PG 17 client
   tools on the backup PC (pg_dump must be at least the server's major version). The app itself uses nothing newer
   than PG 16 (D02).
3. **Turn the Data API off** (Project Settings → Data API → disable it, or remove `public` from the exposed schemas).
   The app never uses it, and our tables have no row-level security: with the Data API on, anyone holding the project's
   publishable key could read them over REST. Then, in the SQL editor:
   ```sql
   revoke all on all tables in schema public from anon, authenticated;
   revoke all on all sequences in schema public from anon, authenticated;
   alter default privileges in schema public revoke all on tables from anon, authenticated;
   alter default privileges in schema public revoke all on sequences from anon, authenticated;
   ```
   Run it again after the migrations in §4 (new tables), and check Advisors → Security shows no exposed tables.
4. Storage → **New bucket** `radhe-files`, **Public: off**. No file-size or MIME limits there (the app checks uploads).
5. Project Settings → API Keys: create a **secret key** (`sb_secret_…`) for the CRM server. (The legacy
   `service_role` key also works until Supabase retires legacy keys at the end of 2026.) It goes only into Vercel's
   env (§2) — never into the browser, never into the repo.
6. Connection strings (Connect button → connection string):
   - **Transaction pooler**, port **6543** → `DATABASE_URL` (the app; postgres.js runs with `prepare: false`, a pool
     of 5 per function instance).
   - **Session pooler** (port 5432, IPv4) or the direct connection → `DIRECT_DATABASE_URL` (migrations, pg_dump).
   Add `?sslmode=require` to both if Supabase's string doesn't already carry it.
7. Backups: Pro includes daily backups kept 7 days (Database → Backups). Ours come on top (§7).

## 2. Environment variables
Set these in Vercel (Project → Settings → Environment Variables → **Production**; Preview only if previews are used,
with a separate database). `web/.env.example` lists the same names with placeholders.

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase transaction pooler URL (6543), `sslmode=require` | the app |
| `DIRECT_DATABASE_URL` | Supabase session pooler / direct URL (5432), `sslmode=require` | migrations, backups; harmless on Vercel |
| `BETTER_AUTH_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` | changing it signs everyone out |
| `BETTER_AUTH_URL` | `https://<the CRM domain>` (no trailing slash) | must be https in production |
| `STORAGE_DRIVER` | `supabase` | Vercel's disk is not kept: `local` is refused there |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key from §1.5 | server only |
| `SUPABASE_BUCKET` | `radhe-files` | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | from the mail provider | all blank = email off; half-set stops the app |

The app checks these when it starts (`src/lib/env.ts`, via `src/instrumentation.ts` → `src/startup-check.ts`): in
production a missing or weak value stops the server (exit 1) with a message naming each variable, visible in
Vercel → Logs. Locally, `pnpm build && pnpm
start` runs the same check; `http://localhost` is the one non-https `BETTER_AUTH_URL` it accepts.

## 3. Vercel project
1. Add New → Project → import the GitHub repo. **Root Directory: `web`**. Framework: Next.js (detected). Install
   command / build command: defaults (`pnpm install`, `next build`). Node.js version: 22.x.
2. `web/vercel.json` sets the functions region to **bom1** and gives the heavy routes longer limits: the full Excel
   export and report exports (`/export/**`) and the opening import 300 s; PDFs, statements and share links 60 s.
   Settings → Functions → **Default Max Duration: 30 s** for everything else. If a build ever fails with "pattern …
   doesn't match any Serverless Functions", fix that glob in vercel.json.
3. Every function runs on the Node.js runtime (Next 16's default; nothing uses Edge), which the database driver,
   react-pdf and exceljs need.
4. Don't deploy yet — the database is empty. Put the env vars in first (§2), then migrate (§4).

## 4. Migrations (direct connection)
From the dev PC, against prod, with the **direct** URL (the transaction pooler can't run migrations):
```powershell
cd web
$env:DIRECT_DATABASE_URL = "<session pooler / direct URL, sslmode=require>"   # this shell only
pnpm db:migrate
Remove-Item Env:DIRECT_DATABASE_URL
```
drizzle-kit uses `DIRECT_DATABASE_URL` when it is set, else `DATABASE_URL`. "already exists, skipping" notices on a
repeat run are normal. Then run the §1.3 `revoke` block again. Later releases: migrate **before** promoting a
deployment whose commit adds a migration (back up first, §7).

## 5. Seed the owner
```powershell
$env:DATABASE_URL = "<direct URL>"; $env:OWNER_USERNAME = "<username>"; $env:OWNER_NAME = "<name>"; $env:OWNER_PASSWORD = "<password>"
pnpm db:seed          # "Owner … created." — a second run does nothing
Remove-Item Env:DATABASE_URL, Env:OWNER_USERNAME, Env:OWNER_NAME, Env:OWNER_PASSWORD
```
(Shell variables override `web/.env` for this run.) Then deploy (Vercel → Deployments → Redeploy, or push with
Ronnie's OK), sign in as the owner and fill Settings → Details and Books (books start date).

## 6. Domain and HTTPS
Vercel → Project → Domains → add the CRM domain; create the DNS record it shows (CNAME for a subdomain) at the
registrar. Vercel issues the certificate. Make sure `BETTER_AUTH_URL` is exactly `https://<that domain>` and
redeploy if it changed. Pair the print agents (Settings → Devices) against this address.

## 7. Nightly backup (Q8) and the restore test
What runs: `pnpm db:backup` = `pg_dump --format=custom` of `DIRECT_DATABASE_URL` (else `DATABASE_URL`) into
`BACKUP_DIR` (default `web/backups/`), with `sslmode=require` added for a remote host, then the old dumps there are
pruned: the newest dump of each of the last **7 days, 4 weeks and 12 months** is kept (docs/BACKUP.md).
Supabase's own daily backups (7 days) stay on as the second line.

Pick one for the nightly job (Q8 decides where the copy lives):

- **A. Office PC, Windows Task Scheduler** (simplest; needs the PC on at night). `web/.env` on that PC holds
  `DIRECT_DATABASE_URL` (prod), `PG_BIN` (PG 17 client `bin` folder) and `BACKUP_DIR` = the Q8 place, e.g. a Google
  Drive for desktop folder (`G:\My Drive\Radhe backups`) or an external disk. Task: daily 02:00, "Run whether user is
  logged on or not", action `pnpm` with arguments `db:backup`, start in `D:\radhe-crm\web`. Check the folder the next
  morning.
- **B. Scheduled GitHub Action** (no PC needed): a workflow on `schedule` (e.g. `30 20 * * *` = 02:00 IST) installs
  the PG client, runs `pg_dump --format=custom "$DIRECT_DATABASE_URL"` (a repo secret), encrypts it
  (`gpg --symmetric` with a passphrase secret) and uploads it to the Q8 place (e.g. rclone to Google Drive, or an
  S3 / R2 bucket). Workflow artifacts alone are not enough (max 90 days, same account as the code). Needs Ronnie's
  OK to add the workflow and secrets.

**Uploaded files** (attachments, logo, signature, print thumbnails) are in the bucket, not in the dump. Copy the
bucket on the same schedule: Supabase Storage → S3 connection → create an access key, then
`rclone sync supabase:radhe-files "<Q8 place>\files"` (rclone S3 remote, endpoint `https://<ref>.supabase.co/storage/v1/s3`,
region `ap-south-1`). TODO(ask): confirm with Ronnie whether rclone may be installed on the backup PC.

**Restore test** (before go-live, then monthly): restore the latest prod dump into the local `radhe_test` and compare,
as in docs/BACKUP.md "Check a restore" — with `$dev` = the prod **direct** URL for the `restore-check.sql` run. Both
outputs must match. Record the date in BACKUP.md.

## 8. Smoke test
```powershell
cd web
pnpm smoke https://<the CRM domain>
$env:SMOKE_USER = "<owner username>"; $env:SMOKE_PASSWORD = "<password>"; pnpm smoke https://<the CRM domain>
Remove-Item Env:SMOKE_USER, Env:SMOKE_PASSWORD
```
It checks: `/login` 200 · `/` → `/login` without a session · `/api/agent/bootstrap` 401 · `/share/<bad token>` 404 ·
`/manifest.webmanifest` 200 · the security headers (HSTS, frame-ancestors / X-Frame-Options, nosniff, referrer
and permissions policies). With `SMOKE_USER` / `SMOKE_PASSWORD` it also signs in and opens the dashboard. Each line
prints ✓ or ✗; any ✗ exits 1. Then by hand: upload a photo to a customer and open it (Storage works), make a test
invoice PDF, pair one print agent.

## 9. After the demos: reset prod, then the opening import (D69)
G1 (demo) and G2 (on-site print test) may run on the live site. Before real use the database starts fresh:
1. Back up (§7) and keep that dump with a "demo" name — it is not real data.
2. Supabase SQL editor (this deletes everything in the app's schemas):
   ```sql
   drop schema public cascade;
   drop schema drizzle cascade;
   create schema public;   -- owned by postgres; no grants to anon / authenticated (§1.3)
   ```
3. §4 migrate (+ the §1.3 `revoke` block) → §5 seed the owner.
4. Storage: empty the `radhe-files` bucket (Storage → select all → delete) — demo photos must not stay.
5. Revoke and re-pair the print agents (their device rows were wiped with the database).
6. Owner: Settings → Details, Books (books start date), Users (Q4 staff list), Categories (Q2 HSN / GST).
7. **Opening import** (Settings → Data → Import opening data) before anyone enters documents: download the template,
   fill it from Q5, upload → check → fix → Import. The trial balance must be zero afterwards (Reports → Trial balance).
8. Smoke test again (§8), then the client starts G3.

## 10. If something breaks
- **The site shows an error on every page** → Vercel → Logs: a start-up env check message names the variable to fix
  (§2); fix it and redeploy.
- **"Too many requests" at sign-in** → Better Auth's limit (D42): 3 sign-in tries per 10 seconds per internet
  address, counted in the `rate_limits` table so every server instance shares it. Staff behind one office connection
  share the count; waiting 10 seconds clears it.
- **Bad deploy** → Vercel → Deployments → the previous one → Promote (instant rollback). If it carried a migration,
  restore the pre-deploy backup instead of rolling back code alone.
- **Data mistake** → don't edit tables by hand (the journal is append-only, documents are frozen); fix through the
  app (cancel / reverse). A real restore: docs/BACKUP.md, into a new database, then point `DATABASE_URL` at it.
