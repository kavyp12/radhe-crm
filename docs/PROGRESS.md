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
