import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import {
  allocations,
  creditNoteLines,
  creditNotes,
  customers,
  debitNoteLines,
  debitNotes,
  invoiceLines,
  invoices,
  productCategories,
  type NOTE_STATUSES,
} from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { allocateCreditNote, liveAllocation, paidByDebitNote, paidTowardsDebitNotes, paymentStatus, releaseNote } from "@/lib/allocations";
import { needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse, type PostLine } from "@/lib/ledger";
import { gstMode, sizeText } from "@/lib/lines";
import { formatMoney, lineCalc, milliText, noteTotals, parseMoney, parseQty } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { checkVersion, companyState, dueDateFor, newShareToken, readDate } from "@/lib/sales";

// Credit and debit notes (S16, A§2–§7, D49): corrections to one issued invoice — lines picked from it (a qty and / or a
// taxable amount; a credit note never more than the line has left after earlier ones, D50), GST in the invoice's mode,
// no round-off. Drafts can be edited (D47); Issue numbers (CN/… · DN/…) and posts:
//   credit note: Dr sales_returns (taxable, per job) + gst_out_* / Cr ar · debit note: Dr ar / Cr sales + gst_out_*.
// A credit note then pays its invoice up to the open amount (the rest is customer credit); a debit note is a
// receivable of its own that receipts pay. A non-owner's credit note, and any backdated note, goes to the owner (A§7).
// Cancel reverses on the note's own date (D45).

export type NoteKind = "credit" | "debit";
export type NoteStatus = (typeof NOTE_STATUSES)[number];
type Q = Tx | typeof db;

// The debit tables have exactly the credit tables' columns, so one code path serves both: the debit ones are typed as
// the credit ones (the runtime objects are the real tables, so every query names the right table).
type NoteTable = typeof creditNotes;
type NoteLineTable = typeof creditNoteLines;
const TABLE: Record<NoteKind, { doc: NoteTable; lines: NoteLineTable }> = {
  credit: { doc: creditNotes, lines: creditNoteLines },
  debit: { doc: debitNotes as unknown as NoteTable, lines: debitNoteLines as unknown as NoteLineTable },
};

export const NOTE_KIND = {
  credit: { title: "Credit Note", series: "credit_note", docType: "credit_notes", path: "cn" },
  debit: { title: "Debit Note", series: "debit_note", docType: "debit_notes", path: "dn" },
} as const;
export const NOTE_STATUS: Record<NoteStatus, Status> = { draft: "Draft", issued: "Issued", cancelled: "Cancelled" };
/** "cn" / "dn" in a URL → the kind. */
export const kindOfPath = (path: string): NoteKind | null => (path === "cn" ? "credit" : path === "dn" ? "debit" : null);

/** The form as typed; lines = JSON of { invoiceLineId, qty, amount } (amount = taxable ₹, qty optional). */
export type NoteInput = { date: string; reason: string; notes: string; lines: string };

/** The invoice's lines with what a note of this kind can still take from each (after earlier issued ones). */
export async function invoiceLinesLeft(q: Q, kind: NoteKind, invoiceId: number, exceptNoteId?: number) {
  const t = TABLE[kind];
  const [rows, taken] = await Promise.all([
    q
      .select({ line: invoiceLines, category: productCategories.name })
      .from(invoiceLines)
      .innerJoin(productCategories, eq(productCategories.id, invoiceLines.categoryId))
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(invoiceLines.position)),
    q
      .select({
        lineId: t.lines.invoiceLineId,
        qty: sql<string>`coalesce(sum(${t.lines.qtyMilli}), 0)`,
        taxable: sql<string>`sum(${t.lines.taxablePaise})`,
      })
      .from(t.lines)
      .innerJoin(t.doc, eq(t.doc.id, t.lines.noteId))
      .where(and(eq(t.doc.invoiceId, invoiceId), eq(t.doc.status, "issued"), exceptNoteId ? ne(t.doc.id, exceptNoteId) : undefined))
      .groupBy(t.lines.invoiceLineId),
  ]);
  return rows.map(({ line, category }) => {
    const { taxable } = lineCalc({ qty: line.qtyMilli, rate: line.ratePaise, discount: line.discountPaise, gstBp: line.gstBp }, "estimate");
    const took = taken.find((x) => x.lineId === line.id);
    return {
      ...line,
      category,
      taxable,
      qtyLeft: line.qtyMilli - BigInt(took?.qty ?? 0),
      taxableLeft: taxable - BigInt(took?.taxable ?? 0),
    };
  });
}

type NoteLineIn = { invoiceLineId: number; qty: bigint | null; taxable: bigint };

/** The form's lines → values. A line with neither qty nor amount is skipped; an amount is needed on every other. */
function readNoteLines(json: string): NoteLineIn[] {
  const fail = (message: string): never => {
    throw new UserError(message, "lines");
  };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) fail("The lines couldn't be read: reload the page.");
  const lines: NoteLineIn[] = [];
  for (const [i, row] of (raw as unknown[]).entries()) {
    const o = (row ?? {}) as Record<string, unknown>;
    const qtyText = typeof o.qty === "string" ? o.qty.trim() : "";
    const amountText = typeof o.amount === "string" ? o.amount.trim() : "";
    if (!qtyText && !amountText) continue;
    const n = `Line ${i + 1}`;
    let qty: bigint | null = null;
    if (qtyText) {
      try {
        qty = parseQty(qtyText);
      } catch {
        fail(`${n}: enter the qty like 1 or 2.5.`);
      }
      if (qty! <= 0n) fail(`${n}: the qty must be more than 0.`);
    }
    if (!amountText) fail(`${n}: enter the amount (taxable ₹).`);
    let taxable = 0n;
    try {
      taxable = parseMoney(amountText);
    } catch {
      fail(`${n}: enter the amount like 500 or 1,250.50.`);
    }
    if (taxable <= 0n) fail(`${n}: the amount must be more than 0.`);
    const invoiceLineId = Number(o.invoiceLineId);
    if (!Number.isSafeInteger(invoiceLineId)) fail("The lines couldn't be read: reload the page.");
    lines.push({ invoiceLineId, qty, taxable });
  }
  if (!lines.length) fail("Enter an amount on at least one line.");
  if (new Set(lines.map((l) => l.invoiceLineId)).size !== lines.length) fail("Each invoice line once.");
  return lines;
}

/**
 * Checks lines against the invoice: each on it; a credit note never more than the line has left (qty and amount).
 * Debit notes have no cap: they add to the invoice (D50).
 */
async function checkNoteLines(q: Q, kind: NoteKind, invoiceId: number, lines: NoteLineIn[], exceptNoteId?: number) {
  const left = await invoiceLinesLeft(q, kind, invoiceId, exceptNoteId);
  return lines
    .map((l) => {
      const il = left.find((x) => x.id === l.invoiceLineId);
      if (!il) throw new UserError("A line isn't on this invoice: reload the page.", "lines");
      const n = `Invoice line ${il.position}`;
      if (kind === "credit" && l.qty !== null && l.qty > il.qtyLeft) {
        throw new UserError(`${n}: qty ${milliText(l.qty)} is more than the ${milliText(il.qtyLeft)} ${il.unit} left.`, "lines");
      }
      if (kind === "credit" && l.taxable > il.taxableLeft) {
        throw new UserError(`${n}: ${formatMoney(l.taxable)} is more than the ${formatMoney(il.taxableLeft)} left on it.`, "lines");
      }
      return { ...l, gstBp: il.gstBp, jobId: il.jobId, position: il.position };
    })
    .sort((a, b) => a.position - b.position);
}

type Invoice = typeof invoices.$inferSelect;

/** The invoice a note is against, locked (Issue and cancel of the invoice queue behind it). Must be issued. */
async function issuedInvoice(tx: Tx, id: number): Promise<Invoice> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new UserError("That invoice doesn't exist.");
  if (inv.status !== "issued") throw new UserError("Only an issued invoice can have a credit or debit note.");
  return inv;
}

const modeOf = async (q: Q, inv: Pick<Invoice, "placeOfSupply" | "kind">) =>
  gstMode(inv.placeOfSupply, await companyState(q), inv.kind === "estimate");

/** The form → checked values and lines, with the total (taxable + GST, no round-off). */
async function readNote(tx: Tx, kind: NoteKind, inv: Invoice, input: NoteInput, exceptNoteId?: number) {
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  if (date < inv.date) throw new UserError(`A note can't be dated before its invoice (${formatDate(inv.date)}).`, "date");
  const reason = formText(input.reason, "reason", 500);
  if (!reason) throw new UserError("Say why: return, rate correction, discount …", "reason");
  const lines = await checkNoteLines(tx, kind, inv.id, readNoteLines(input.lines), exceptNoteId);
  const totals = noteTotals(lines.map((l) => ({ taxable: l.taxable, gstBp: l.gstBp })), await modeOf(tx, inv));
  return { values: { date, reason, notes: formText(input.notes, "notes", 2000), totalPaise: totals.total }, lines };
}

const insertLines = (tx: Tx, kind: NoteKind, noteId: number, lines: Awaited<ReturnType<typeof checkNoteLines>>) =>
  tx.insert(TABLE[kind].lines).values(
    lines.map((l, i) => ({
      noteId,
      position: i + 1,
      invoiceLineId: l.invoiceLineId,
      qtyMilli: l.qty,
      taxablePaise: l.taxable,
      gstBp: l.gstBp,
    })),
  );

/** A draft note against an issued invoice. */
export async function createNote(actor: SessionUser, kind: NoteKind, invoiceId: number, input: NoteInput): Promise<number> {
  if (!can(actor, "invoices", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const inv = await issuedInvoice(tx, invoiceId);
    const { values, lines } = await readNote(tx, kind, inv, input);
    const [row] = await tx
      .insert(TABLE[kind].doc)
      .values({ ...values, invoiceId: inv.id, customerId: inv.customerId, shareToken: newShareToken(), createdBy: actor.id })
      .returning({ id: TABLE[kind].doc.id });
    await insertLines(tx, kind, row.id, lines);
    return row.id;
  });
}

async function lockNote(tx: Tx, kind: NoteKind, id: number) {
  const [note] = await tx.select().from(TABLE[kind].doc).where(eq(TABLE[kind].doc.id, id)).for("update");
  if (!note) throw new UserError("That note doesn't exist.");
  return note;
}

/** Drafts only; the lines are replaced (D47). */
export async function updateNote(actor: SessionUser, kind: NoteKind, id: number, input: NoteInput): Promise<void> {
  if (!can(actor, "invoices", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const [peek] = await tx.select({ invoiceId: TABLE[kind].doc.invoiceId }).from(TABLE[kind].doc).where(eq(TABLE[kind].doc.id, id));
    if (!peek) throw new UserError("That note doesn't exist.");
    const inv = await issuedInvoice(tx, peek.invoiceId);
    const note = await lockNote(tx, kind, id);
    if (note.status !== "draft") throw new UserError("An issued note can't be edited. Cancel it and make a new one.");
    const { values, lines } = await readNote(tx, kind, inv, input, id);
    await tx.update(TABLE[kind].doc).set(values).where(eq(TABLE[kind].doc.id, id));
    // ponytail: a draft's lines are replaced on save (the audit log keeps the old rows); issued ones never are.
    await tx.delete(TABLE[kind].lines).where(eq(TABLE[kind].lines.noteId, id));
    await insertLines(tx, kind, id, lines);
  });
}

const savedLines = (q: Q, kind: NoteKind, noteId: number) =>
  q.select().from(TABLE[kind].lines).where(eq(TABLE[kind].lines.noteId, noteId)).orderBy(asc(TABLE[kind].lines.position));

/** A§3. Credit: Dr sales_returns (per job) + output GST / Cr ar. Debit: Dr ar / Cr sales (per job) + output GST. */
function postingLines(kind: NoteKind, customerId: number, lines: { jobId: number | null }[], t: ReturnType<typeof noteTotals>): PostLine[] {
  const side = (amount: bigint) => (kind === "credit" ? { debit: amount } : { credit: amount });
  const byJob = new Map<number | null, bigint>();
  lines.forEach((l, i) => byJob.set(l.jobId, (byJob.get(l.jobId) ?? 0n) + t.lines[i].taxable));
  return [
    ...[...byJob].map(([jobId, taxable]): PostLine => ({
      account: kind === "credit" ? "sales_returns" : "sales",
      jobId: jobId ?? undefined,
      ...side(taxable),
    })),
    { account: "gst_out_cgst", ...side(t.cgst) },
    { account: "gst_out_sgst", ...side(t.sgst) },
    { account: "gst_out_igst", ...side(t.igst) },
    { account: "ar", customerId, ...(kind === "credit" ? { credit: t.total } : { debit: t.total }) },
  ];
}

type IssuePayload = { kind: NoteKind; id: number; version: string };

/** Draft → Issued in one transaction: number, entry, frozen; a credit note then pays its invoice. Returns the number. */
async function doIssue(tx: Tx, p: IssuePayload, by: SessionUser): Promise<string> {
  const t = TABLE[p.kind];
  const [peek] = await tx.select({ invoiceId: t.doc.invoiceId }).from(t.doc).where(eq(t.doc.id, p.id));
  if (!peek) throw new UserError("That note doesn't exist.");
  const inv = await issuedInvoice(tx, peek.invoiceId);
  const note = await lockNote(tx, p.kind, p.id);
  if (note.status !== "draft") throw new UserError("Only a draft note can be issued.");
  checkVersion(note, p.version, "note");
  // Earlier notes may have been issued since this draft was saved.
  const lines = await checkNoteLines(
    tx,
    p.kind,
    inv.id,
    (await savedLines(tx, p.kind, note.id)).map((l) => ({ invoiceLineId: l.invoiceLineId, qty: l.qtyMilli, taxable: l.taxablePaise })),
    note.id,
  );
  const totals = noteTotals(lines.map((l) => ({ taxable: l.taxable, gstBp: l.gstBp })), await modeOf(tx, inv));
  if (totals.total <= 0n) throw new UserError("The total must be more than zero.");
  const [customer] = await tx.select().from(customers).where(eq(customers.id, inv.customerId));
  const { title, series, docType } = NOTE_KIND[p.kind];
  const number = await nextNumber(tx, series, note.date);
  await post(tx, {
    date: note.date,
    docType,
    docId: note.id,
    number,
    narration: `${title} ${number} against ${inv.number} · ${customer.name}`,
    lines: postingLines(p.kind, inv.customerId, lines, totals),
  });
  const dueDate = p.kind === "debit" ? await dueDateFor(tx, note.date, customer.creditDays) : null;
  await tx.update(t.doc).set({ number, status: "issued", totalPaise: totals.total, dueDate }).where(eq(t.doc.id, note.id));
  if (p.kind === "credit") await allocateCreditNote(tx, note.id, inv.id, totals.total, by.id);
  return number;
}

type CancelPayload = { kind: NoteKind; id: number };

/** Issued → Cancelled: reverse on the note's own date (D45); its allocations stop (the invoice / receipts reopen). */
async function doCancel(tx: Tx, p: CancelPayload) {
  const note = await lockNote(tx, p.kind, p.id);
  if (note.status !== "issued") throw new UserError("Only an issued note can be cancelled this way.");
  const entry = await liveEntry(tx, NOTE_KIND[p.kind].docType, note.id);
  if (!entry) throw new Error(`Issued ${p.kind} note ${note.id} has no journal entry in force`);
  await reverse(tx, entry.id, note.date);
  await tx.update(TABLE[p.kind].doc).set({ status: "cancelled" }).where(eq(TABLE[p.kind].doc.id, note.id));
  await releaseNote(tx, p.kind, note.id);
}

async function describeNote(tx: Tx, kind: NoteKind, id: number) {
  const [row] = await tx
    .select({ note: TABLE[kind].doc, invoice: invoices.number, customer: customers.name })
    .from(TABLE[kind].doc)
    .innerJoin(invoices, eq(invoices.id, TABLE[kind].doc.invoiceId))
    .innerJoin(customers, eq(customers.id, TABLE[kind].doc.customerId))
    .where(eq(TABLE[kind].doc.id, id));
  if (!row) throw new UserError("That note doesn't exist.");
  return row;
}

for (const kind of ["credit", "debit"] as const) {
  const { title, docType } = NOTE_KIND[kind];
  registerExecutor<IssuePayload>(`${kind}_note.issue`, {
    async describe(tx, p) {
      const { note, invoice, customer } = await describeNote(tx, kind, p.id);
      if (note.status !== "draft") throw new UserError("Only a draft note can be issued.");
      checkVersion(note, p.version, "note");
      return {
        summary: `Issue ${title.toLowerCase()} against ${invoice} (${customer}, ${formatMoney(note.totalPaise)})`,
        target: { type: docType, id: p.id },
        changes: [
          { label: "Status", old: "Draft", new: "Issued (numbered and posted)" },
          { label: "Date", old: null, new: formatDate(note.date) },
          { label: "Total", old: null, new: formatMoney(note.totalPaise) },
          { label: "Reason", old: null, new: note.reason },
        ],
      };
    },
    run: (tx, owner, p) => doIssue(tx, { ...p, kind }, owner),
  });
  registerExecutor<CancelPayload>(`${kind}_note.cancel`, {
    async describe(tx, p) {
      const { note, invoice, customer } = await describeNote(tx, kind, p.id);
      if (note.status !== "issued") throw new UserError("Only an issued note can be cancelled this way.");
      return {
        summary: `Cancel ${title.toLowerCase()} ${note.number} against ${invoice} (${customer}, ${formatMoney(note.totalPaise)})`,
        target: { type: docType, id: p.id },
        changes: [
          { label: "Status", old: "Issued", new: "Cancelled (number kept)" },
          { label: "Journal", old: null, new: `Entry reversed on ${formatDate(note.date)}` },
        ],
      };
    },
    run: (tx, _owner, p) => doCancel(tx, { ...p, kind }),
  });
}

/**
 * Issue. A credit note by anyone but the owner, or any note dated before the backdate window, becomes an approval
 * request and nothing posts (A§7).
 */
export async function issueNote(actor: SessionUser, kind: NoteKind, id: number): Promise<{ message: string }> {
  if (!can(actor, "invoices", "edit")) throw new Error("Not allowed");
  const [note] = await db.select().from(TABLE[kind].doc).where(eq(TABLE[kind].doc.id, id));
  if (!note) throw new UserError("That note doesn't exist.");
  if (note.status !== "draft") throw new UserError("Only a draft note can be issued.");
  const payload: IssuePayload = { kind, id, version: note.updatedAt.toISOString() };
  const reasons: string[] = [];
  if (kind === "credit") reasons.push("A credit note needs the owner's approval");
  if (await needsBackdateApproval(note.date)) reasons.push(`Dated ${formatDate(note.date)}, before the backdate window`);
  let number: string;
  if (reasons.length) {
    const outcome = await runOrRequest(actor, `${kind}_note.issue`, payload, reasons.join(" · "));
    if (!outcome.done) return { message: outcome.message };
    number = outcome.result as string;
  } else {
    number = await writeTx(actor, (tx) => doIssue(tx, payload, actor));
  }
  return { message: `Issued ${number}.` };
}

/** A draft is simply cancelled; an issued one: the owner at once, anyone else files a request. */
export async function cancelNote(actor: SessionUser, kind: NoteKind, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "invoices", "cancel")) throw new Error("Not allowed");
  const [note] = await db.select().from(TABLE[kind].doc).where(eq(TABLE[kind].doc.id, id));
  if (!note) throw new UserError("That note doesn't exist.");
  if (note.status === "cancelled") throw new UserError("This note is already cancelled.");
  if (note.status === "draft") {
    await writeTx(actor, async (tx) => {
      const draft = await lockNote(tx, kind, id);
      if (draft.status !== "draft") throw new UserError("It was issued meanwhile: reload the page.");
      await tx.update(TABLE[kind].doc).set({ status: "cancelled" }).where(eq(TABLE[kind].doc.id, id));
    });
    return { message: "Draft cancelled." };
  }
  const outcome = await runOrRequest(actor, `${kind}_note.cancel`, { kind, id } satisfies CancelPayload, reason);
  return { message: outcome.done ? `Cancelled ${note.number}; its entry is reversed.` : outcome.message };
}

// ---- Loaders

/** Both kinds, newest first; debit notes with their open amount and payment status. */
export async function listNotes() {
  const paid = paidByDebitNote();
  const [credit, debit] = await Promise.all(
    (["credit", "debit"] as const).map((kind) => {
      const t = TABLE[kind];
      const q = db
        .select({
          id: t.doc.id,
          number: t.doc.number,
          date: t.doc.date,
          status: t.doc.status,
          dueDate: t.doc.dueDate,
          total: t.doc.totalPaise,
          reason: t.doc.reason,
          invoiceId: t.doc.invoiceId,
          invoice: invoices.number,
          customer: customers.name,
          firmName: customers.firmName,
          paid: kind === "debit" ? paid.paise : sql<string | null>`null`,
        })
        .from(t.doc)
        .innerJoin(invoices, eq(invoices.id, t.doc.invoiceId))
        .innerJoin(customers, eq(customers.id, t.doc.customerId));
      return kind === "debit" ? q.leftJoin(paid, eq(paid.debitNoteId, t.doc.id)) : q;
    }),
  );
  const shape = (kind: NoteKind) => (r: (typeof credit)[number]) => {
    const open = kind === "debit" && r.status === "issued" ? r.total - BigInt(r.paid ?? 0) : 0n;
    const payment = kind === "debit" ? paymentStatus({ status: r.status, totalPaise: r.total, dueDate: r.dueDate ?? r.date }, open) : null;
    return { ...r, kind, open, payment };
  };
  return [...credit.map(shape("credit")), ...debit.map(shape("debit"))].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.id - a.id,
  );
}

/** A note with its invoice, customer, lines (with the invoice line's description) and totals, or undefined. */
export async function getNote(kind: NoteKind, id: number) {
  const t = TABLE[kind];
  const [row] = await db
    .select({ note: t.doc, invoice: invoices, customer: customers })
    .from(t.doc)
    .innerJoin(invoices, eq(invoices.id, t.doc.invoiceId))
    .innerJoin(customers, eq(customers.id, t.doc.customerId))
    .where(eq(t.doc.id, id));
  if (!row) return undefined;
  const lines = (
    await db
      .select({ line: t.lines, invoiceLine: invoiceLines, category: productCategories.name })
      .from(t.lines)
      .innerJoin(invoiceLines, eq(invoiceLines.id, t.lines.invoiceLineId))
      .innerJoin(productCategories, eq(productCategories.id, invoiceLines.categoryId))
      .where(eq(t.lines.noteId, id))
      .orderBy(asc(t.lines.position))
  ).map((r) => ({
    ...r.line,
    category: r.category,
    description: r.invoiceLine.description,
    hsnSac: r.invoiceLine.hsnSac,
    widthMilli: r.invoiceLine.widthMilli,
    heightMilli: r.invoiceLine.heightMilli,
    unit: r.invoiceLine.unit,
    invoicePosition: r.invoiceLine.position,
  }));
  const mode = await modeOf(db, row.invoice);
  const totals = noteTotals(lines.map((l) => ({ taxable: l.taxablePaise, gstBp: l.gstBp })), mode);
  const note = row.note;
  const issued = note.status === "issued";
  // Debit note: paid by receipts. Credit note: what it paid on its invoice or was applied to (the rest is customer credit).
  const paid =
    kind === "debit"
      ? issued
        ? ((await paidTowardsDebitNotes(db, [id])).get(id) ?? 0n)
        : 0n
      : BigInt(
          (
            await db
              .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
              .from(allocations)
              .where(and(liveAllocation(), eq(allocations.creditNoteId, id)))
          )[0].paise,
        );
  const open = issued ? note.totalPaise - paid : 0n;
  return {
    ...note,
    kind,
    invoice: row.invoice,
    customer: row.customer,
    lines,
    mode,
    totals,
    paid,
    open,
    payment: kind === "debit" ? paymentStatus({ ...note, dueDate: note.dueDate ?? note.date }, open) : null,
  };
}

/** The notes against an invoice, both kinds, oldest first. */
export async function notesOfInvoice(q: Q, invoiceId: number) {
  const rows = await Promise.all(
    (["credit", "debit"] as const).map(async (kind) =>
      (
        await q
          .select({ id: TABLE[kind].doc.id, number: TABLE[kind].doc.number, date: TABLE[kind].doc.date, status: TABLE[kind].doc.status, total: TABLE[kind].doc.totalPaise })
          .from(TABLE[kind].doc)
          .where(eq(TABLE[kind].doc.invoiceId, invoiceId))
          .orderBy(desc(TABLE[kind].doc.id))
      ).map((r) => ({ ...r, kind })),
    ),
  );
  return rows.flat().sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id - b.id));
}

/** The note form's rows: every invoice line with what is left on it for this kind of note. */
export async function noteFormLines(kind: NoteKind, invoiceId: number, exceptNoteId?: number) {
  return (await invoiceLinesLeft(db, kind, invoiceId, exceptNoteId)).map((l) => ({
    invoiceLineId: l.id,
    position: l.position,
    item: l.description ?? l.category,
    detail: [l.description && l.category, sizeText(l.widthMilli, l.heightMilli)].filter(Boolean).join(" · "),
    unit: l.unit,
    qty: l.qtyMilli,
    taxable: l.taxable,
    qtyLeft: l.qtyLeft,
    taxableLeft: l.taxableLeft,
    gstBp: l.gstBp,
  }));
}
