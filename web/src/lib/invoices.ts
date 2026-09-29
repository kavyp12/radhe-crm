import { and, asc, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import {
  creditNotes,
  customers,
  debitNotes,
  invoiceLines,
  invoices,
  jobLines,
  jobs,
  jobStatusHistory,
  journalEntries,
  journalLines,
  productCategories,
  quotationLines,
  quotations,
  settings,
  type INVOICE_KINDS,
  type INVOICE_STATUSES,
} from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { advanceAdjusted, moveJobAdvances, paidByInvoice, paidTowards, paymentStatus, releaseInvoice } from "@/lib/allocations";
import { registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, todayIST } from "@/lib/dates";
import { JOB_STATUS, liveJobFor, PRODUCTION_STATUSES } from "@/lib/jobs";
import { checkBooksDate, post, reverse, systemAccountId, type PostLine } from "@/lib/ledger";
import { gstMode, lineTotals } from "@/lib/lines";
import { formatMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import {
  approvalReasons,
  checkVersion,
  companyState,
  customerFor,
  dueDateFor,
  jobsOnInvoices,
  lineRow,
  newShareToken,
  quotationInvoice,
  readDate,
  readLines,
  type SavedLine,
} from "@/lib/sales";

// Invoices (S5, A§2–§7): tax invoices and estimates. Drafts may hold anything (D44); Issue gives the number, posts
// the A§3 entry in the same transaction and marks the jobs Invoiced; after that the invoice is frozen. Cancel reverses
// the entry on the invoice's own date (D45), keeps the number and puts the jobs back. Payment status is computed from
// allocations (lib/allocations.ts), never stored.

export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_KIND: Record<InvoiceKind, string> = { tax: "Tax Invoice", estimate: "Estimate" };
export const INVOICE_STATUS: Record<InvoiceStatus, Status> = { draft: "Draft", issued: "Issued", cancelled: "Cancelled" };

/** The form as typed; lines = JSON of lib/lines.ts LineText[]. */
export type InvoiceInput = { kind: string; customerId: string; date: string; terms: string; notes: string; lines: string };

type Linked = Omit<SavedLine, "lineId"> & { jobId?: number | null; quotationLineId?: number | null };

function readKind(value: string): InvoiceKind {
  if (value === "tax" || value === "estimate") return value;
  throw new UserError("Pick Tax Invoice or Estimate.", "kind");
}

async function figures(tx: Tx, kind: InvoiceKind, placeOfSupply: string, lines: Linked[]) {
  const mode = gstMode(placeOfSupply, await companyState(tx), kind === "estimate");
  return { mode, totals: lineTotals(lines, mode) };
}

const insertLines = (tx: Tx, invoiceId: number, lines: Linked[]) =>
  tx.insert(invoiceLines).values(
    lines.map((l, i) => ({
      invoiceId,
      ...lineRow(l, i),
      jobId: l.jobId ?? null,
      quotationLineId: l.quotationLineId ?? null,
    })),
  );

type Party = { id: number; stateCode: string; creditDays: number | null };

async function newDraft(
  tx: Tx,
  actor: SessionUser,
  d: { kind: InvoiceKind; customer: Party; date: string; terms: string | null; notes: string | null; lines: Linked[] },
) {
  await checkBooksDate(tx, d.date);
  const { totals } = await figures(tx, d.kind, d.customer.stateCode, d.lines);
  const [row] = await tx
    .insert(invoices)
    .values({
      kind: d.kind,
      date: d.date,
      customerId: d.customer.id,
      placeOfSupply: d.customer.stateCode,
      dueDate: await dueDateFor(tx, d.date, d.customer.creditDays),
      totalPaise: totals.total,
      roundOffPaise: totals.roundOff,
      terms: d.terms,
      notes: d.notes,
      shareToken: newShareToken(),
      createdBy: actor.id,
    })
    .returning({ id: invoices.id });
  await insertLines(tx, row.id, d.lines);
  return row.id;
}

const defaultTerms = async (tx: Tx) =>
  (await tx.select({ terms: settings.invoiceTerms }).from(settings).where(eq(settings.id, 1)))[0].terms;

/** A blank draft. */
export async function createInvoice(actor: SessionUser, input: InvoiceInput): Promise<number> {
  if (!can(actor, "invoices", "create")) throw new Error("Not allowed");
  const kind = readKind(input.kind);
  return writeTx(actor, async (tx) => {
    const customer = await customerFor(tx, input.customerId, true);
    const date = readDate(input.date);
    const lines = await readLines(tx, input.lines);
    const terms = formText(input.terms, "terms", 4000);
    return newDraft(tx, actor, { kind, customer, date, terms, notes: formText(input.notes, "notes", 2000), lines });
  });
}

/** A draft billing one or more of a customer's jobs: every job line copied (R0), linked to its job. */
export async function createInvoiceFromJobs(actor: SessionUser, jobIds: number[], kindInput: string): Promise<number> {
  if (!can(actor, "invoices", "create")) throw new Error("Not allowed");
  const kind = readKind(kindInput);
  const ids = [...new Set(jobIds)];
  if (!ids.length) throw new UserError("Pick at least one job.");
  return writeTx(actor, async (tx) => {
    const rows = await tx.select().from(jobs).where(inArray(jobs.id, ids)).orderBy(asc(jobs.id)).for("update");
    if (rows.length !== ids.length) throw new UserError("A job wasn't found.");
    if (new Set(rows.map((j) => j.customerId)).size > 1) throw new UserError("Pick jobs of one customer.");
    for (const job of rows) {
      if (job.status === "cancelled" || job.status === "invoiced") {
        throw new UserError(`Job ${job.number} is ${JOB_STATUS[job.status].toLowerCase()}.`);
      }
    }
    const [taken] = await jobsOnInvoices(tx, ids);
    if (taken) {
      const job = rows.find((j) => j.id === taken.jobId)!;
      throw new UserError(`Job ${job.number} is already on invoice ${taken.number ?? `#${taken.invoiceId} (draft)`}.`);
    }
    const customer = await customerFor(tx, String(rows[0].customerId), false);
    const lines = await tx
      .select()
      .from(jobLines)
      .where(inArray(jobLines.jobId, ids))
      .orderBy(asc(jobLines.jobId), asc(jobLines.position));
    return newDraft(tx, actor, { kind, customer, date: todayIST(), terms: await defaultTerms(tx), notes: null, lines });
  });
}

/** A draft from an approved quotation that has no job (small jobs billed straight from the quote). */
export async function createInvoiceFromQuotation(actor: SessionUser, quotationId: number, kindInput: string) {
  if (!can(actor, "invoices", "create")) throw new Error("Not allowed");
  const kind = readKind(kindInput);
  return writeTx(actor, async (tx) => {
    const [q] = await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update");
    if (!q) throw new UserError("That quotation doesn't exist.");
    if (q.status !== "approved") throw new UserError("Only an approved quotation can be invoiced.");
    const job = await liveJobFor(tx, quotationId);
    if (job) throw new UserError(`It has job ${job.number}: invoice the job instead.`);
    const on = await quotationInvoice(tx, quotationId);
    if (on) throw new UserError(`It is already on invoice ${on.number ?? `#${on.id} (draft)`}.`);
    const customer = await customerFor(tx, String(q.customerId), false);
    const rows = await tx
      .select()
      .from(quotationLines)
      .where(eq(quotationLines.quotationId, quotationId))
      .orderBy(asc(quotationLines.position));
    const lines = rows.map((l) => ({ ...l, quotationLineId: l.id }));
    return newDraft(tx, actor, { kind, customer, date: todayIST(), terms: await defaultTerms(tx), notes: null, lines });
  });
}

async function lock(tx: Tx, id: number) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new UserError("That invoice doesn't exist.");
  return inv;
}

const linesOf = (q: Tx | typeof db, id: number) =>
  q.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.position));

/** Drafts only; lines keep their job / quotation links by lineId. With linked lines the customer stays. */
export async function updateInvoice(actor: SessionUser, id: number, input: InvoiceInput): Promise<void> {
  if (!can(actor, "invoices", "edit")) throw new Error("Not allowed");
  const kind = readKind(input.kind);
  await writeTx(actor, async (tx) => {
    const inv = await lock(tx, id);
    if (inv.status !== "draft") {
      throw new UserError("An issued invoice can't be edited. Cancel it, or use a credit note after the GST return.");
    }
    const old = await linesOf(tx, id);
    const linked = old.some((l) => l.jobId !== null || l.quotationLineId !== null);
    const customerId = linked ? String(inv.customerId) : input.customerId;
    const customer = await customerFor(tx, customerId, Number(customerId) !== inv.customerId);
    const date = readDate(input.date);
    await checkBooksDate(tx, date);
    const lines = (await readLines(tx, input.lines)).map((l) => {
      const from = old.find((o) => o.id === l.lineId);
      return { ...l, jobId: from?.jobId ?? null, quotationLineId: from?.quotationLineId ?? null };
    });
    const { totals } = await figures(tx, kind, customer.stateCode, lines);
    await tx
      .update(invoices)
      .set({
        kind,
        date,
        customerId: customer.id,
        placeOfSupply: customer.stateCode,
        dueDate: await dueDateFor(tx, date, customer.creditDays),
        totalPaise: totals.total,
        roundOffPaise: totals.roundOff,
        terms: formText(input.terms, "terms", 4000),
        notes: formText(input.notes, "notes", 2000),
      })
      .where(eq(invoices.id, id));
    // ponytail: a draft's lines are replaced on save (the audit log keeps the old rows); issued ones never are.
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    await insertLines(tx, id, lines);
  });
}

/** A§3: Dr ar = grand total; Cr sales (taxable, per job), output GST, round-off (±). Estimates: no GST (D18). */
function postingLines(customerId: number, lines: { jobId: number | null }[], t: ReturnType<typeof lineTotals>): PostLine[] {
  const side = (amount: bigint) => (amount >= 0n ? { credit: amount } : { debit: -amount });
  const sales = new Map<number | null, bigint>();
  lines.forEach((l, i) => sales.set(l.jobId, (sales.get(l.jobId) ?? 0n) + t.lines[i].taxable));
  return [
    { account: "ar", customerId, debit: t.total },
    ...[...sales].map(([jobId, taxable]): PostLine => ({ account: "sales", jobId: jobId ?? undefined, ...side(taxable) })),
    { account: "gst_out_cgst", ...side(t.cgst) },
    { account: "gst_out_sgst", ...side(t.sgst) },
    { account: "gst_out_igst", ...side(t.igst) },
    { account: "round_off", ...side(t.roundOff) },
  ];
}

type IssuePayload = { id: number; version: string };

/**
 * Draft → Issued in one transaction: number, journal entry, frozen, jobs Invoiced, and their advances moved onto it
 * (S12, D49). Returns the number.
 */
async function doIssue(tx: Tx, p: IssuePayload, by: SessionUser): Promise<string> {
  const inv = await lock(tx, p.id);
  if (inv.status !== "draft") throw new UserError("Only a draft invoice can be issued.");
  checkVersion(inv, p.version, "invoice");
  const lines = await linesOf(tx, inv.id);
  if (!lines.length) throw new UserError("Add at least one line.");
  const customer = await customerFor(tx, String(inv.customerId), false);

  // The jobs may have moved since the draft was made.
  const jobIds = [...new Set(lines.flatMap((l) => (l.jobId === null ? [] : [l.jobId])))];
  const billed = jobIds.length ? await tx.select().from(jobs).where(inArray(jobs.id, jobIds)).for("update") : [];
  for (const job of billed) {
    if (job.customerId !== inv.customerId) throw new UserError(`Job ${job.number} is another customer's.`);
    if (job.status === "cancelled" || job.status === "invoiced") {
      throw new UserError(`Job ${job.number} is ${JOB_STATUS[job.status].toLowerCase()}: take its lines off.`);
    }
  }
  const [elsewhere] = await jobsOnInvoices(tx, jobIds, inv.id);
  if (elsewhere) throw new UserError(`A job here is also on invoice ${elsewhere.number ?? `#${elsewhere.invoiceId}`}.`);

  const { totals } = await figures(tx, inv.kind, inv.placeOfSupply, lines);
  if (totals.total <= 0n) throw new UserError("The total must be more than zero.");
  const number = await nextNumber(tx, inv.kind === "tax" ? "tax_invoice" : "estimate", inv.date);
  await post(tx, {
    date: inv.date,
    docType: "invoices",
    docId: inv.id,
    number,
    narration: `${INVOICE_KIND[inv.kind]} ${number} · ${customer.name}`,
    lines: postingLines(inv.customerId, lines, totals),
  });
  await tx
    .update(invoices)
    .set({
      number,
      status: "issued",
      totalPaise: totals.total,
      roundOffPaise: totals.roundOff,
      dueDate: await dueDateFor(tx, inv.date, customer.creditDays),
    })
    .where(eq(invoices.id, inv.id));
  for (const job of billed) {
    await tx.update(jobs).set({ status: "invoiced" }).where(eq(jobs.id, job.id));
    await tx.insert(jobStatusHistory).values({ jobId: job.id, fromStatus: job.status, toStatus: "invoiced" });
  }
  await moveJobAdvances(tx, inv.id, jobIds, totals.total, by.id);
  return number;
}

async function describeInvoice(tx: Tx, id: number) {
  const [row] = await tx
    .select({ invoice: invoices, customer: customers.name })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, id));
  if (!row) throw new UserError("That invoice doesn't exist.");
  return row;
}

registerExecutor<IssuePayload>("invoice.issue", {
  async describe(tx, p) {
    const { invoice: inv, customer } = await describeInvoice(tx, p.id);
    if (inv.status !== "draft") throw new UserError("Only a draft invoice can be issued.");
    checkVersion(inv, p.version, "invoice");
    const reasons = await approvalReasons(await linesOf(tx, p.id), inv.date);
    return {
      summary: `Issue ${INVOICE_KIND[inv.kind].toLowerCase()} to ${customer} (${formatMoney(inv.totalPaise)})`,
      target: { type: "invoices", id: p.id },
      changes: [
        { label: "Status", old: "Draft", new: "Issued (numbered and posted)" },
        { label: "Date", old: null, new: formatDate(inv.date) },
        { label: "Total", old: null, new: formatMoney(inv.totalPaise) },
        ...reasons.map((r) => ({ label: "Needs approval", old: null, new: r })),
      ],
    };
  },
  run: (tx, owner, p) => doIssue(tx, p, owner),
});

/** AR balance + this amount over the customer's credit limit → a warning (never a block). */
export async function creditWarning(customerId: number, amount: bigint): Promise<string | null> {
  const [c] = await db.select({ limit: customers.creditLimitPaise }).from(customers).where(eq(customers.id, customerId));
  if (!c || c.limit === null) return null;
  const ar = await systemAccountId("ar");
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
    .from(journalLines)
    .where(and(eq(journalLines.accountId, ar), eq(journalLines.customerId, customerId)));
  const after = BigInt(row.balance) + amount;
  if (after <= c.limit) return null;
  return `Over the credit limit: ${formatMoney(BigInt(row.balance))} due + ${formatMoney(amount)} = ${formatMoney(after)}, limit ${formatMoney(c.limit)}.`;
}

/**
 * Issue. By anyone but the owner, a discount over the limit or a date before the backdate window becomes an approval
 * request and nothing posts (A§7, D44). The message carries the credit-limit warning, if any.
 */
export async function issueInvoice(actor: SessionUser, id: number): Promise<{ message: string }> {
  if (!can(actor, "invoices", "edit")) throw new Error("Not allowed");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) throw new UserError("That invoice doesn't exist.");
  if (inv.status !== "draft") throw new UserError("Only a draft invoice can be issued.");
  const payload: IssuePayload = { id, version: inv.updatedAt.toISOString() };
  const reasons = await approvalReasons(await linesOf(db, id), inv.date);
  const warning = await creditWarning(inv.customerId, inv.totalPaise);
  let number: string;
  if (reasons.length) {
    const outcome = await runOrRequest(actor, "invoice.issue", payload, reasons.join(" · "));
    if (!outcome.done) return { message: outcome.message };
    number = outcome.result as string;
  } else {
    number = await writeTx(actor, (tx) => doIssue(tx, payload, actor));
  }
  return { message: [`Issued ${number}.`, warning].filter(Boolean).join(" ") };
}

type CancelPayload = { id: number };

/** A credit / debit note in force against the invoice, if any: it must be cancelled first (T16). */
async function liveNoteOn(q: Tx | typeof db, invoiceId: number): Promise<string | null> {
  for (const t of [creditNotes, debitNotes]) {
    const [note] = await q
      .select({ number: t.number })
      .from(t)
      .where(and(eq(t.invoiceId, invoiceId), eq(t.status, "issued")))
      .limit(1);
    if (note) return note.number;
  }
  return null;
}

/** Issued → Cancelled: reverse the entry on the invoice's own date (D45), keep the number, jobs and advances back. */
async function doCancelIssued(tx: Tx, p: CancelPayload, by: SessionUser) {
  const inv = await lock(tx, p.id);
  if (inv.status !== "issued") throw new UserError("Only an issued invoice can be cancelled this way.");
  const note = await liveNoteOn(tx, inv.id);
  if (note) throw new UserError(`Cancel ${note} first: it is against this invoice.`);
  const [entry] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(eq(journalEntries.docType, "invoices"), eq(journalEntries.docId, inv.id), isNull(journalEntries.reversesEntryId)),
    );
  if (!entry) throw new Error(`Issued invoice ${inv.id} has no journal entry`);
  await reverse(tx, entry.id, inv.date);
  await tx.update(invoices).set({ status: "cancelled" }).where(eq(invoices.id, inv.id));
  // A job's advance goes back to the job, any other money allocated to it back on account (D49).
  await releaseInvoice(tx, inv.id, by.id);

  // Each job goes back to the status it had when this invoice was issued.
  const jobIds = [...new Set((await linesOf(tx, inv.id)).flatMap((l) => (l.jobId === null ? [] : [l.jobId])))];
  for (const jobId of jobIds) {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (job.status !== "invoiced") continue;
    const [last] = await tx
      .select({ from: jobStatusHistory.fromStatus })
      .from(jobStatusHistory)
      .where(and(eq(jobStatusHistory.jobId, jobId), eq(jobStatusHistory.toStatus, "invoiced")))
      .orderBy(desc(jobStatusHistory.id))
      .limit(1);
    const back = PRODUCTION_STATUSES.find((s) => s === last?.from) ?? "delivered";
    await tx.update(jobs).set({ status: back }).where(eq(jobs.id, jobId));
    await tx.insert(jobStatusHistory).values({ jobId, fromStatus: "invoiced", toStatus: back });
  }
}

registerExecutor<CancelPayload>("invoice.cancel", {
  async describe(tx, p) {
    const { invoice: inv, customer } = await describeInvoice(tx, p.id);
    if (inv.status !== "issued") throw new UserError("Only an issued invoice can be cancelled this way.");
    const note = await liveNoteOn(tx, inv.id);
    if (note) throw new UserError(`Cancel ${note} first: it is against this invoice.`);
    return {
      summary: `Cancel ${INVOICE_KIND[inv.kind].toLowerCase()} ${inv.number} (${customer}, ${formatMoney(inv.totalPaise)})`,
      target: { type: "invoices", id: p.id },
      changes: [
        { label: "Status", old: "Issued", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(inv.date)}` },
        { label: "Payments", old: null, new: "Job advances go back to their jobs, other payments on account" },
      ],
    };
  },
  run: (tx, owner, p) => doCancelIssued(tx, p, owner),
});

/**
 * A draft is simply cancelled. An issued one: the owner cancels at once; anyone else files a request (A§7). After
 * that month's GST return is filed, use a credit note instead (D45, T16).
 */
export async function cancelInvoice(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "invoices", "cancel")) throw new Error("Not allowed");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) throw new UserError("That invoice doesn't exist.");
  if (inv.status === "cancelled") throw new UserError("This invoice is already cancelled.");
  if (inv.status === "draft") {
    await writeTx(actor, async (tx) => {
      const draft = await lock(tx, id);
      if (draft.status !== "draft") throw new UserError("It was issued meanwhile: reload the page.");
      await tx.update(invoices).set({ status: "cancelled" }).where(eq(invoices.id, id));
    });
    return { message: "Draft cancelled." };
  }
  const outcome = await runOrRequest(actor, "invoice.cancel", { id } satisfies CancelPayload, reason);
  return { message: outcome.done ? `Cancelled ${inv.number}; its entry is reversed.` : outcome.message };
}

// ---- Loaders

/** Every invoice with its open amount and computed payment status (A§5). */
export async function listInvoices() {
  const paid = paidByInvoice();
  const rows = await db
    .select({
      id: invoices.id,
      kind: invoices.kind,
      number: invoices.number,
      date: invoices.date,
      dueDate: invoices.dueDate,
      status: invoices.status,
      total: invoices.totalPaise,
      paid: paid.paise,
      customer: customers.name,
      firmName: customers.firmName,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(paid, eq(paid.invoiceId, invoices.id))
    .orderBy(desc(invoices.id));
  return rows.map((r) => {
    const open = r.status === "issued" ? r.total - BigInt(r.paid ?? 0) : 0n;
    return { ...r, open, payment: paymentStatus({ ...r, totalPaise: r.total }, open) };
  });
}

/** The invoice with its customer, lines (+ category, job number) and totals, or undefined. */
export async function getInvoice(id: number) {
  const [row] = await db
    .select({ invoice: invoices, customer: customers })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, id));
  if (!row) return undefined;
  const lines = (
    await db
      .select({ line: invoiceLines, category: productCategories.name, job: jobs.number })
      .from(invoiceLines)
      .innerJoin(productCategories, eq(productCategories.id, invoiceLines.categoryId))
      .leftJoin(jobs, eq(jobs.id, invoiceLines.jobId))
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(asc(invoiceLines.position))
  ).map((r) => ({ ...r.line, category: r.category, job: r.job }));
  const inv = row.invoice;
  const mode = gstMode(inv.placeOfSupply, await companyState(db), inv.kind === "estimate");
  const issued = inv.status === "issued";
  const paid = issued ? ((await paidTowards(db, [id])).get(id) ?? 0n) : 0n;
  const open = issued ? inv.totalPaise - paid : 0n;
  // S5: the job advances adjusted at Issue, and what that leaves to pay on this invoice.
  const advance = issued ? await advanceAdjusted(db, id) : 0n;
  return {
    ...inv,
    customer: row.customer,
    lines,
    mode,
    totals: lineTotals(lines, mode),
    paid,
    open,
    payment: paymentStatus(inv, open),
    advance,
    balance: inv.totalPaise - advance,
  };
}

const onLiveInvoice = (jobId: typeof jobs.id) =>
  db
    .select({ one: sql`1` })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.jobId, jobId), ne(invoices.status, "cancelled")));

/** A customer's jobs that can still be billed: not cancelled, not invoiced, on no live invoice. */
export const billableJobs = (customerId: number) =>
  db
    .select({ id: jobs.id, number: jobs.number, date: jobs.date, status: jobs.status, total: jobs.totalPaise })
    .from(jobs)
    .where(
      and(
        eq(jobs.customerId, customerId),
        inArray(jobs.status, [...PRODUCTION_STATUSES]),
        notExists(onLiveInvoice(jobs.id)),
      ),
    )
    .orderBy(asc(jobs.id));

/** A customer's approved quotations with no job and on no live invoice (billed straight from the quote). */
export async function billableQuotations(customerId: number) {
  const rows = await db
    .select({ id: quotations.id, number: quotations.number, date: quotations.date, total: quotations.totalPaise })
    .from(quotations)
    .where(and(eq(quotations.customerId, customerId), eq(quotations.status, "approved")))
    .orderBy(asc(quotations.id));
  const open = [];
  for (const q of rows) if (!(await liveJobFor(db, q.id)) && !(await quotationInvoice(db, q.id))) open.push(q);
  return open;
}
