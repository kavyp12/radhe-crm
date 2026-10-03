import { expect, test } from "vitest";
import { dumpsToPrune } from "@/db/retention";

test("backups keep the newest dump of the last 7 days, 4 weeks and 12 months; other files are left alone", () => {
  const files = ["notes.txt", "radhe_dev-2026-10-01-0200.dump", "postgres-2026-10-03-1400.dump"];
  for (let t = Date.UTC(2025, 8, 1); t <= Date.UTC(2026, 9, 3); t += 86_400_000) files.push(`postgres-${new Date(t).toISOString().slice(0, 10)}-0200.dump`);
  const pruned = dumpsToPrune(files, "postgres");
  const kept = files.filter((f) => f.startsWith("postgres-") && !pruned.includes(f)).sort();
  expect(kept).toEqual([
    // 12 months (newest of each): Nov 2025 … Oct 2026
    "postgres-2025-11-30-0200.dump", "postgres-2025-12-31-0200.dump", "postgres-2026-01-31-0200.dump", "postgres-2026-02-28-0200.dump",
    "postgres-2026-03-31-0200.dump", "postgres-2026-04-30-0200.dump", "postgres-2026-05-31-0200.dump", "postgres-2026-06-30-0200.dump",
    "postgres-2026-07-31-0200.dump", "postgres-2026-08-31-0200.dump",
    // 4 weeks: the Sundays 13/09 and 20/09 (27/09 and 03/10 are days too)
    "postgres-2026-09-13-0200.dump", "postgres-2026-09-20-0200.dump",
    // 7 days (30/09 is September's newest too); 03/10 keeps its later dump only
    "postgres-2026-09-27-0200.dump", "postgres-2026-09-28-0200.dump", "postgres-2026-09-29-0200.dump", "postgres-2026-09-30-0200.dump",
    "postgres-2026-10-01-0200.dump", "postgres-2026-10-02-0200.dump", "postgres-2026-10-03-1400.dump",
  ]);
  expect(pruned).toContain("postgres-2026-10-03-0200.dump");
  expect(pruned).not.toContain("notes.txt");
  expect(pruned).not.toContain("radhe_dev-2026-10-01-0200.dump"); // another database's dumps
  expect(dumpsToPrune(["postgres-2026-10-03-0200.dump"], "postgres")).toEqual([]);
});
