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
