# Go-live runbook — Radhe CRM on the Hostinger VPS (T44b, D71)

Step by step, for Ronnie and the T44b builder. The CRM runs on Ronnie's Hostinger VPS next to his other projects:
its own PostgreSQL database and role, Node 22 (`next start`) under systemd on 127.0.0.1, the server's nginx in
front with HTTPS on its own (sub)domain, uploads on the server's disk (D71). No Supabase, no Vercel (`vercel.json`
and the Supabase storage driver stay in the code, unused).

**Other projects on the server are never touched**: their databases, roles, sites, processes, ports and cron jobs.
Every file this runbook creates is new; if one already exists, stop and ask. Back up any existing config file before
editing it (`cp <file> <file>.bak-$(date +%F)`), and reload shared services (`systemctl reload nginx`), never restart
them.

**Secrets** (database password, `BETTER_AUTH_SECRET`, SMTP password, the owner's password) are typed by Ronnie on the
server or into the password manager — never into chat, a commit, an issue or a screenshot. On the server they live
only in `web/.env` (mode 600).

| What | Where |
|---|---|
| App user | `radhecrm` (home `/srv/radhe-crm`; may restart only its own service) |
| Code | `/srv/radhe-crm/app` (git checkout; the app is `app/web`) |
| Settings | `/srv/radhe-crm/app/web/.env` (§2) |
| Uploads | `/srv/radhe-crm/uploads` (`UPLOAD_DIR`) |
| Backups | `/srv/radhe-crm/backups` (`BACKUP_DIR`) |
| Node 22 + pnpm | `/srv/radhe-crm/node` (a private copy: the server's own Node stays as it is) |
| Database | `radhe_crm`, owned by the login role `radhe_crm`, on the server's PostgreSQL |
| App | systemd `radhe-crm.service` → `127.0.0.1:3100` (or another free port) |
| Site | nginx `/etc/nginx/sites-available/radhe-crm` → `https://<crm domain>` |

Commands: `#` = as root (or with `sudo`), `$` = as the app user (`sudo -iu radhecrm`). `crm.example.com` stands for
the real (sub)domain.

---

## 0. Before you start (Ronnie)
- Your OK, and the repo on GitHub (private) with the commit to go live on `main`.
- The (sub)domain and access to its DNS: an **A** record → the VPS's IP (and **AAAA** if the server has IPv6). If the
  DNS is on Cloudflare, set the record to **DNS only**: through its proxy every visitor would arrive from Cloudflare's
  addresses and share one sign-in limit.
- The owner's sign-in (Jay Patel): a username and a strong password, typed in §5.
- SMTP for emailing PDFs (optional): host, port, user, password, from address.
- Q8: where the off-site backup copy lives (§7).

Look at the server first — these only read:
```bash
# lsb_release -ds; uname -m; nproc; free -h; df -h /; timedatectl | grep 'Time zone'
# sudo -u postgres psql -Atc 'show server_version' -c 'show port'
# nginx -v; ls /etc/nginx/sites-enabled /etc/nginx/conf.d; certbot --version
# ss -ltnp | grep -E ':3100\b'          # nothing = port 3100 is free
```
**Stop and ask** if: PostgreSQL is older than 16 or runs in Docker; the web server isn't nginx (a panel such as
CyberPanel, Caddy, Traefik…); the CPU isn't `x86_64`; less than about 3 GB of memory is free for `pnpm build`
(it peaked at 2.8 GB on the 12-thread dev PC; fewer cores use less); or less than 10 GB of disk is free.

## 1. PostgreSQL: the CRM's database and role
Not a superuser; nobody else may connect to its database. Make a password with `openssl rand -hex 24` (letters and
digits only, so it needs no escaping in a URL) and keep it in the password manager.
```bash
# sudo -u postgres psql
CREATE ROLE radhe_crm LOGIN;
\password radhe_crm
CREATE DATABASE radhe_crm OWNER radhe_crm ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT ON DATABASE radhe_crm FROM PUBLIC;
\q
```
(`\password` asks for it twice and never shows it. If CREATE DATABASE complains about the locale, add
`LOCALE 'C.UTF-8'`.) pg_trgm is a trusted extension: the first migration creates it as the database owner.
Check the login: `psql "postgres://radhe_crm@127.0.0.1:5432/radhe_crm" -c 'select 1'` (asks for the password). If
it is refused with "no pg_hba.conf entry", back up `pg_hba.conf`, add
`host radhe_crm radhe_crm 127.0.0.1/32 scram-sha-256` above the other `host` lines, and
`systemctl reload postgresql`.

## 2. Settings (`web/.env` on the server)
`web/.env.example` lists every name. On the server:

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://radhe_crm:<password>@127.0.0.1:5432/radhe_crm` | the §1 password; the port from §0 |
| `DIRECT_DATABASE_URL` | blank | only for a pooled database |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` | changing it signs everyone out |
| `BETTER_AUTH_URL` | `https://crm.example.com` (no trailing slash) | must be https |
| `STORAGE_DRIVER` | `local` | |
| `UPLOAD_DIR` | `/srv/radhe-crm/uploads` | outside the app folder (D71) |
| `BACKUP_DIR` | `/srv/radhe-crm/backups` | |
| `PG_BIN` | blank | pg_dump of the server's PostgreSQL, from PATH |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | from the mail provider | all blank = email off; half-set stops the app |

Blank everything else (`TEST_DATABASE_URL`, `OWNER_*`, `SMOKE_*`, `SUPABASE_*`): tests never run on the server.
The app checks these when it starts (`src/lib/env.ts`, via `src/instrumentation.ts` → `src/startup-check.ts`): a
missing or weak value stops it (exit 1) with a message naming each variable, in `journalctl -u radhe-crm`.

## 3. App user, Node 22 and the code
```bash
# useradd --system --create-home --home-dir /srv/radhe-crm --shell /bin/bash radhecrm
# chmod 750 /srv/radhe-crm
# sudo -iu radhecrm
$ mkdir uploads backups
```
**Node 22 + pnpm** (a private copy for this user only; never change the server's own Node — other projects use it):
```bash
$ v=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v22[.0-9]*-linux-x64\.tar\.xz' | head -1)
$ curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$v"
$ curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $v\$" | sha256sum -c -     # must say OK
$ tar -xf "$v" && rm "$v" && ln -sfn "${v%.tar.xz}" node
$ echo 'export PATH="$HOME/node/bin:$PATH"' >> ~/.profile && . ~/.profile
$ npm install -g pnpm@10.4.1          # the version in web/package.json "packageManager"
$ node -v; pnpm -v
```
**Read-only deploy key** and the code:
```bash
$ ssh-keygen -t ed25519 -C "radhe-crm server (read-only)" -f ~/.ssh/id_ed25519 -N ""
$ cat ~/.ssh/id_ed25519.pub
```
GitHub → the repo → Settings → Deploy keys → Add deploy key: title "Hostinger VPS", paste the line, leave
**Allow write access** off. Then:
```bash
$ ssh -T git@github.com     # compare the fingerprint with GitHub's published ones (docs.github.com: "GitHub's SSH key fingerprints"), then yes
$ git clone git@github.com:kavyp12/radhe-crm.git ~/app
$ cd ~/app/web
$ cp .env.example .env && chmod 600 .env && nano .env     # fill it as in §2
$ pnpm install --frozen-lockfile
```

## 4. Migrations
```bash
$ cd ~/app/web && pnpm db:migrate
```
"already exists, skipping" notices on a repeat run are normal. Later releases migrate through `update.sh` (§9).

## 5. Seed the owner
Typed, not saved in a file or the shell history:
```bash
$ read -rp "Owner username: " u; read -rsp "Owner password: " p; echo
$ OWNER_USERNAME="$u" OWNER_NAME="Jay Patel" OWNER_PASSWORD="$p" pnpm db:seed; unset p     # Owner "…" created.
```
A second run does nothing ("An owner already exists").

## 6. Build, the service, the site and HTTPS
```bash
$ pnpm build
```
The service (new file `/etc/systemd/system/radhe-crm.service`):
```ini
[Unit]
Description=Radhe CRM
After=network.target postgresql.service

[Service]
User=radhecrm
WorkingDirectory=/srv/radhe-crm/app/web
ExecStart=/srv/radhe-crm/node/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3100
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
`update.sh` restarts it as the app user — new file through `visudo -f /etc/sudoers.d/radhe-crm`:
```
radhecrm ALL=(root) NOPASSWD: /usr/bin/systemctl restart radhe-crm
```
```bash
# systemctl daemon-reload && systemctl enable --now radhe-crm
# systemctl status radhe-crm                              # active (running)
# curl -sI http://127.0.0.1:3100/login | head -1          # HTTP/1.1 200 OK
```
The site (new file `/etc/nginx/sites-available/radhe-crm`; use the `listen` lines the other sites use):
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name crm.example.com;

    client_max_body_size 10m;            # uploads are at most 4 MB, the opening import 2 MB

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # exactly one address: the sign-in limit counts per address
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;             # pages stream (Next.js self-hosting guide)
        proxy_read_timeout 300s;         # the full Excel export and the opening import can take minutes
    }
}
```
```bash
# ln -s /etc/nginx/sites-available/radhe-crm /etc/nginx/sites-enabled/radhe-crm
# nginx -t && systemctl reload nginx
# certbot --nginx -d crm.example.com       # adds HTTPS + the http → https redirect to this site only; renews by itself
```
(If the server keeps its sites in `/etc/nginx/conf.d/`, put the file there as `radhe-crm.conf` instead of the
symlink. No certbot yet: ask before installing it.) Open `https://crm.example.com`, sign in as the owner and fill
Settings → Details and Books. Pair the print agents (Settings → Devices) against this address.

## 7. Backups: nightly, off-site, restore test
**Nightly, on the server** (the app user's crontab: `$ crontab -e`). Times are the server's clock: with UTC (§0),
21:00 = 02:30 India time.
```
PATH=/srv/radhe-crm/node/bin:/usr/bin:/bin
# Radhe CRM (docs/DEPLOY.md §7): the database at 02:30 IST, the uploads folder at 02:40 IST
0 21 * * * cd /srv/radhe-crm/app/web && pnpm db:backup >> /srv/radhe-crm/backups/backup.log 2>&1
10 21 * * * cd /srv/radhe-crm && { tar -cf backups/uploads.tmp uploads && mv backups/uploads.tmp backups/uploads-$(TZ=Asia/Kolkata date +\%F-\%H\%M).tar && find backups -name 'uploads-*.tar' -mtime +6 -delete; } >> backups/backup.log 2>&1
```
`pnpm db:backup` writes `radhe_crm-YYYY-MM-DD-HHmm.dump` (India time) and keeps the newest of each of the last
**7 days, 4 weeks and 12 months** (docs/BACKUP.md). The uploads archive holds every uploaded file (they are never
changed or deleted, so the newest archive has them all); the last 7 are kept, and a failed run leaves only
`uploads.tmp`, never a half archive. At go-live run both lines once by hand, then check the folder and `backup.log`
the next morning.

**Off-site copy — TODO(ask) Q8.** Until it is decided, the copies live only on the server: losing the VPS loses them
too. Two ways, once Q8 names the place:
- **A. The office PC pulls them** each night: Windows Task Scheduler runs `scp` (built into Windows) with its own
  SSH key for `radhecrm`, copying the newest dump and uploads archive to an external disk or a Google Drive for
  desktop folder.
- **B. The server pushes them**: rclone (installed for the app user only, with Ronnie's OK) copies new files to the
  owner's Google Drive, encrypted (rclone crypt).

**Restore test** (before go-live, then monthly; at a quiet time, right after a backup). Into a scratch database on
the same server and PostgreSQL — never into `radhe_crm`:
```bash
# sudo -u postgres createdb -O radhe_crm -E UTF8 -T template0 radhe_crm_check
$ cd ~/app/web
$ dump=$(ls -t ~/backups/radhe_crm-*.dump | head -1); echo "$dump"
$ pg_restore --no-owner --dbname=postgres://radhe_crm@127.0.0.1:5432/radhe_crm_check "$dump"
$ psql -X -q -d postgres://radhe_crm@127.0.0.1:5432/radhe_crm -f src/db/restore-check.sql > ~/check-live.txt
$ psql -X -q -d postgres://radhe_crm@127.0.0.1:5432/radhe_crm_check -f src/db/restore-check.sql > ~/check-restored.txt
$ diff ~/check-live.txt ~/check-restored.txt && echo "restore check: identical"      # row counts + AR / AP / stock / cash balances
$ tar -tf "$(ls -t ~/backups/uploads-*.tar | head -1)" | grep -vc '/$'; find ~/uploads -type f | wc -l   # same number
$ rm ~/check-live.txt ~/check-restored.txt
# sudo -u postgres dropdb radhe_crm_check
```
Record the date in docs/BACKUP.md.

## 8. Smoke test
From the dev PC (PowerShell, inside `web/`):
```powershell
pnpm smoke https://crm.example.com
$env:SMOKE_USER = "<owner username>"; $env:SMOKE_PASSWORD = "<password>"; pnpm smoke https://crm.example.com
Remove-Item Env:SMOKE_USER, Env:SMOKE_PASSWORD
```
It checks: `/login` 200 · `/` → `/login` without a session · `/api/agent/bootstrap` 401 · `/share/<bad token>` 404 ·
`/manifest.webmanifest` 200 · the security headers (HSTS, frame-ancestors / X-Frame-Options, nosniff, referrer and
permissions policies). With `SMOKE_USER` / `SMOKE_PASSWORD` it also signs in and opens the dashboard. Any ✗ exits 1.
Then by hand: upload a photo to a customer and open it (the file appears under `/srv/radhe-crm/uploads`), make a
test invoice PDF, pair one print agent.

## 9. Updates and rolling back
A push to GitHub changes nothing on the server; the live site moves only when Ronnie runs the update (pushes still
only with his OK). Outside office hours — the site is down while it builds (a few minutes):
```bash
# sudo -iu radhecrm
$ ~/app/web/update.sh
```
`web/update.sh`: fetch → check out `origin/main` → `pnpm install --frozen-lockfile` → `pnpm db:backup` → `pnpm
db:migrate` → `pnpm build` → restart the service → check it stayed up. It prints the commit it came from. Then the
smoke test (§8).

**Roll back:**
- **Code only** (the bad release added no migration, or the old code works with it): `$ ~/app/web/update.sh <previous
  commit>` (printed by the update; also `git -C ~/app log --oneline`).
- **The release's migration broke data or the old code**: back to the dump `update.sh` took just before migrating
  (it printed "Backup written: …"). Into an emptied database, not over the live one — `pg_restore --clean` would leave
  the tables the newer migration added:
  `# systemctl stop radhe-crm`, the `psql` line of §10 step 2 (drop + create), then
  `$ pg_restore --no-owner --dbname=postgres://radhe_crm@127.0.0.1:5432/radhe_crm <that dump>` and
  `$ ~/app/web/update.sh <previous commit>`. Entries made after the update are lost that way, so fix forward unless
  the data itself is wrong.
- **Failed build**: the site is down until a roll back — `update.sh <previous commit>` rebuilds the old code.

## 10. After the demos: reset prod, then the opening import (D69)
G1 (demo) and G2 (on-site print test) may run on the live site. Before real use the database starts fresh:
1. Back up (§7) and rename that dump `demo-…` (out of the pruning) — it is not real data; delete it once go-live is
   settled.
2. Wipe the database and the demo files:
   ```bash
   # systemctl stop radhe-crm
   # sudo -u postgres psql -c 'DROP DATABASE radhe_crm WITH (FORCE)' -c "CREATE DATABASE radhe_crm OWNER radhe_crm ENCODING 'UTF8' TEMPLATE template0" -c 'REVOKE CONNECT ON DATABASE radhe_crm FROM PUBLIC'
   $ mv ~/uploads ~/uploads-demo && mkdir ~/uploads      # delete uploads-demo once go-live is settled
   ```
3. §4 migrate → §5 seed the owner → `$ sudo systemctl restart radhe-crm`.
4. Revoke and re-pair the print agents (their device rows went with the database).
5. Owner: Settings → Details, Books (books start date), Users (Q4 staff list), Categories (Q2 HSN / GST).
6. **Opening import** (Settings → Data → Import opening data) before anyone enters documents: download the template,
   fill it from Q5, upload → check → fix → Import. The trial balance must be zero afterwards (Reports → Trial balance).
7. Smoke test again (§8), then the client starts G3.

## 11. If something breaks
- **Every page shows an error, or nginx says 502** → `# systemctl status radhe-crm` and
  `# journalctl -u radhe-crm -n 50`: the start-up check names the variable to fix in `web/.env` (§2); then
  `$ sudo systemctl restart radhe-crm`. nginx's own errors: `/var/log/nginx/error.log`.
- **"Too many requests" at sign-in** → Better Auth's limit (D70): 10 sign-in tries per 60 seconds per internet
  address, counted in the `rate_limits` table. The office shares one address; waiting a minute clears it.
- **An upload fails with 413** → nginx's `client_max_body_size` (§6).
- **`pnpm build` fails with "next/font/google queries have exactly one entry"** → Google Fonts sometimes answers in a
  form Next 16.3.6 can't read (next.js#99114), and the build cache keeps that answer: `$ rm -rf ~/app/web/.next/cache`
  and build again (`update.sh` already retries once that way).
- **Bad update** → §9.
- **The server rebooted** → the CRM starts by itself (`enable`d); PostgreSQL and nginx are the server's own.
- **Data mistake** → don't edit tables by hand (the journal is append-only, documents are frozen); fix it in the app
  (cancel / reverse). A real restore: docs/BACKUP.md, then restart the service.
