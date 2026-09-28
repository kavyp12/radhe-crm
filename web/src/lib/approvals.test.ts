import { and, count, eq, sql } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { db, writeTx } from "@/db";
import { accounts, approvalRequests, auditLog, settings } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { UserError } from "@/lib/action";
import {
  approve,
  discountNeedsApproval,
  needsBackdateApproval,
  reject,
  registerExecutor,
  runOrRequest,
  type Outcome,
} from "@/lib/approvals";
import { addDays, todayIST } from "@/lib/dates";
import type { SessionUser } from "@/lib/permissions";
import { createUser } from "@/lib/users";

// The dummy action renames a throwaway account (accounts are audited) and counts how often it really ran.
const TYPE = "test.rename_account";
type Rename = { accountId: number; name: string; holdMs?: number };
let runs = 0;
registerExecutor<Rename>(TYPE, {
  async describe(tx, p) {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, p.accountId));
    if (!a) throw new UserError("No such account.");
    return {
      summary: `Rename account ${a.code}`,
      target: { type: "accounts", id: a.id },
      changes: [{ label: "Name", old: a.name, new: p.name }],
    };
  },
  async run(tx, _owner, p) {
    if (!p.name) throw new UserError("Give the account a name.");
    runs++;
    await tx.update(accounts).set({ name: p.name }).where(eq(accounts.id, p.accountId));
    if (p.holdMs) await new Promise((done) => setTimeout(done, p.holdMs)); // keeps the transaction open
  },
});

let owner: SessionUser;
let accountant: SessionUser;
let accountId: number;
beforeAll(async () => {
  owner = await testOwner();
  const user = { name: "Approval Accountant", username: "approval.acc", role: "accountant" as const, canViewCost: true };
  accountant = { ...user, id: await createUser(owner, { ...user, password: "approval-pass-1" }) };
  const [row] = await writeTx(owner, (tx) =>
    tx.insert(accounts).values({ code: "T-APPROVAL", name: "Before", type: "expense" }).returning({ id: accounts.id }),
  );
  accountId = row.id;
});

const nameNow = async () => (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0].name;
const requestRow = async (id: number) => (await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)))[0];
const requestCount = async () => (await db.select({ n: count() }).from(approvalRequests))[0].n;
const audit = (table: string, rowId: number) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tableName, table), eq(auditLog.rowId, String(rowId))))
    .orderBy(auditLog.id);
const requested = (o: Outcome) => {
  if (o.done) throw new Error("expected a pending request");
  return o.requestId;
};

test("a non-owner's action becomes a pending request with old → new, and nothing else changes", async () => {
  const name = await nameNow();
  runs = 0;
  const outcome = await runOrRequest(accountant, TYPE, { accountId, name: "After" }, "  Typo in the name ");
  expect(outcome).toMatchObject({ done: false, message: expect.stringContaining("Sent for approval") });
  const id = requested(outcome);

  expect(runs).toBe(0);
  expect(await nameNow()).toBe(name);
  expect(await requestRow(id)).toMatchObject({
    type: TYPE,
    status: "pending",
    targetType: "accounts",
    targetId: accountId,
    payload: { accountId, name: "After" },
    summary: "Rename account T-APPROVAL",
    changes: [{ label: "Name", old: name, new: "After" }],
    reason: "Typo in the name",
    requestedBy: accountant.id,
    decidedBy: null,
  });
  expect((await audit("approval_requests", id)).map((r) => [r.action, r.userId])).toEqual([["insert", accountant.id]]);
});

test("a request the action refuses is not filed", async () => {
  const before = await requestCount();
  await expect(runOrRequest(accountant, TYPE, { accountId: 999_999, name: "X" }, "")).rejects.toThrow("No such account");
  await expect(runOrRequest(accountant, "test.unknown", {}, "")).rejects.toThrow('Unknown approval type "test.unknown"');
  expect(await requestCount()).toBe(before);
});

test("approve runs the stored action exactly once, even when two approvals race", async () => {
  const id = requested(await runOrRequest(accountant, TYPE, { accountId, name: "Approved name", holdMs: 300 }, ""));
  runs = 0;
  // Two open connections, and the action holds its transaction for 300 ms, so both approvals really overlap.
  await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);
  const results = await Promise.allSettled([approve(owner, id, " Fine "), approve(owner, id, " Fine ")]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(runs).toBe(1);
  expect(await nameNow()).toBe("Approved name");
  expect(await requestRow(id)).toMatchObject({ status: "approved", decidedBy: owner.id, decisionNote: "Fine" });

  // A later approve or reject does nothing.
  await expect(approve(owner, id, "again")).rejects.toThrow("already approved");
  await expect(reject(owner, id, "")).rejects.toThrow("already approved");
  expect(runs).toBe(1);

  expect((await audit("approval_requests", id)).map((r) => [r.action, r.userId])).toEqual([
    ["insert", accountant.id],
    ["update", owner.id],
  ]);
  const last = (await audit("accounts", accountId)).at(-1);
  expect(last).toMatchObject({ action: "update", userId: owner.id, newData: { name: "Approved name" } });
});

test("reject changes nothing but the request", async () => {
  const name = await nameNow();
  const id = requested(await runOrRequest(accountant, TYPE, { accountId, name: "Rejected name" }, ""));
  const accountAudit = (await audit("accounts", accountId)).length;
  runs = 0;
  await reject(owner, id, "Keep it");
  expect(runs).toBe(0);
  expect(await nameNow()).toBe(name);
  expect(await requestRow(id)).toMatchObject({ status: "rejected", decidedBy: owner.id, decisionNote: "Keep it" });
  expect((await audit("approval_requests", id)).map((r) => [r.action, r.userId])).toEqual([
    ["insert", accountant.id],
    ["update", owner.id],
  ]);
  expect(await audit("accounts", accountId)).toHaveLength(accountAudit);
  await expect(approve(owner, id, "")).rejects.toThrow("already rejected");
});

test("if the action fails on approval, nothing is saved and the request stays pending", async () => {
  const name = await nameNow();
  const id = requested(await runOrRequest(accountant, TYPE, { accountId, name: "" }, ""));
  await expect(approve(owner, id, "")).rejects.toThrow("Give the account a name");
  expect(await nameNow()).toBe(name);
  expect(await requestRow(id)).toMatchObject({ status: "pending", decidedBy: null });
  await reject(owner, id, "Empty name");
});

test("the owner's own action runs at once, files no request, and is audited", async () => {
  const before = await requestCount();
  runs = 0;
  expect(await runOrRequest(owner, TYPE, { accountId, name: "Owner name" }, "")).toMatchObject({ done: true });
  expect(runs).toBe(1);
  expect(await nameNow()).toBe("Owner name");
  expect(await requestCount()).toBe(before);
  const last = (await audit("accounts", accountId)).at(-1);
  expect(last).toMatchObject({ action: "update", userId: owner.id, newData: { name: "Owner name" } });
});

test("only the owner can approve or reject", async () => {
  const id = requested(await runOrRequest(accountant, TYPE, { accountId, name: "Nope" }, ""));
  await expect(approve(accountant, id, "")).rejects.toThrow("Not allowed");
  await expect(reject(accountant, id, "")).rejects.toThrow("Not allowed");
  expect(await requestRow(id)).toMatchObject({ status: "pending" });
  await reject(owner, id, "");
});

test("backdate and discount checks read Settings; empty = fail-safe 0 (D39); integer maths", async () => {
  const [saved] = await db.select().from(settings);
  const set = (discountLimitBp: number | null, backdateDays: number | null) =>
    writeTx(owner, (tx) => tx.update(settings).set({ discountLimitBp, backdateDays }).where(eq(settings.id, 1)));
  const today = todayIST();
  try {
    await set(null, null);
    expect(await needsBackdateApproval(today)).toBe(false);
    expect(await needsBackdateApproval(addDays(today, -1))).toBe(true);
    expect(await discountNeedsApproval(0n, 100_00n)).toBe(false);
    expect(await discountNeedsApproval(1n, 100_00n)).toBe(true);

    await set(1000, 3); // 10 %, 3 days
    expect(await needsBackdateApproval(addDays(today, -3))).toBe(false);
    expect(await needsBackdateApproval(addDays(today, -4))).toBe(true);
    expect(await needsBackdateApproval(addDays(today, 5))).toBe(false);
    expect(await discountNeedsApproval(10_00n, 100_00n)).toBe(false); // exactly 10 %
    expect(await discountNeedsApproval(10_01n, 100_00n)).toBe(true);
    expect(await discountNeedsApproval(1n, 0n)).toBe(true);

    await set(1250, 0); // 12.5 %
    expect(await discountNeedsApproval(12_50n, 100_00n)).toBe(false);
    expect(await discountNeedsApproval(12_51n, 100_00n)).toBe(true);
    expect(await needsBackdateApproval(addDays(today, -1))).toBe(true);
  } finally {
    await set(saved.discountLimitBp, saved.backdateDays);
  }
});
