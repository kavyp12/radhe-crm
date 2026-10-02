import { and, asc, eq, inArray, isNotNull, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import { adjustments, allocations, creditNotes, debitNotes, invoiceLines, invoices, jobs, printJobs, receipts } from "@/db/schema";
import { UserError } from "@/lib/action";
import { todayIST } from "@/lib/dates";
import { PRODUCTION_STATUSES } from "@/lib/jobs";
import { formatMoney, parseMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";

// Allocations (A§2, A§5, D49): which money (a receipt, a credit note) pays what — an invoice, a debit note, a job
// as an advance (S12), or a print job not yet billed (money taken at the print, D64). A write-off / discount JV settles invoices the same way; a refund JV is the target of the
// on-account money it paid back (D55, lib/adjustments.ts). They never post. Open amounts and payment statuses are
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
    notExists(
      db
        .select({ one: sql`1` })
        .from(creditNotes)
        .where(and(eq(creditNotes.id, allocations.creditNoteId), eq(creditNotes.status, "cancelled"))),
    ),
  )!;

/** Σ live allocations per target id, leaving out one receipt's own (the receipt being edited). */
async function sums(
  q: Q,
  column: typeof allocations.invoiceId | typeof allocations.jobId | typeof allocations.debitNoteId | typeof allocations.printJobId,
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

/** Σ live allocations per debit note (a receivable of its own, T16). */
export const paidTowardsDebitNotes = (q: Q, noteIds: number[], exceptReceiptId?: number) =>
  sums(q, allocations.debitNoteId, noteIds, exceptReceiptId);

/** Σ live money on print jobs not yet billed (D64). */
export const paidTowardsPrintJobs = (q: Q, printJobIds: number[], exceptReceiptId?: number) =>
  sums(q, allocations.printJobId, printJobIds, exceptReceiptId);

/** The print job is on an invoice that isn't cancelled (draft or issued): billed, so it takes no more money (D64). */
export const printJobBilled = (printJobId: typeof printJobs.id) =>
  db
    .select({ one: sql`1` })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.printJobId, printJobId), ne(invoices.status, "cancelled")));

/** Σ live allocations per invoice, as a subquery to join in lists. */
export const paidByInvoice = () =>
  db
    .select({ invoiceId: allocations.invoiceId, paise: sql<string>`sum(${allocations.amountPaise})`.as("paid_paise") })
    .from(allocations)
    .where(and(liveAllocation(), isNotNull(allocations.invoiceId)))
    .groupBy(allocations.invoiceId)
    .as("paid");

/** Σ live allocations per debit note, as a subquery to join in lists. */
export const paidByDebitNote = () =>
  db
    .select({ debitNoteId: allocations.debitNoteId, paise: sql<string>`sum(${allocations.amountPaise})`.as("dn_paid_paise") })
    .from(allocations)
    .where(and(liveAllocation(), isNotNull(allocations.debitNoteId)))
    .groupBy(allocations.debitNoteId)
    .as("dn_paid");

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

/**
 * A customer's issued invoices and debit notes with something still open, oldest first (D49: date, then number) —
 * the receivables a receipt can pay.
 */
export async function openInvoices(q: Q, customerId: number, exceptReceiptId?: number) {
  const [invoiceRows, noteRows] = await Promise.all([
    q
      .select({ id: invoices.id, number: invoices.number, date: invoices.date, dueDate: invoices.dueDate, total: invoices.totalPaise })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.status, "issued"))),
    q
      .select({ id: debitNotes.id, number: debitNotes.number, date: debitNotes.date, dueDate: debitNotes.dueDate, total: debitNotes.totalPaise })
      .from(debitNotes)
      .where(and(eq(debitNotes.customerId, customerId), eq(debitNotes.status, "issued"))),
  ]);
  const [paid, notePaid] = await Promise.all([
    paidTowards(q, invoiceRows.map((r) => r.id), exceptReceiptId),
    paidTowardsDebitNotes(q, noteRows.map((r) => r.id), exceptReceiptId),
  ]);
  return [
    ...invoiceRows.map((r) => ({ ...r, target: "invoice" as const, open: r.total - (paid.get(r.id) ?? 0n) })),
    ...noteRows.map((r) => ({ ...r, target: "debit_note" as const, open: r.total - (notePaid.get(r.id) ?? 0n) })),
  ]
    .map((r) => ({ ...r, number: r.number ?? "", dueDate: r.dueDate ?? r.date }))
    .filter((r) => r.open > 0n)
    // Same date: invoices before debit notes (a note follows its invoice), then by number.
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date ? -1 : 1
        : a.target !== b.target
          ? a.target === "invoice" ? -1 : 1
          : a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
    );
}

/**
 * A customer's print jobs that can still take money (D64): new (sale) ones, active, not billed, with something open —
 * shaped like openInvoices' rows so the receipt and apply forms list them with the invoices.
 */
export async function openPrintJobs(q: Q, customerId: number, exceptReceiptId?: number) {
  const rows = await q
    .select({ id: printJobs.id, number: printJobs.number, date: printJobs.date, total: printJobs.amountPaise })
    .from(printJobs)
    .where(
      and(
        eq(printJobs.customerId, customerId),
        eq(printJobs.status, "active"),
        eq(printJobs.mode, "sale"),
        notExists(printJobBilled(printJobs.id)),
      ),
    )
    .orderBy(asc(printJobs.date), asc(printJobs.id));
  const paid = await paidTowardsPrintJobs(q, rows.map((r) => r.id), exceptReceiptId);
  return rows
    .map((r) => ({ ...r, target: "print_job" as const, dueDate: r.date, open: r.total - (paid.get(r.id) ?? 0n) }))
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

export type AllocationTarget = "invoice" | "debit_note" | "job" | "print_job";
/** One line of the allocation panel: an invoice, a debit note, a job (= an advance on it) or a print job (D64). */
export type AllocationLine = { target: AllocationTarget; id: number; amount: bigint };

/**
 * The allocation panel as typed (JSON of { target: "invoice" | "debit_note" | "job" | "print_job", id, amount }) → lines. Blank / zero amounts
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
    const target = o.target === "invoice" || o.target === "debit_note" || o.target === "job" || o.target === "print_job" ? o.target : null;
    if (!target || !Number.isSafeInteger(id) || id < 1) fail("The allocations couldn't be read: reload the page.");
    lines.push({ target: target!, id, amount });
  }
  if (new Set(lines.map((l) => `${l.target}:${l.id}`)).size !== lines.length) fail("Put each document on one line only.");
  return lines;
}

const idsOf = (lines: AllocationLine[], target: AllocationTarget) =>
  lines
    .filter((l) => l.target === target)
    .map((l) => l.id)
    .sort((a, b) => a - b);

/**
 * Checks lines against what is open, locking the target invoices, then debit notes, then jobs, then print jobs (id
 * order, as Issue does) so two receipts can't both take the same open amount. Refuses a total over `available`, a line
 * over its invoice's / debit note's / print job's open amount, a job already invoiced / cancelled, or a print job that
 * is cancelled, on a job, or billed. Returns the lines with their numbers.
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
  const [invoiceIds, noteIds, jobIds, printJobIds] = [idsOf(lines, "invoice"), idsOf(lines, "debit_note"), idsOf(lines, "job"), idsOf(lines, "print_job")];
  const invoiceRows = invoiceIds.length
    ? await tx.select().from(invoices).where(inArray(invoices.id, invoiceIds)).orderBy(asc(invoices.id)).for("update")
    : [];
  const noteRows = noteIds.length
    ? await tx.select().from(debitNotes).where(inArray(debitNotes.id, noteIds)).orderBy(asc(debitNotes.id)).for("update")
    : [];
  const jobRows = jobIds.length
    ? await tx.select().from(jobs).where(inArray(jobs.id, jobIds)).orderBy(asc(jobs.id)).for("update")
    : [];
  const printRows = printJobIds.length
    ? await tx.select().from(printJobs).where(inArray(printJobs.id, printJobIds)).orderBy(asc(printJobs.id)).for("update")
    : [];
  const billed = printJobIds.length
    ? new Set(
        (
          await tx
            .selectDistinct({ id: invoiceLines.printJobId })
            .from(invoiceLines)
            .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
            .where(and(inArray(invoiceLines.printJobId, printJobIds), ne(invoices.status, "cancelled")))
        ).map((r) => r.id),
      )
    : new Set<number | null>();
  const [paid, notePaid, printPaid] = [
    await paidTowards(tx, invoiceIds, exceptReceiptId),
    await paidTowardsDebitNotes(tx, noteIds, exceptReceiptId),
    await paidTowardsPrintJobs(tx, printJobIds, exceptReceiptId),
  ];
  return lines.map((l) => {
    if (l.target === "print_job") {
      const pj = printRows.find((p) => p.id === l.id);
      if (!pj || pj.customerId !== customerId) throw new UserError("A print job here isn't this customer's: reload the page.", "allocations");
      if (pj.status !== "active") throw new UserError(`Print job ${pj.number} is cancelled.`, "allocations");
      if (pj.mode !== "sale") throw new UserError(`Print job ${pj.number} is on a job: put the money on the job instead.`, "allocations");
      if (billed.has(pj.id)) throw new UserError(`Print job ${pj.number} is billed: allocate to its invoice instead.`, "allocations");
      const open = pj.amountPaise - (printPaid.get(pj.id) ?? 0n);
      if (l.amount > open) {
        throw new UserError(`${pj.number}: ${formatMoney(l.amount)} is more than its open ${formatMoney(open)}.`, "allocations");
      }
      return { ...l, number: pj.number };
    }
    if (l.target === "debit_note") {
      const note = noteRows.find((n) => n.id === l.id);
      if (!note || note.customerId !== customerId) throw new UserError("A debit note here isn't this customer's: reload the page.", "allocations");
      if (note.status !== "issued") throw new UserError(`Debit note ${note.number ?? `#${note.id}`} isn't issued.`, "allocations");
      const open = note.totalPaise - (notePaid.get(note.id) ?? 0n);
      if (l.amount > open) {
        throw new UserError(`${note.number}: ${formatMoney(l.amount)} is more than its open ${formatMoney(open)}.`, "allocations");
      }
      return { ...l, number: note.number! };
    }
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
 * Invoice Issue (S12, D49, D64): the billed jobs' advances and print jobs' money move to the invoice, oldest money
 * first, up to `open`. Every job / print job row is deactivated; what doesn't fit stays with its receipt (or credit
 * note, D50) on account. Returns the amount moved.
 */
export async function moveJobAdvances(tx: Tx, invoiceId: number, jobIds: number[], open: bigint, by: string, printJobIds: number[] = []) {
  if (!jobIds.length && !printJobIds.length) return 0n;
  const rows = await tx
    .select({ allocation: allocations })
    .from(allocations)
    .leftJoin(receipts, eq(receipts.id, allocations.receiptId))
    .leftJoin(creditNotes, eq(creditNotes.id, allocations.creditNoteId))
    .where(
      and(
        liveAllocation(),
        or(
          jobIds.length ? inArray(allocations.jobId, jobIds) : undefined,
          printJobIds.length ? inArray(allocations.printJobId, printJobIds) : undefined,
        ),
      ),
    )
    .orderBy(sql`coalesce(${receipts.date}, ${creditNotes.date})`, asc(allocations.id));
  let left = open;
  for (const { allocation: a } of rows) {
    const take = left <= 0n ? 0n : a.amountPaise < left ? a.amountPaise : left;
    if (take > 0n) {
      await tx.insert(allocations).values({
        receiptId: a.receiptId,
        creditNoteId: a.creditNoteId,
        invoiceId,
        fromJobId: a.jobId,
        fromPrintJobId: a.printJobId,
        amountPaise: take,
        createdBy: by,
      });
      left -= take;
    }
  }
  await deactivate(tx, rows.map((r) => r.allocation.id));
  return open - left;
}

/**
 * Invoice cancel (D49, D64): what came from a job's advance goes back to that job, a print job's money back to that
 * print job; everything else allocated to the invoice goes back on account.
 */
export async function releaseInvoice(tx: Tx, invoiceId: number, by: string) {
  const rows = await tx
    .select()
    .from(allocations)
    .where(and(eq(allocations.invoiceId, invoiceId), eq(allocations.active, true)))
    .orderBy(asc(allocations.id));
  for (const a of rows) {
    if (a.fromJobId !== null || a.fromPrintJobId !== null) {
      await tx.insert(allocations).values({
        receiptId: a.receiptId,
        creditNoteId: a.creditNoteId,
        jobId: a.fromJobId,
        printJobId: a.fromPrintJobId,
        amountPaise: a.amountPaise,
        createdBy: by,
      });
    }
  }
  await deactivate(tx, rows.map((a) => a.id));
}

/** What an invoice shows as "Advance adjusted" (S5): job advances / print job money moved onto it at Issue, still in force. */
export async function advanceAdjusted(q: Q, invoiceId: number): Promise<bigint> {
  const [row] = await q
    .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(and(liveAllocation(), eq(allocations.invoiceId, invoiceId), or(isNotNull(allocations.fromJobId), isNotNull(allocations.fromPrintJobId))));
  return BigInt(row.paise);
}

/** Credit note Issue (D49): it pays its own invoice up to the open amount; any excess stays as customer credit. */
export async function allocateCreditNote(tx: Tx, noteId: number, invoiceId: number, total: bigint, by: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  const open = inv.totalPaise - ((await paidTowards(tx, [invoiceId])).get(invoiceId) ?? 0n);
  const amount = total < open ? total : open;
  if (amount > 0n) await tx.insert(allocations).values({ creditNoteId: noteId, invoiceId, amountPaise: amount, createdBy: by });
  return amount;
}

export type OnAccountSource = { kind: "receipt" | "credit_note"; id: number };

/**
 * What a customer has on account (D50): live receipts with an unallocated rest and issued credit notes with leftover
 * credit, oldest first. `rest` = amount − its active allocations.
 */
export async function onAccountSources(q: Q, customerId: number) {
  // The subqueries name the outer row in full: drizzle leaves columns unqualified in a one-table select.
  const [rs, cs] = await Promise.all([
    q
      .select({
        id: receipts.id,
        number: receipts.number,
        date: receipts.date,
        amount: receipts.amountPaise,
        used: sql<string>`coalesce((select sum(a.amount_paise) from allocations a where a.receipt_id = "receipts"."id" and a.active), 0)`,
      })
      .from(receipts)
      .where(and(eq(receipts.customerId, customerId), eq(receipts.status, "active"))),
    q
      .select({
        id: creditNotes.id,
        number: creditNotes.number,
        date: creditNotes.date,
        amount: creditNotes.totalPaise,
        used: sql<string>`coalesce((select sum(a.amount_paise) from allocations a where a.credit_note_id = "credit_notes"."id" and a.active), 0)`,
      })
      .from(creditNotes)
      .where(and(eq(creditNotes.customerId, customerId), eq(creditNotes.status, "issued"))),
  ]);
  return [
    ...rs.map((r) => ({ kind: "receipt" as const, id: r.id, number: r.number, date: r.date, rest: r.amount - BigInt(r.used) })),
    ...cs.map((c) => ({ kind: "credit_note" as const, id: c.id, number: c.number ?? "", date: c.date, rest: c.amount - BigInt(c.used) })),
  ]
    .filter((s) => s.rest > 0n)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.number < b.number ? -1 : 1));
}

/** The source row, locked (two applies / refunds of the same money queue), and what it still has on account. */
export async function lockSource(tx: Tx, customerId: number, source: OnAccountSource) {
  const found =
    source.kind === "receipt"
      ? (await tx.select().from(receipts).where(eq(receipts.id, source.id)).for("update")).map((r) => ({
          number: r.number,
          customerId: r.customerId,
          live: r.status === "active",
          amount: r.amountPaise,
        }))
      : (await tx.select().from(creditNotes).where(eq(creditNotes.id, source.id)).for("update")).map((c) => ({
          number: c.number ?? "",
          customerId: c.customerId,
          live: c.status === "issued",
          amount: c.totalPaise,
        }));
  const s = found[0];
  if (!s || s.customerId !== customerId) throw new UserError("That receipt or credit note isn't this customer's: reload the page.");
  if (!s.live) throw new UserError(`${s.number} is cancelled.`);
  const column = source.kind === "receipt" ? allocations.receiptId : allocations.creditNoteId;
  const [used] = await tx
    .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(and(eq(column, source.id), eq(allocations.active, true)));
  return { ...s, rest: s.amount - BigInt(used.paise) };
}

/**
 * D50: puts a receipt's unallocated rest or a credit note's leftover credit on open invoices, debit notes, jobs or print jobs.
 * Only adds (free for owner / accountant); changing existing allocations stays a receipt edit. An amount on a target
 * the source already pays merges into that row (deactivated + a new row, D49), so each target keeps one line.
 */
export async function applyOnAccount(actor: SessionUser, customerId: number, source: OnAccountSource, json: string) {
  if (!can(actor, "payments", "create")) throw new Error("Not allowed");
  const lines = readAllocations(json);
  if (!lines.length) throw new UserError("Enter an amount on at least one line.", "allocations");
  return writeTx(actor, async (tx) => {
    const s = await lockSource(tx, customerId, source);
    const total = lines.reduce((sum, l) => sum + l.amount, 0n);
    if (total > s.rest) {
      throw new UserError(`${formatMoney(total)} is more than the ${formatMoney(s.rest)} ${s.number} has on account.`, "allocations");
    }
    const checked = await checkAllocations(tx, customerId, s.rest, lines);
    const own = await tx
      .select()
      .from(allocations)
      .where(and(eq(source.kind === "receipt" ? allocations.receiptId : allocations.creditNoteId, source.id), eq(allocations.active, true)));
    for (const l of checked) {
      const target = (a: typeof allocations.$inferSelect) =>
        l.target === "invoice" ? a.invoiceId : l.target === "debit_note" ? a.debitNoteId : l.target === "job" ? a.jobId : a.printJobId;
      const same = own.find((a) => target(a) === l.id && a.fromJobId === null && a.fromPrintJobId === null);
      if (same) await deactivate(tx, [same.id]);
      await tx.insert(allocations).values({
        receiptId: source.kind === "receipt" ? source.id : null,
        creditNoteId: source.kind === "credit_note" ? source.id : null,
        invoiceId: l.target === "invoice" ? l.id : null,
        debitNoteId: l.target === "debit_note" ? l.id : null,
        jobId: l.target === "job" ? l.id : null,
        printJobId: l.target === "print_job" ? l.id : null,
        amountPaise: l.amount + (same?.amountPaise ?? 0n),
        createdBy: actor.id,
      });
    }
    return { message: `Applied ${formatMoney(total)} from ${s.number}.` };
  });
}

/**
 * The live write-off / discount JV (D55) settling part of this invoice or debit note, or null. It must be cancelled
 * first: its allocation would otherwise outlive what it settles.
 */
export async function adjustmentOn(q: Q, target: { invoiceId: number } | { debitNoteId: number }): Promise<string | null> {
  const [row] = await q
    .select({ number: adjustments.number })
    .from(allocations)
    .innerJoin(adjustments, eq(adjustments.id, allocations.adjustmentId))
    .where(
      and(
        eq(allocations.active, true),
        "invoiceId" in target ? eq(allocations.invoiceId, target.invoiceId) : eq(allocations.debitNoteId, target.debitNoteId),
      ),
    )
    .limit(1);
  return row?.number ?? null;
}

/** The live refund JV (D55) that paid back part of this receipt / credit note, or null. It must be cancelled first. */
export async function refundOf(q: Q, source: OnAccountSource): Promise<string | null> {
  const [row] = await q
    .select({ number: adjustments.number })
    .from(allocations)
    .innerJoin(adjustments, eq(adjustments.id, allocations.refundAdjustmentId))
    .where(
      and(
        eq(allocations.active, true),
        source.kind === "receipt" ? eq(allocations.receiptId, source.id) : eq(allocations.creditNoteId, source.id),
      ),
    )
    .limit(1);
  return row?.number ?? null;
}

/** A cancelled credit note stops paying; a cancelled debit note's receipts go back on account (like an invoice, D49). */
export async function releaseNote(tx: Tx, kind: "credit" | "debit", noteId: number) {
  const rows = await tx
    .select({ id: allocations.id })
    .from(allocations)
    .where(and(eq(kind === "credit" ? allocations.creditNoteId : allocations.debitNoteId, noteId), eq(allocations.active, true)));
  await deactivate(tx, rows.map((r) => r.id));
}
