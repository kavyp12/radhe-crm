import { count, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import { approvalRequests, users } from "@/db/schema";
import { UserError } from "@/lib/action";
import { addDays, todayIST } from "@/lib/dates";
import { can, type SessionUser } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";

// Approvals (S22, A§7). A sensitive action by anyone but the owner becomes a pending request holding the action's
// input; when the owner approves, the same executor runs with that stored input. The owner's own actions run at
// once (still audited, like every write).

/** One field the owner reviews, shown as old → new (display text, captured when the request is made). */
export type Change = { label: string; old: string | null; new: string | null };

export type Executor<P> = {
  /**
   * Runs when a non-owner asks: checks the action can be requested (throw UserError if not) and says what it
   * will change.
   */
  describe(tx: Tx, payload: P): Promise<{ summary: string; target?: { type: string; id: number }; changes: Change[] }>;
  /** Does the action inside the owner's writeTx: at once for an owner, on approval for anyone else. */
  run(tx: Tx, owner: SessionUser, payload: P): Promise<unknown>;
};

const executors = new Map<string, Executor<never>>();

/**
 * Registers the action behind an approval type. Call it at the top level of the module that owns the action and
 * import that module in app/(app)/approvals/actions.ts, so approving can find it. Payloads are stored as JSON:
 * pass what the user typed (amounts as text), not bigint.
 */
export function registerExecutor<P>(type: string, executor: Executor<P>) {
  executors.set(type, executor as Executor<never>);
}

function executor(type: string): Executor<unknown> {
  const e = executors.get(type);
  if (!e) throw new Error(`Unknown approval type "${type}": is its module imported in app/(app)/approvals/actions.ts?`);
  return e as Executor<unknown>;
}

export const APPROVAL_STATUS: Record<"pending" | "approved" | "rejected", Status> = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const SENT_FOR_APPROVAL = "Sent for approval. It will be done once the owner approves it.";

export type Outcome = { done: true; result: unknown } | { done: false; requestId: number; message: string };

/**
 * The owner: runs the action now. Anyone else: files a pending request and changes nothing else. The caller has
 * already checked that the actor may attempt the action at all (permissions) and that it needs approval.
 */
export async function runOrRequest<P>(actor: SessionUser, type: string, payload: P, reason: string): Promise<Outcome> {
  const e = executor(type);
  if (can(actor, "approvals", "approve")) {
    return { done: true, result: await writeTx(actor, (tx) => e.run(tx, actor, payload)) };
  }
  const requestId = await writeTx(actor, async (tx) => {
    const { summary, target, changes } = await e.describe(tx, payload);
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        type,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        payload,
        summary,
        changes,
        reason: reason.trim() || null,
        requestedBy: actor.id,
      })
      .returning({ id: approvalRequests.id });
    return row.id;
  });
  return { done: false, requestId, message: SENT_FOR_APPROVAL };
}

/** Locks a pending request; anything already decided is refused, so a request runs at most once. */
async function lockPending(tx: Tx, id: number) {
  const [req] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).for("update");
  if (!req) throw new UserError("That request doesn't exist.");
  if (req.status !== "pending") throw new UserError(`This request was already ${req.status}.`);
  return req;
}

async function decide(tx: Tx, owner: SessionUser, id: number, status: "approved" | "rejected", note: string) {
  const decisionNote = note.trim().slice(0, 1000) || null;
  await tx
    .update(approvalRequests)
    .set({ status, decidedBy: owner.id, decidedAt: sql`now()`, decisionNote })
    .where(eq(approvalRequests.id, id));
}

/** Owner only: runs the stored action and marks the request approved, in one transaction. */
export async function approve(owner: SessionUser, id: number, note: string) {
  if (!can(owner, "approvals", "approve")) throw new Error("Not allowed");
  await writeTx(owner, async (tx) => {
    const req = await lockPending(tx, id);
    await executor(req.type).run(tx, owner, req.payload);
    await decide(tx, owner, id, "approved", note);
  });
}

/** Owner only: nothing runs; the request is closed as rejected. */
export async function reject(owner: SessionUser, id: number, note: string) {
  if (!can(owner, "approvals", "approve")) throw new Error("Not allowed");
  await writeTx(owner, async (tx) => {
    await lockPending(tx, id);
    await decide(tx, owner, id, "rejected", note);
  });
}

export async function pendingCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(approvalRequests).where(eq(approvalRequests.status, "pending"));
  return row.n;
}

const requester = alias(users, "requester");
const decider = alias(users, "decider");

/** Requests with the people's names, newest first. */
function requests(where: SQL, limit?: number) {
  const query = db
    .select({
      id: approvalRequests.id,
      summary: approvalRequests.summary,
      targetType: approvalRequests.targetType,
      targetId: approvalRequests.targetId,
      changes: approvalRequests.changes,
      reason: approvalRequests.reason,
      status: approvalRequests.status,
      requestedBy: requester.name,
      requestedAt: approvalRequests.createdAt,
      decidedBy: decider.name,
      decidedAt: approvalRequests.decidedAt,
      decisionNote: approvalRequests.decisionNote,
    })
    .from(approvalRequests)
    .innerJoin(requester, eq(requester.id, approvalRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, approvalRequests.decidedBy))
    .where(where)
    .orderBy(desc(approvalRequests.id));
  return limit ? query.limit(limit) : query;
}

export const pendingRequests = () => requests(eq(approvalRequests.status, "pending"));
// ponytail: the newest 300 decisions; page on the server if the owner needs to look further back.
export const decidedRequests = () => requests(ne(approvalRequests.status, "pending"), 300);
export const getRequest = async (id: number) => (await requests(eq(approvalRequests.id, id)))[0];

/**
 * A document dated before today − backdate days needs approval when not done by the owner (A§7).
 * Backdate days not set = 0: anything dated before today (D39).
 */
export async function needsBackdateApproval(date: string): Promise<boolean> {
  const { backdateDays } = await getSettings();
  return date < addDays(todayIST(), -(backdateDays ?? 0));
}

/**
 * A discount above the limit needs approval when not done by the owner: discount / amount > limit (integer maths:
 * discount × 10000 > limit_bp × amount). Limit not set = 0: any discount (D39).
 */
export async function discountNeedsApproval(discount: bigint, amount: bigint): Promise<boolean> {
  const { discountLimitBp } = await getSettings();
  return discount * 10000n > BigInt(discountLimitBp ?? 0) * amount;
}
