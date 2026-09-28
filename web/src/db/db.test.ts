import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { db } from "@/db";
import journal from "../../drizzle/meta/_journal.json";

test("app db client is on the migrated test DB", async () => {
  const [{ name }] = await db.execute<{ name: string }>(sql`select current_database() as name`);
  expect(name).toBe("radhe_test");

  const applied = await db.execute<{ created_at: string }>(
    sql`select created_at from drizzle.__drizzle_migrations order by id`,
  );
  expect(applied.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
});
