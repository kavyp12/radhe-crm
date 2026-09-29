import { and, asc, eq, inArray, isNotNull, notExists, sql, type SQL } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, type Tx } from "@/db";
import { allocations, invoices, jobs, receipts } from "@/db/schema";
import { UserError } from "@/lib/action";
import { todayIST } from "@/lib/dates";
import { PRODUCTION_STATUSES } from "@/lib/jobs";
import { formatMoney, parseMoney } from "@/lib/num";

// Allocations (A§2, A§5, D49): which money pays what — an invoice, or a job as an advance (S12). They never post.
// Open amounts and payment statuses are computed from them on every read, never stored (hard rule 6).

type Q = Tx | typeof db;

/** Active rows from sources that aren't cancelled (D49). */
export const liveAllocation = (): SQL =>
  and(
    eq(allocations.active, true),
    notExists(
      db
        .select({ one: sql`1` })
        .from(receipts)
        .where(and(eq(receipts.id, allocations.receiptId), eq(receipts.status, "cancelled"))),
    ),
  )!;

/** Σ live allocations per target id, leaving out one receipt's own (the receipt being edited). */
async function sums(
  q: Q,
  column: typeof allocations.invoiceId | typeof allocations.jobId,
  ids: number[],
  exceptReceiptId?: number,
): Promise<Map<number, bigint>> {
  if (!ids.length) return new Map();
  const rows = await q
    .select({ id: column, paise: sql<string>`sum(${allocations.amountPaise})` })
    .from(allocations)
    .where(
      and(
        liveAllocation(),
        inArray(column, ids),
        exceptReceiptId ? sql`${allocations.receiptId} is distinct from ${exceptReceiptId}` : undefined,
      ),
    )
    .groupBy(column);
  return new Map(rows.map((r) => [r.id!, BigInt(r.paise)]));
}

/** Σ live allocations per invoice. */
export const paidTowards = (q: Q, invoiceIds: number[], exceptReceiptId?: number) =>
  sums(q, allocations.invoiceId, invoiceIds, exceptReceiptId);

/** Σ live advances per job (S12). */
export const advancesOn = (q: Q, jobIds: number[], exceptReceiptId?: number) =>
  sums(q, allocations.jobId, jobIds, exceptReceiptId);

/** Σ live allocations per invoice, as a subquery to join in lists. */
export const paidByInvoice = () =>
  db
    .select({ invoiceId: allocations.invoiceId, paise: sql<string>`sum(${allocations.amountPaise})`.as("paid_paise") })
    .from(allocations)
    .where(and(liveAllocation(), isNotNull(allocations.invoiceId)))
    .groupBy(allocations.invoiceId)
    .as("paid");

export type PaymentStatus = Extract<Status, "Cancelled" | "Paid" | "Overdue" | "Part Payment" | "Unpaid">;

/** A§5: Cancelled; open 0 → Paid; past the due date → Overdue; partly paid → Part Payment; else Unpaid. Drafts: none. */
export function paymentStatus(
  doc: { status: string; totalPaise: bigint; dueDate: string },
  open: bigint,
  today = todayIST(),
): PaymentStatus | null {
  if (doc.status === "cancelled") return "Cancelled";
  if (doc.status !== "issued") return null;
  if (open <= 0n) return "Paid";
  if (doc.dueDate < today) return "Overdue";
  return open < doc.totalPaise ? "Part Payment" : "Unpaid";
}

/** A customer's issued invoices with something still open, oldest first (D49: date, then number). */
export async function openInvoices(q: Q, customerId: number, exceptReceiptId?: number) {
  const rows = await q
    .select({ id: invoices.id, number: invoices.number, date: invoices.date, dueDate: invoices.dueDate, total: invoices.totalPaise })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, "issued")))
    .orderBy(asc(invoices.date), asc(invoices.number));
  const paid = await paidTowards(q, rows.map((r) => r.id), exceptReceiptId);
  return rows
    .map((r) => ({ ...r, number: r.number ?? "", open: r.total - (paid.get(r.id) ?? 0n) }))
    .filter((r) => r.open > 0n);
}

/** A customer's jobs that can take an advance (not invoiced or cancelled, S12), with what they already hold. */
export async function openJobs(q: Q, customerId: number, exceptReceiptId?: number) {
  const rows = await q
    .select({ id: jobs.id, number: jobs.number, date: jobs.date, status: jobs.status, total: jobs.totalPaise })
    .from(jobs)
    .where(and(eq(jobs.customerId, customerId), inArray(jobs.status, [...PRODUCTION_STATUSES])))
    .orderBy(asc(jobs.date), asc(jobs.id));
  const held = await advancesOn(q, rows.map((r) => r.id), exceptReceiptId);
  return rows.map((r) => ({ ...r, advance: held.get(r.id) ?? 0n }));
}

export type AllocationTarget = "invoice" | "job";
/** One line of the allocation panel: an invoice, or a job (= an advance on it). */
export type AllocationLine = { target: AllocationTarget; id: number; amount: bigint };

/**
 * The allocation panel as typed (JSON of { target: "invoice" | "job", id, amount }) → lines. Blank / zero amounts
 * are skipped; each target once.
 */
export function readAllocations(json: string): AllocationLine[] {
  const fail = (message: string): never => {
    throw new UserError(message, "allocations");
  };
  let raw: unknown;
  try {
    raw = JSON.parse(json || "[]");
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) fail("The allocations couldn't be read: reload the page.");
  const lines: AllocationLine[] = [];
  for (const row of raw as unknown[]) {
    const o = (row ?? {}) as Record<string, unknown>;
    const text = typeof o.amount === "string" ? o.amount.trim() : "";
    if (!text) continue;
    let amount = 0n;
    try {
      amount = parseMoney(text);
    } catch {
      fail(`Enter amounts like 20,000 or 1,250.50 (not "${text}").`);
    }
    if (amount < 0n) fail("An allocation can't be negative.");
    if (amount === 0n) continue;
    const id = Number(o.id);
    const target = o.target === "invoice" || o.target === "job" ? o.target : null;
    if (!target || !Number.isSafeInteger(id) || id < 1) fail("The allocations couldn't be read: reload the page.");
    lines.push({ target: target!, id, amount });
  }
  if (new Set(lines.map((l) => `${l.target}:${l.id}`)).size !== lines.length) fail("Put each invoice or job on one line only.");
  return lines;
}

const idsOf = (lines: AllocationLine[], target: AllocationTarget) =>
  lines
    .filter((l) => l.target === target)
    .map((l) => l.id)
    .sort((a, b) => a - b);

/**
 * Checks lines against what is open, locking the target invoices and then jobs (id order, as Issue does) so two
 * receipts can't both take the same open amount. Refuses a total over `available`, a line over its invoice's open
 * amount, or a job already invoiced / cancelled. Returns the lines with their document numbers.
 */
export async function checkAllocations(
  tx: Tx,
  customerId: number,
  available: bigint,
  lines: AllocationLine[],
  exceptReceiptId?: number,
) {
  const total = lines.reduce((s, l) => s + l.amount, 0n);
  if (total > available) {
    throw new UserError(`${formatMoney(total)} allocated is more than the ${formatMoney(available)} received.`, "allocations");
  }
  const [invoiceIds, jobIds] = [idsOf(lines, "invoice"), idsOf(lines, "job")];
  const invoiceRows = invoiceIds.length
    ? await tx.select().from(invoices).where(inArray(invoices.id, invoiceIds)).orderBy(asc(invoices.id)).for("update")
    : [];
  const jobRows = jobIds.length
    ? await tx.select().from(jobs).where(inArray(jobs.id, jobIds)).orderBy(asc(jobs.id)).for("update")
    : [];
  const paid = await paidTowards(tx, invoiceIds, exceptReceiptId);
  return lines.map((l) => {
    if (l.target === "job") {
      const job = jobRows.find((j) => j.id === l.id);
      if (!job || job.customerId !== customerId) throw new UserError("A job here isn't this customer's: reload the page.", "allocations");
      if (!(PRODUCTION_STATUSES as readonly string[]).includes(job.status)) {
        throw new UserError(`Job ${job.number} is ${job.status}: allocate to its invoice instead.`, "allocations");
      }
      return { ...l, number: job.number };
    }
    const inv = invoiceRows.find((r) => r.id === l.id);
    if (!inv || inv.customerId !== customerId) throw new UserError("An invoice here isn't this customer's: reload the page.", "allocations");
    if (inv.status !== "issued") throw new UserError(`Invoice ${inv.number ?? `#${inv.id}`} isn't issued.`, "allocations");
    const open = inv.totalPaise - (paid.get(inv.id) ?? 0n);
    if (l.amount > open) {
      throw new UserError(`${inv.number}: ${formatMoney(l.amount)} is more than its open ${formatMoney(open)}.`, "allocations");
    }
    return { ...l, number: inv.number! };
  });
}

/** The lines a receipt has in force (active), oldest first. */
export const activeAllocationsOf = (q: Q, receiptId: number) =>
  q
    .select()
    .from(allocations)
    .where(and(eq(allocations.receiptId, receiptId), eq(allocations.active, true)))
    .orderBy(asc(allocations.id));

/** Deactivates rows (D49: never deleted; the audit log keeps who and when). */
export async function deactivate(tx: Tx, ids: number[]) {
  if (ids.length) await tx.update(allocations).set({ active: false }).where(inArray(allocations.id, ids));
}

/**
 * Invoice Issue (S12, D49): the billed jobs' advances move to the invoice, oldest receipt first, up to `open`. Every
 * job row is deactivated; what doesn't fit stays with its receipt as on-account advance. Returns the amount moved.
 */
export async function moveJobAdvances(tx: Tx, invoiceId: number, jobIds: number[], open: bigint, by: string) {
  if (!jobIds.length) return 0n;
  const rows = await tx
    .select({ allocation: allocations })
    .from(allocations)
    .innerJoin(receipts, eq(receipts.id, allocations.receiptId))
    .where(and(liveAllocation(), inArray(allocations.jobId, jobIds)))
    .orderBy(asc(receipts.date), asc(allocations.id));
  let left = open;
  for (const { allocation: a } of rows) {
    const take = left <= 0n ? 0n : a.amountPaise < left ? a.amountPaise : left;
    if (take > 0n) {
      await tx.insert(allocations).values({ receiptId: a.receiptId, invoiceId, fromJobId: a.jobId, amountPaise: take, createdBy: by });
      left -= take;
    }
  }
  await deactivate(tx, rows.map((r) => r.allocation.id));
  return open - left;
}

/**
 * Invoice cancel (D49): what came from a job's advance goes back to that job; everything else allocated to the
 * invoice goes back on account.
 */
export async function releaseInvoice(tx: Tx, invoiceId: number, by: string) {
  const rows = await tx
    .select()
    .from(allocations)
    .where(and(eq(allocations.invoiceId, invoiceId), eq(allocations.active, true)));
  for (const a of rows) {
    if (a.fromJobId !== null && a.receiptId !== null) {
      await tx.insert(allocations).values({ receiptId: a.receiptId, jobId: a.fromJobId, amountPaise: a.amountPaise, createdBy: by });
    }
  }
  await deactivate(tx, rows.map((a) => a.id));
}

/** What an invoice shows as "Advance adjusted" (S5): the job advances moved onto it at Issue, still in force. */
export async function advanceAdjusted(q: Q, invoiceId: number): Promise<bigint> {
  const [row] = await q
    .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(and(liveAllocation(), eq(allocations.invoiceId, invoiceId), isNotNull(allocations.fromJobId)));
  return BigInt(row.paise);
}
