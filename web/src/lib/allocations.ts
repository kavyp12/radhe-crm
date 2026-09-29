import { and, asc, eq, inArray, isNotNull, notExists, sql, type SQL } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, type Tx } from "@/db";
import { allocations, invoices, receipts } from "@/db/schema";
import { UserError } from "@/lib/action";
import { todayIST } from "@/lib/dates";
import { formatMoney, parseMoney } from "@/lib/num";

// Allocations (A§2, A§5, D49): which money pays what. They never post. Open amounts and payment statuses are
// computed from them on every read, never stored (hard rule 6).

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

/** Σ live allocations per invoice, leaving out one receipt's own (the receipt being edited). */
export async function paidTowards(q: Q, invoiceIds: number[], exceptReceiptId?: number): Promise<Map<number, bigint>> {
  if (!invoiceIds.length) return new Map();
  const rows = await q
    .select({ id: allocations.invoiceId, paise: sql<string>`sum(${allocations.amountPaise})` })
    .from(allocations)
    .where(
      and(
        liveAllocation(),
        inArray(allocations.invoiceId, invoiceIds),
        exceptReceiptId ? sql`${allocations.receiptId} is distinct from ${exceptReceiptId}` : undefined,
      ),
    )
    .groupBy(allocations.invoiceId);
  return new Map(rows.map((r) => [r.id!, BigInt(r.paise)]));
}

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

export type AllocationLine = { invoiceId: number; amount: bigint };

/**
 * The allocation panel as typed (JSON of { target: "invoice", id, amount }) → lines. Blank / zero amounts are
 * skipped; each target once.
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
    if (o.target !== "invoice" || !Number.isSafeInteger(id) || id < 1) fail("The allocations couldn't be read: reload the page.");
    lines.push({ invoiceId: id, amount });
  }
  if (new Set(lines.map((l) => l.invoiceId)).size !== lines.length) fail("Put each invoice on one line only.");
  return lines;
}

/**
 * Checks lines against what is open, locking the target invoices first (in id order) so two receipts can't both
 * take the same open amount. Refuses a total over `available` or a line over its invoice's open amount.
 * Returns the lines with the invoice numbers.
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
  const ids = lines.map((l) => l.invoiceId).sort((a, b) => a - b);
  const rows = ids.length
    ? await tx.select().from(invoices).where(inArray(invoices.id, ids)).orderBy(asc(invoices.id)).for("update")
    : [];
  const paid = await paidTowards(tx, ids, exceptReceiptId);
  return lines.map((l) => {
    const inv = rows.find((r) => r.id === l.invoiceId);
    if (!inv || inv.customerId !== customerId) throw new UserError("An invoice here isn't this customer's: reload the page.", "allocations");
    if (inv.status !== "issued") throw new UserError(`Invoice ${inv.number ?? `#${inv.id}`} isn't issued.`, "allocations");
    const open = inv.totalPaise - (paid.get(inv.id) ?? 0n);
    if (l.amount > open) {
      throw new UserError(`${inv.number}: ${formatMoney(l.amount)} is more than its open ${formatMoney(open)}.`, "allocations");
    }
    return { ...l, number: inv.number! };
  });
}

/** The lines a receipt / credit note has in force (active), oldest first. */
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
