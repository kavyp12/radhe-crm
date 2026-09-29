import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import { jobs, MATERIAL_REQUEST_STATUSES, materialRequestLines, materialRequests, stockItems, users } from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { todayIST } from "@/lib/dates";
import { milliText } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";
import { readItemLines } from "@/lib/stock-issues";

// Material requests (S18, A§8, D53): production, the accountant or the owner ask for stock items (qty, a needed-by
// date, an optional job, a note), numbered MR/ when saved. Only the owner approves or rejects (with an optional
// note); a purchase order made from an approved request marks it Ordered (lib/purchase-orders.ts). Its maker may
// cancel it while it is pending. Pending requests wait on /approvals and count in the bell. Qty only, never values.

export type RequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];
export const REQUEST_STATUS: Record<RequestStatus, Status> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  ordered: "Ordered",
  cancelled: "Cancelled",
};

/** The form as typed. lines = JSON of { itemId, qty }[]. */
export type RequestInput = { neededBy: string; jobId: string; notes: string; lines: string };

export async function createRequest(actor: SessionUser, input: RequestInput): Promise<{ id: number; number: string }> {
  if (!can(actor, "materialRequests", "create")) throw new Error("Not allowed");
  let neededBy: string;
  try {
    neededBy = readDate(input.neededBy);
  } catch {
    throw new UserError("Enter the date it is needed by (DD/MM/YYYY).", "neededBy");
  }
  const lines = readItemLines(input.lines);
  const notes = formText(input.notes, "notes", 1000);
  return writeTx(actor, async (tx) => {
    let jobId: number | null = null;
    if (input.jobId) {
      const [job] = Number.isSafeInteger(Number(input.jobId)) ? await tx.select().from(jobs).where(eq(jobs.id, Number(input.jobId))) : [];
      if (!job) throw new UserError("Pick the job again.", "jobId");
      if (job.status === "cancelled") throw new UserError(`Job ${job.number} is cancelled.`, "jobId");
      jobId = job.id;
    }
    const items = await tx.select().from(stockItems).where(inArray(stockItems.id, lines.map((l) => l.itemId)));
    lines.forEach((l, i) => {
      const item = items.find((x) => x.id === l.itemId);
      if (!item) throw new UserError(`Line ${i + 1}: that item doesn't exist; pick it again.`, "lines");
      if (!item.active) throw new UserError(`Line ${i + 1}: ${item.name} is inactive.`, "lines");
    });
    const date = todayIST();
    const number = await nextNumber(tx, "material_request", date);
    const [row] = await tx
      .insert(materialRequests)
      .values({ number, date, neededBy, jobId, notes, createdBy: actor.id })
      .returning({ id: materialRequests.id });
    await tx.insert(materialRequestLines).values(lines.map((l, i) => ({ requestId: row.id, position: i + 1, itemId: l.itemId, qtyMilli: l.qty })));
    return { id: row.id, number };
  });
}

async function lockPending(tx: Tx, id: number) {
  const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, id)).for("update");
  if (!r) throw new UserError("That request doesn't exist.");
  if (r.status !== "pending") throw new UserError(`${r.number} is already ${REQUEST_STATUS[r.status].toLowerCase()}.`);
  return r;
}

/** The owner's decision (D53): Pending → Approved / Rejected, with an optional note. */
export async function decideRequest(actor: SessionUser, id: number, decision: "approve" | "reject", note: string) {
  if (!can(actor, "materialRequests", "approve")) throw new Error("Not allowed");
  const decisionNote = formText(note, "note", 1000);
  return writeTx(actor, async (tx) => {
    const r = await lockPending(tx, id);
    await tx
      .update(materialRequests)
      .set({ status: decision === "approve" ? "approved" : "rejected", decidedBy: actor.id, decidedAt: sql`now()`, decisionNote })
      .where(eq(materialRequests.id, r.id));
    return { message: decision === "approve" ? `Approved ${r.number}.` : `Rejected ${r.number}.` };
  });
}

/** Its maker takes it back while it is still pending. */
export async function cancelRequest(actor: SessionUser, id: number) {
  if (!can(actor, "materialRequests", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const r = await lockPending(tx, id);
    if (r.createdBy !== actor.id) throw new UserError("Only the person who asked for it can cancel it.");
    await tx.update(materialRequests).set({ status: "cancelled" }).where(eq(materialRequests.id, r.id));
    return { message: `Cancelled ${r.number}.` };
  });
}

// ---- Loaders (qty only: safe for production)

const maker = alias(users, "maker");
const decider = alias(users, "decider");

async function linesOf(requestIds: number[]) {
  if (!requestIds.length) return [];
  return db
    .select({
      id: materialRequestLines.id,
      requestId: materialRequestLines.requestId,
      position: materialRequestLines.position,
      itemId: materialRequestLines.itemId,
      name: stockItems.name,
      unit: stockItems.unit,
      qty: materialRequestLines.qtyMilli,
    })
    .from(materialRequestLines)
    .innerJoin(stockItems, eq(stockItems.id, materialRequestLines.itemId))
    .where(inArray(materialRequestLines.requestId, requestIds))
    .orderBy(asc(materialRequestLines.requestId), asc(materialRequestLines.position));
}

export const itemsText = (lines: { name: string; qty: bigint; unit: string }[]) =>
  lines.map((l) => `${l.name} × ${milliText(l.qty)} ${l.unit}`).join(", ");

/** Requests, newest first (only `status` ones when given), with who asked, the job and the items as text. */
export async function listRequests(status?: RequestStatus) {
  const rows = await db
    .select({
      id: materialRequests.id,
      number: materialRequests.number,
      date: materialRequests.date,
      neededBy: materialRequests.neededBy,
      status: materialRequests.status,
      jobId: materialRequests.jobId,
      job: jobs.number,
      requestedBy: maker.name,
      createdAt: materialRequests.createdAt,
    })
    .from(materialRequests)
    .leftJoin(jobs, eq(jobs.id, materialRequests.jobId))
    .leftJoin(maker, eq(maker.id, materialRequests.createdBy))
    .where(status ? eq(materialRequests.status, status) : undefined)
    .orderBy(desc(materialRequests.id));
  const lines = Map.groupBy(await linesOf(rows.map((r) => r.id)), (l) => l.requestId);
  return rows.map((r) => ({ ...r, items: itemsText(lines.get(r.id) ?? []), lines: lines.get(r.id) ?? [] }));
}

export async function getRequest(id: number) {
  const [row] = await db
    .select({ request: materialRequests, job: jobs.number, requestedBy: maker.name, decidedBy: decider.name })
    .from(materialRequests)
    .leftJoin(jobs, eq(jobs.id, materialRequests.jobId))
    .leftJoin(maker, eq(maker.id, materialRequests.createdBy))
    .leftJoin(decider, eq(decider.id, materialRequests.decidedBy))
    .where(eq(materialRequests.id, id));
  if (!row) return undefined;
  return { ...row.request, job: row.job, requestedBy: row.requestedBy, decidedByName: row.decidedBy, lines: await linesOf([id]) };
}

/** Pending requests: they count in the owner's bell (D53). */
export async function pendingRequestCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(materialRequests).where(eq(materialRequests.status, "pending"));
  return row.n;
}
