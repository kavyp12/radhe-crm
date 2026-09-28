import { and, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import type { SessionUser } from "@/lib/permissions";
import { createUser, resetPassword, updateUser } from "@/lib/users";

let owner: SessionUser;
beforeAll(async () => {
  owner = await testOwner();
});

const userAudit = (id: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, "users"), eq(auditLog.rowId, id)))
    .orderBy(auditLog.id);

test("user changes are audited with the owner who made them, and no password lands in the log", async () => {
  const id = await createUser(owner, {
    name: "Audit Me",
    username: "audit.me",
    role: "sales",
    canViewCost: false,
    password: "audit-pass-1",
  });
  await updateUser(owner, id, { role: "accountant" });
  await resetPassword(owner, id, "audit-pass-2");

  const rows = await userAudit(id);
  expect(rows.map((r) => [r.action, r.userId])).toEqual([
    ["insert", owner.id],
    ["update", owner.id],
    ["update", owner.id],
  ]);
  expect(rows[1].oldData).toMatchObject({ role: "sales" });
  expect(rows[1].newData).toMatchObject({ role: "accountant" });
  expect(rows[2].oldData?.password_changed_at).toBeNull();
  expect(rows[2].newData?.password_changed_at).toBeTruthy();
  expect(JSON.stringify(rows)).not.toContain("audit-pass");
});

test("audit_log is append-only: UPDATE, DELETE and TRUNCATE fail", async () => {
  const id = await createUser(owner, {
    name: "Keep Me",
    username: "keep.me",
    role: "production",
    canViewCost: false,
    password: "keep-pass-12",
  });
  const sql = db.$client;
  await expect(sql`update audit_log set action = 'delete' where row_id = ${id}`).rejects.toThrow(
    "audit_log is append-only",
  );
  await expect(sql`delete from audit_log where row_id = ${id}`).rejects.toThrow("audit_log is append-only");
  await expect(sql`truncate audit_log`).rejects.toThrow("audit_log is append-only");
  expect(await userAudit(id)).toHaveLength(1);
});
