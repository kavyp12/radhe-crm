# Progress log
Append-only. Newest at the bottom. Builders add an entry when their task is done; the reviewer adds the Review line.

Entry format:
```
## T{nn} — {title} — {YYYY-MM-DD}
- Built: …
- Files: …
- Checks: typecheck ✅/❌ · tests ✅ (n passed)/❌ · lint ✅/❌
- Commit: {sha}
- Deviations / TODO(ask): … (or "none")
- Review: (reviewer fills) PASS/FIX — date — note
```

---

## SETUP — Project docs — 2026-09-28
- Built: CLAUDE.md, START-HERE.md, TASKS.md, docs/ (SPEC, DECISIONS, ARCHITECTURE, DESIGN, REVIEWER, client originals). No app code yet.
- Checks: n/a (docs only)
- Next: T01.

## T01 — Scaffold & dev environment — 2026-09-28
- Built: web/ via create-next-app (Next 16.3.6, React 19.2, TS 5.9, Tailwind 4, ESLint 9, src/, @/*, pnpm 10.4.1, no nested git); placeholder home page, sample SVGs + README removed. shadcn init (style radix-nova, baseColor zinc via `shadcn migrate base-color`), no components. Postgres: login role `radhe` owns radhe_dev + radhe_test (Ronnie ran the CREATE SQL; password only in web/.env). Drizzle 0.45 + postgres.js client in src/db (globalThis reuse in dev), empty schema.ts, drizzle.config.ts, drizzle/0000_baseline.sql (custom, empty). Vitest 5: node env, @ → src alias, DATABASE_URL := TEST_DATABASE_URL, globalSetup refuses unless current_database() ends in _test → drops all non-system schemas → migrates; fileParallelism false. .env loaded outside Next with process.loadEnvFile / node --env-file-if-exists (no dotenv).
- Files: web/** (package.json, pnpm-lock.yaml, next/ts/eslint/postcss configs, components.json, drizzle.config.ts, vitest.config.mts, .env.example, .gitignore, drizzle/, src/app/*, src/lib/utils.ts, src/db/{index,schema,seed,test-setup,db.test}.ts, AGENTS.md, CLAUDE.md), CLAUDE.md (Commands).
- Checks: typecheck ✅ · tests ✅ (1 passed) · lint ✅ · build ✅ · `pnpm dev` → HTTP/1.1 200 OK · db:migrate ✅ on radhe_dev, repeat = no-op (1 row in drizzle.__drizzle_migrations) · db:seed exit 0 · guard: TEST_DATABASE_URL→radhe_dev refused.
- Commit: 99178a3
- Deviations / TODO(ask):
  - pnpm build scripts: none allowed. Ignored (package.json `pnpm.ignoredBuiltDependencies`): esbuild, sharp, unrs-resolver — all ship prebuilt binaries; tsx, drizzle-kit, vitest, next build all work without them.
  - create-next-app wrote a pnpm-workspace.yaml that pnpm 10.4.1 rejects ("packages field missing"); moved its setting into package.json and deleted the file.
  - shadcn init added deps: radix-ui, class-variance-authority, lucide-react, tw-animate-css, shadcn (CSS import), and `cn` (shadcn-ui's own clsx+tailwind-merge replacement; utils.ts re-exports it). It also created components/ui/button.tsx — deleted (T04).
  - `next dev` generates web/AGENTS.md + web/CLAUDE.md (points agents to node_modules/next/dist/docs) even with --no-agents-md; committed them since dev re-creates them. Remove with `agentRules: false` in next.config if unwanted.
  - @types/node bumped ^20 → ^22 (matches Node 22; vitest/vite peer).
  - typecheck = `next typegen && tsc --noEmit` (layout uses generated LayoutProps; fresh clones have no next-env.d.ts).
  - Kept favicon.ico (Next default) — replace when the logo arrives (Q3).
- Review: PASS — 2026-09-28 — reviewer re-ran typecheck / lint / test / build (all ✅), dev → 200, db:migrate repeat = no-op, seed exit 0; guard + smoke test read. `cn` verified as shadcn-ui's own package. Deviations accepted → D27–D29. PROGRESS entries stay uncommitted for the reviewer's commit.

## T02 — Number, date & numbering helpers — 2026-09-28
- Built: lib/num.ts — divRound (the one rounding helper: BigInt, half away from zero) · parseMoney / parseQty (throw on empty, junk or more decimals than 2 / 3; never round) · formatMoney (Intl en-IN INR fed an exact decimal string) · lineCalc (amount = round(qty × rate), taxable = amount − discount, CGST = SGST = round(taxable × bp / 20000) or IGST = round(taxable × bp / 10000), estimate = no GST) · invoiceTotals (Σ taxable / CGST / SGST / IGST + roundOff to the nearest rupee + total) · amountInWords (Indian system, one function). lib/dates.ts — todayIST (Intl formatToParts, Asia/Kolkata), dateParts (strict YYYY-MM-DD), addDays, fyKey, formatDate, parseDate (strict DD/MM/YYYY; 1/4/2026 OK), periodRange (today / yesterday / week = Monday → today / month = 1st → today, all IST). Schema moved to src/db/schema/ (index.ts re-exports; files follow the A§2 table groups, counters in control.ts); drizzle.config → schema/index.ts; migration 0001_counters (PK series + period_key), applied to radhe_dev. lib/numbering.ts — SERIES map covering all 18 A§6 series (prefix, minimum pad, FY vs calendar-year reset, tax invoice maxLength 16); nextNumber(tx, series, date) = INSERT … ON CONFLICT DO UPDATE … RETURNING inside the caller's transaction (row stays locked until it ends; covers a period's first number; rollback leaves the number unused). `Tx` type exported from @/db.
- Files: web/src/lib/{num,dates,numbering}.ts + .test.ts, web/src/db/schema/{index,control}.ts (schema.ts removed), web/src/db/index.ts (Tx), web/drizzle.config.ts, web/drizzle/0001_counters.sql + meta, web/tsconfig.json, CLAUDE.md (Commands: schema path).
- Checks: typecheck ✅ · tests ✅ (18 passed, 4 files) · lint ✅ · db:migrate ✅ on radhe_dev (2 migrations, counters present). Mutation check: a naive SELECT-then-UPDATE counter fails the 20-parallel test (duplicate numbers).
- Commit: 52c8ed6
- Deviations / TODO(ask):
  - tsconfig target ES2017 → ES2020: BigInt literals (10n) are TS2737 below ES2020. Next only suggests `target` (sets it when missing); SWC compiles, tsc is noEmit. A stale web/tsconfig.tsbuildinfo keeps reporting TS2737 — delete it once (gitignored).
  - Counter lock = upsert (… ON CONFLICT DO UPDATE … RETURNING), which the prompt allowed; the A§6 heading still says SELECT … FOR UPDATE.
  - My reading of edge cases the prompt didn't cover: parse rejects "12,5" / "12,50" (commas must be 2–3-digit groups ending in 3, so decimal-comma typos fail), ".5", "5.", "+5", "₹5", and trailing zeros past the unit ("1.230" as money). A negative discount is rejected; a negative line (negative qty) is allowed with zero discount, and its GST mirrors the positive line. Words: paise only → "Rupees Zero and Fifty Paise Only"; ≥ 100 crore → "One Hundred Crore"; negative → throws. A tax invoice number over 16 chars (the 1,000,000th in an FY) → nextNumber throws, so the save rolls back.
  - TODO(ask) for T06: journal_entries.number (A§2) has no series in A§6.
- Review: PASS — 2026-09-28 — reviewer re-ran typecheck / lint / test (18 ✅) / build ✅, migrate repeat = no-op; read num / dates / numbering + tests (divRound, upsert lock, rollback, 16-char cap all verified; only Number() use = word-array index < 100). Accepted: ES2020 target, the edge-case readings above. Answers: lock wording → D31; journal number → D32.
