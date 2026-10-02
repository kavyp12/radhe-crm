// pnpm db:backup (S27, D62): pg_dump -Fc of DATABASE_URL into web/backups/<db>-YYYY-MM-DD-HHmm.dump (India time).
// pg_dump comes from PG_BIN when set, else PATH, else C:\Program Files\PostgreSQL\16\bin. Restoring: docs/BACKUP.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (web/.env)");

const exe = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
const candidates = process.env.PG_BIN ? [path.join(process.env.PG_BIN, exe)] : [exe, path.join("C:\\Program Files\\PostgreSQL\\16\\bin", exe)];
const pgDump = candidates.find((c) => spawnSync(c, ["--version"]).status === 0);
if (!pgDump) throw new Error(`pg_dump not found (tried ${candidates.join(", ")}). Set PG_BIN to PostgreSQL's bin folder.`);

// The password goes to pg_dump through the environment, not the command line (other users can list arguments).
const target = new URL(url);
const password = decodeURIComponent(target.password);
target.password = "";
const name = decodeURIComponent(target.pathname.slice(1));
const ist = new Date(Date.now() + 330 * 60_000).toISOString(); // India has no DST
const file = path.join("backups", `${name}-${ist.slice(0, 10)}-${ist.slice(11, 13)}${ist.slice(14, 16)}.dump`);
mkdirSync("backups", { recursive: true });

const run = spawnSync(pgDump, ["--format=custom", `--file=${file}`, `--dbname=${target.href}`], {
  stdio: "inherit",
  env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
});
if (run.status !== 0) {
  rmSync(file, { force: true }); // never leave a half-written dump that looks like a backup
  throw new Error(`pg_dump failed (exit ${run.status ?? run.signal})`);
}
console.log(`Backup written: web/${file.replaceAll("\\", "/")} (${(statSync(file).size / 1024).toFixed(0)} KB)`);
