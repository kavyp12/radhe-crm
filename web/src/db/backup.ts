// pnpm db:backup (S27, D62, T44a): pg_dump -Fc of DIRECT_DATABASE_URL (else DATABASE_URL) into BACKUP_DIR (default
// web/backups/) as <db>-YYYY-MM-DD-HHmm.dump (India time), then prunes that database's old dumps there: the newest of
// each of the last 7 days, 4 weeks and 12 months stay (src/db/retention.ts). A remote server gets sslmode=require.
// pg_dump comes from PG_BIN when set, else PATH, else C:\Program Files\PostgreSQL\16\bin; its major version must be at
// least the server's (Supabase: 17). Restoring and the nightly job: docs/BACKUP.md, docs/DEPLOY.md §7.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dumpsToPrune } from "./retention";

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_DATABASE_URL or DATABASE_URL must be set (web/.env)");

const exe = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
const candidates = process.env.PG_BIN ? [path.join(process.env.PG_BIN, exe)] : [exe, path.join("C:\\Program Files\\PostgreSQL\\16\\bin", exe)];
const pgDump = candidates.find((c) => spawnSync(c, ["--version"]).status === 0);
if (!pgDump) throw new Error(`pg_dump not found (tried ${candidates.join(", ")}). Set PG_BIN to PostgreSQL's bin folder.`);

// The password goes to pg_dump through the environment, not the command line (other users can list arguments).
const target = new URL(url);
const password = decodeURIComponent(target.password);
target.password = "";
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname) && !target.searchParams.has("sslmode")) {
  target.searchParams.set("sslmode", "require"); // a remote server (Supabase): never in clear text
}
const name = decodeURIComponent(target.pathname.slice(1));
const dir = process.env.BACKUP_DIR || "backups";
const ist = new Date(Date.now() + 330 * 60_000).toISOString(); // India has no DST
const file = path.join(dir, `${name}-${ist.slice(0, 10)}-${ist.slice(11, 13)}${ist.slice(14, 16)}.dump`);
mkdirSync(dir, { recursive: true });

const run = spawnSync(pgDump, ["--format=custom", `--file=${file}`, `--dbname=${target.href}`], {
  stdio: "inherit",
  env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
});
if (run.status !== 0) {
  rmSync(file, { force: true }); // never leave a half-written dump that looks like a backup
  throw new Error(`pg_dump failed (exit ${run.status ?? run.signal})`);
}
console.log(`Backup written: ${file.replaceAll("\\", "/")} (${(statSync(file).size / 1024).toFixed(0)} KB)`);

const old = dumpsToPrune(readdirSync(dir), name);
for (const f of old) rmSync(path.join(dir, f));
if (old.length) console.log(`Pruned ${old.length} older dump${old.length === 1 ? "" : "s"} (keeping 7 daily, 4 weekly, 12 monthly).`);
