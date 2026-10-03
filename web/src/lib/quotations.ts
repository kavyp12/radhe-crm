import { asc, desc, eq } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import { customers, productCategories, quotationLines, quotations, type QUOTATION_STATUSES } from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { registerExecutor, runOrRequest } from "@/lib/approvals";
import { todayIST } from "@/lib/dates";
import { creditWarning } from "@/lib/invoices";
import { liveJobFor } from "@/lib/jobs";
import { checkBooksDate } from "@/lib/ledger";
import { gstMode, lineTotals } from "@/lib/lines";
import { formatMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { dateIn, type Range } from "@/lib/statements";
import {
  approvalReasons,
  checkVersion,
  companyState,
  customerFor,
  lineRow,
  newShareToken,
  quotationInvoice,
  readDate,
  readLines,
  type SavedLine,
} from "@/lib/sales";

// Quotations (S2, A§2, A§6, A§7). Statuses are enforced here, on the server: Draft → Sent → Approved; Draft / Sent /
// Approved → Cancelled. Only Draft and Sent can be edited; editing a Sent one takes it back to Draft. Sending (leaving
// Draft) is where the discount and backdate approvals apply (D44).

export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QUOTATION_STATUS: Record<QuotationStatus, Status> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  cancelled: "Cancelled",
};

/** The form as typed; lines = JSON of lib/lines.ts LineText[]. */
export type QuotationInput = { customerId: string; date: string; terms: string; notes: string; lines: string };

async function values(tx: Tx, input: QuotationInput, isNew: boolean) {
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const customer = await customerFor(tx, input.customerId, isNew);
  const lines = await readLines(tx, input.lines);
  const placeOfSupply = customer.stateCode;
  const { total } = lineTotals(lines, gstMode(placeOfSupply, await companyState(tx)));
  const header = {
    date,
    customerId: customer.id,
    placeOfSupply,
    totalPaise: total,
    terms: formText(input.terms, "terms", 4000),
    notes: formText(input.notes, "notes", 2000),
  };
  return { header, lines };
}

const insertLines = (tx: Tx, quotationId: number, lines: Omit<SavedLine, "lineId">[]) =>
  tx.insert(quotationLines).values(lines.map((l, i) => ({ quotationId, ...lineRow(l, i) })));

const linesOf = (q: Tx | typeof db, id: number) =>
  q.select().from(quotationLines).where(eq(quotationLines.quotationId, id)).orderBy(asc(quotationLines.position));

async function lock(tx: Tx, id: number) {
  const [q] = await tx.select().from(quotations).where(eq(quotations.id, id)).for("update");
  if (!q) throw new UserError("That quotation doesn't exist.");
  return q;
}

/** Saves a new draft; it gets its number now (A§6). */
export async function createQuotation(actor: SessionUser, input: QuotationInput): Promise<number> {
  if (!can(actor, "quotations", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const { header, lines } = await values(tx, input, true);
    const number = await nextNumber(tx, "quotation", header.date);
    const [row] = await tx
      .insert(quotations)
      .values({ ...header, number, shareToken: newShareToken(), createdBy: actor.id })
      .returning({ id: quotations.id });
    await insertLines(tx, row.id, lines);
    return row.id;
  });
}

export async function updateQuotation(actor: SessionUser, id: number, input: QuotationInput): Promise<void> {
  if (!can(actor, "quotations", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const q = await lock(tx, id);
    if (q.status !== "draft" && q.status !== "sent") {
      throw new UserError(`An ${QUOTATION_STATUS[q.status].toLowerCase()} quotation can't be edited.`);
    }
    const { header, lines } = await values(tx, input, false);
    await tx.update(quotations).set({ ...header, status: "draft" }).where(eq(quotations.id, id));
    // ponytail: a draft's lines are replaced on save (the audit log keeps the old rows); sent-on documents never are.
    await tx.delete(quotationLines).where(eq(quotationLines.quotationId, id));
    await insertLines(tx, id, lines);
  });
}

type SendPayload = { id: number; version: string };

async function markSent(tx: Tx, p: SendPayload) {
  const q = await lock(tx, p.id);
  if (q.status !== "draft") throw new UserError("Only a draft quotation can be sent.");
  checkVersion(q, p.version, "quotation");
  await tx.update(quotations).set({ status: "sent" }).where(eq(quotations.id, p.id));
}

registerExecutor<SendPayload>("quotation.send", {
  async describe(tx, p) {
    const [q] = await tx
      .select({ quotation: quotations, customer: customers.name })
      .from(quotations)
      .innerJoin(customers, eq(customers.id, quotations.customerId))
      .where(eq(quotations.id, p.id));
    if (!q) throw new UserError("That quotation doesn't exist.");
    if (q.quotation.status !== "draft") throw new UserError("Only a draft quotation can be sent.");
    checkVersion(q.quotation, p.version, "quotation");
    const reasons = await approvalReasons(await linesOf(tx, p.id), q.quotation.date);
    return {
      summary: `Send quotation ${q.quotation.number} to ${q.customer}`,
      target: { type: "quotations", id: p.id },
      changes: [
        { label: "Status", old: "Draft", new: "Sent" },
        { label: "Total", old: null, new: formatMoney(q.quotation.totalPaise) },
        ...reasons.map((r) => ({ label: "Needs approval", old: null, new: r })),
      ],
    };
  },
  run: (tx, _owner, p) => markSent(tx, p),
});

/**
 * Draft → Sent. By anyone but the owner, a discount over the limit or a date before the backdate window makes it an
 * approval request instead (A§7, D44).
 */
export async function sendQuotation(actor: SessionUser, id: number): Promise<{ message: string }> {
  if (!can(actor, "quotations", "edit")) throw new Error("Not allowed");
  const [q] = await db.select().from(quotations).where(eq(quotations.id, id));
  if (!q) throw new UserError("That quotation doesn't exist.");
  if (q.status !== "draft") throw new UserError("Only a draft quotation can be sent.");
  const payload: SendPayload = { id, version: q.updatedAt.toISOString() };
  const reasons = await approvalReasons(await linesOf(db, id), q.date);
  if (reasons.length) {
    const outcome = await runOrRequest(actor, "quotation.send", payload, reasons.join(" · "));
    if (!outcome.done) return { message: outcome.message };
  } else {
    await writeTx(actor, (tx) => markSent(tx, payload));
  }
  // Warn, never block (S25), like invoice Issue.
  return { message: ["Marked as sent.", await creditWarning(q.customerId, q.totalPaise)].filter(Boolean).join(" ") };
}

/** Sent → Approved: the customer said yes. */
export async function approveQuotation(actor: SessionUser, id: number): Promise<void> {
  if (!can(actor, "quotations", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const q = await lock(tx, id);
    if (q.status !== "sent") throw new UserError("Only a sent quotation can be marked approved.");
    await tx.update(quotations).set({ status: "approved" }).where(eq(quotations.id, id));
  });
}

export async function cancelQuotation(actor: SessionUser, id: number): Promise<void> {
  if (!can(actor, "quotations", "cancel")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const q = await lock(tx, id);
    if (q.status === "cancelled") throw new UserError("This quotation is already cancelled.");
    const job = await liveJobFor(tx, id);
    if (job) throw new UserError(`Job ${job.number} was made from this quotation: cancel the job first.`);
    const invoice = await quotationInvoice(tx, id);
    if (invoice) throw new UserError(`It is on invoice ${invoice.number ?? "(draft)"}: cancel that first.`);
    await tx.update(quotations).set({ status: "cancelled" }).where(eq(quotations.id, id));
  });
}

/** A new draft with the same customer, lines and terms, dated today. */
export async function duplicateQuotation(actor: SessionUser, id: number): Promise<number> {
  if (!can(actor, "quotations", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const [q] = await tx.select().from(quotations).where(eq(quotations.id, id));
    if (!q) throw new UserError("That quotation doesn't exist.");
    const customer = await customerFor(tx, String(q.customerId), true);
    const date = todayIST();
    const lines = await linesOf(tx, id);
    const placeOfSupply = customer.stateCode;
    const { total } = lineTotals(lines, gstMode(placeOfSupply, await companyState(tx)));
    const [row] = await tx
      .insert(quotations)
      .values({
        number: await nextNumber(tx, "quotation", date),
        date,
        customerId: q.customerId,
        placeOfSupply,
        totalPaise: total,
        terms: q.terms,
        notes: q.notes,
        shareToken: newShareToken(),
        createdBy: actor.id,
      })
      .returning({ id: quotations.id });
    await insertLines(tx, row.id, lines);
    return row.id;
  });
}

/** The quotations list; `range` (D68) = those dated in it, else all. */
export const listQuotations = (range?: Range) =>
  db
    .select({
      id: quotations.id,
      number: quotations.number,
      date: quotations.date,
      status: quotations.status,
      total: quotations.totalPaise,
      customer: customers.name,
      firmName: customers.firmName,
    })
    .from(quotations)
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(dateIn(quotations.date, range))
    .orderBy(desc(quotations.id));

/** A document's lines with their category names, in order. */
export const quotationLinesOf = (id: number) =>
  db
    .select({ line: quotationLines, category: productCategories.name })
    .from(quotationLines)
    .innerJoin(productCategories, eq(productCategories.id, quotationLines.categoryId))
    .where(eq(quotationLines.quotationId, id))
    .orderBy(asc(quotationLines.position))
    .then((rows) => rows.map((r) => ({ ...r.line, category: r.category })));

/** The quotation with its customer, lines and totals, or undefined. */
export async function getQuotation(id: number) {
  const [row] = await db
    .select({ quotation: quotations, customer: customers })
    .from(quotations)
    .innerJoin(customers, eq(customers.id, quotations.customerId))
    .where(eq(quotations.id, id));
  if (!row) return undefined;
  const lines = await quotationLinesOf(id);
  const mode = gstMode(row.quotation.placeOfSupply, await companyState(db));
  return { ...row.quotation, customer: row.customer, lines, mode, totals: lineTotals(lines, mode) };
}
