# Backups — Radhe CRM
How to back up the data, restore it, and check a restore (S27, D10, D62). Commands are for PowerShell on the dev PC.

There are two ways to take the data out:

| | Database backup (`pnpm db:backup`) | Excel export (Settings → Data) |
|---|---|---|
| What | A `pg_dump` of the whole database: every table, the journal, audit log, users, migrations | One workbook, a sheet per business table, plus the journal report for the accountant |
| For | Restoring after a crash, a bad import or a move to a new machine | Reading, the accountant, other software |
| Restorable | Yes (below) | No |

**Not in either:** uploaded files (attachments, logo, signature). In dev they live in `web/uploads/` — copy that folder with each backup. In prod they are in Supabase Storage (T44).

**Keep backups private.** A dump holds everything, including password hashes, customer details and the tokens behind share links. Don't email or WhatsApp it; encrypt any copy that leaves the machine. `web/backups/` is gitignored: never commit a dump.

## Make a backup
```powershell
cd web
pnpm db:backup
```
This writes `<database>-YYYY-MM-DD-HHmm.dump` (India time) into `BACKUP_DIR` (blank = `web/backups/`) from `DIRECT_DATABASE_URL` (blank = `DATABASE_URL`) in `web/.env`, using `pg_dump --format=custom`. A server that isn't on this PC gets `sslmode=require`. It looks for `pg_dump` on the PATH, then in `C:\Program Files\PostgreSQL\16\bin`; set `PG_BIN` to use another folder. pg_dump's major version must be at least the server's (Supabase runs 17: install the PG 17 client tools for prod).

After a good dump it prunes that database's older dumps in the same folder: the newest dump of each of the last **7 days, 4 weeks and 12 months** stays, the rest are deleted (`src/db/retention.ts`). Other files and other databases' dumps are never touched. A failed pg_dump leaves no file behind.

## Restore
`pg_restore.exe` sits next to `pg_dump.exe`. Restore as the app role `radhe`, never as `postgres`: `--no-owner` makes the restoring role own everything.

```powershell
$bin = "C:\Program Files\PostgreSQL\16\bin"
$url = "postgresql://radhe:<password>@localhost:5432/radhe_dev"   # the target database
```

**Into an empty database** (new machine, or after losing one):
1. As `postgres`, create it as in CLAUDE.md's one-time setup: `CREATE DATABASE radhe_dev OWNER radhe ENCODING 'UTF8' TEMPLATE template0;`
2. `& "$bin\pg_restore.exe" --no-owner --dbname=$url web\backups\<file>.dump`
3. `cd web; pnpm db:migrate` — applies any migration newer than the dump (does nothing otherwise).

**Over an existing database** — this replaces everything in it, so back it up first:
```powershell
& "$bin\pg_restore.exe" --clean --if-exists --no-owner --dbname=$url web\backups\<file>.dump
```

Then restart the app. Staff may have to sign in again.

## Check a restore
Restore into `radhe_test`, never into `radhe_dev`. Every `pnpm test` wipes `radhe_test` anyway. Then run `web/src/db/restore-check.sql` on both databases and compare the outputs. It lists the row count of every table and the AR, AP, stock, cash and petty-cash balances.
```powershell
$dev  = "postgresql://radhe:<password>@localhost:5432/radhe_dev"
$test = "postgresql://radhe:<password>@localhost:5432/radhe_test"
cd web
pnpm db:backup
$dump = (Get-ChildItem backups\*.dump | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
& "$bin\psql.exe" -X -q -d $dev -f src\db\restore-check.sql > $env:TEMP\dev.txt
& "$bin\pg_restore.exe" --clean --if-exists --no-owner --dbname=$test $dump
& "$bin\psql.exe" -X -q -d $test -f src\db\restore-check.sql > $env:TEMP\test.txt
Compare-Object (Get-Content $env:TEMP\dev.txt) (Get-Content $env:TEMP\test.txt)   # no output = identical
```
Last check: 2026-10-02 (T36). `radhe_dev` was restored into `radhe_test` both ways (with `--clean`, and into an emptied database). Both copies matched `radhe_dev` exactly: all 53 tables' row counts and the AR / AP / stock / cash / petty-cash balances. The triggers (77), indexes (182) and the pg_trgm extension matched too. The output is in docs/PROGRESS.md (T36).

## How often, and where to keep copies
These are proposals for Ronnie and the client to confirm.
- **Dev:** before risky work, such as migrations on real data, the opening-data import (T43) or upgrades.
- **Prod, from go-live:** every night automatically (D10: Supabase's daily backups plus our own nightly pg_dump). Also back up by hand before any deploy that carries a migration.
- **Keep:** the last 7 daily, 4 weekly and 12 monthly dumps (`pnpm db:backup` prunes to this by itself). Keep at least one copy off the server and away from the office PC: three copies, on two kinds of storage, one of them off-site. Examples are the owner's Google Drive or an external disk kept at home. TODO(ask): where Radhe wants the off-site copy.
- **Test a restore once a month** with the check above. A backup that has never been restored is not proven.

## Production (T44)
- **Supabase backups (Pro plan, Mumbai):** daily, kept 7 days, restored from the Supabase dashboard. They cover the database only.
- **Our nightly pg_dump:** `pnpm db:backup` with `DIRECT_DATABASE_URL` = the prod session / direct URL and `BACKUP_DIR` = the Q8 place, run nightly by the office PC's Task Scheduler or a scheduled GitHub Action (docs/DEPLOY.md §7; T44b picks one with Ronnie). The restore steps above stay the same; use the prod direct URL, and a pg_dump at least as new as the server.
- **Uploaded files:** they are in the private Supabase Storage bucket, not in the dump. Copy the bucket on the same schedule (DEPLOY.md §7: rclone over Supabase's S3 endpoint).
