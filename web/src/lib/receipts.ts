import { and, asc, desc, eq, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, writeTx, type Tx } from "@/db";
import { accounts, adjustments, allocations, creditNotes, customers, debitNotes, invoices, jobs, openingBills, printJobs, receipts, users } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import {
  activeAllocationsOf,
  checkAllocations,
  deactivate,
  liveAllocation,
  openingBillLabel,
  readAllocations,
  refundOf,
  type AllocationLine,
  type AllocationTarget,
} from "@/lib/allocations";
import { type Change, needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, fyKey, parseDate } from "@/lib/dates";
import { staffOptions } from "@/lib/customers";
import { checkBooksDate, liveEntry, moneyAccounts, post, reverse } from "@/lib/ledger";
import { formatMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { RECEIPT_MODE, RECEIPT_MODES } from "@/lib/receipt-modes";
import { checkVersion, customerFor, readDate } from "@/lib/sales";
import { dateIn, type Range } from "@/lib/statements";

// Receipts (S6, A§2, A§3, A§7, D49): money in from a customer. Numbered on save and posted in the same transaction
// (Dr money account / Cr ar). The allocation panel links it to the customer's invoices; what isn't allocated is
// on-account advance. Edit / cancel: the owner at once, anyone else through an approval request; a cancel reverses
// the entry on the receipt's own date (D45) and deactivates its allocations.

type Receipt = typeof receipts.$inferSelect;

/** The form as typed. allocations = JSON of { target: "invoice" | "debit_note" | "job" | "print_job", id, amount }[]. */
export type ReceiptInput = {
  customerId: string;
  date: string;
  amount: string;
  mode: string;
  moneyAccountId: string;
  reference: string;
  chequeNo: string;
  chequeDate: string;
  receivedBy: string;
  notes: string;
  allocations: string;
};

/** The form → checked values, the customer and the allocation lines (checked against what is open, locked). */
async function readReceipt(tx: Tx, input: ReceiptInput, current?: Receipt) {
  const customer = await customerFor(tx, input.customerId, !current || Number(input.customerId) !== current.customerId);
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const amountPaise = formMoney(input.amount, "amount");
  if (amountPaise === null || amountPaise <= 0n) throw new UserError("Enter the amount received.", "amount");
  const mode = RECEIPT_MODES.find((m) => m === input.mode);
  if (!mode) throw new UserError("Pick how it was paid.", "mode");

  const accountId = Number(input.moneyAccountId);
  const [account] = Number.isSafeInteger(accountId)
    ? await tx.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isMoney, true)))
    : [];
  if (!account) throw new UserError("Pick the account the money went into.", "moneyAccountId");

  const cheque = mode === "cheque";
  const chequeNo = cheque ? formText(input.chequeNo, "chequeNo", 30) : null;
  if (cheque && !chequeNo) throw new UserError("Enter the cheque number.", "chequeNo");
  let chequeDate: string | null = null;
  if (cheque && input.chequeDate.trim()) {
    try {
      chequeDate = parseDate(input.chequeDate);
    } catch {
      throw new UserError("Use DD/MM/YYYY, e.g. 28/09/2026.", "chequeDate");
    }
  }
  let receivedBy: string | null = null;
  if (input.receivedBy) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.receivedBy));
    if (!u) throw new UserError("Pick someone from the list.", "receivedBy");
    receivedBy = u.id;
  }

  const lines = await checkAllocations(tx, customer.id, amountPaise, readAllocations(input.allocations), current?.id);
  return {
    customer,
    account,
    lines,
    values: {
      customerId: customer.id,
      date,
      amountPaise,
      mode,
      moneyAccountId: account.id,
      reference: formText(input.reference, "reference", 100),
      chequeNo,
      chequeDate,
      receivedBy,
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

type Values = Awaited<ReturnType<typeof readReceipt>>["values"];

/** A§3: Dr the money account / Cr ar (customer). */
const postReceipt = (tx: Tx, id: number, number: string, v: Values, customerName: string) =>
  post(tx, {
    date: v.date,
    docType: "receipts",
    docId: id,
    number,
    narration: `Receipt ${number} · ${customerName}`,
    lines: [
      { account: v.moneyAccountId, debit: v.amountPaise },
      { account: "ar", customerId: v.customerId, credit: v.amountPaise },
    ],
  });

/**
 * fromJob: invoice id → the job / print job whose money its old row carried (kept when an edit re-allocates, T14).
 */
const insertAllocations = (
  tx: Tx,
  receiptId: number,
  lines: AllocationLine[],
  by: Pick<SessionUser, "id">,
  fromJob = new Map<number, { jobId: number | null; printJobId: number | null }>(),
) =>
  lines.length
    ? tx.insert(allocations).values(
        lines.map((l) => ({
          receiptId,
          invoiceId: l.target === "invoice" ? l.id : null,
          debitNoteId: l.target === "debit_note" ? l.id : null,
          jobId: l.target === "job" ? l.id : null,
          printJobId: l.target === "print_job" ? l.id : null,
          openingBillId: l.target === "opening_bill" ? l.id : null,
          fromJobId: l.target === "invoice" ? (fromJob.get(l.id)?.jobId ?? null) : null,
          fromPrintJobId: l.target === "invoice" ? (fromJob.get(l.id)?.printJobId ?? null) : null,
          amountPaise: l.amount,
          createdBy: by.id,
        })),
      )
    : Promise.resolve();

/** "RDS/26-27/0001 ₹20,000.00 · on account ₹5,000.00". */
function allocationText(lines: { number: string; amount: bigint }[], amount: bigint) {
  const rest = amount - lines.reduce((s, l) => s + l.amount, 0n);
  const parts = lines.map((l) => `${l.number} ${formatMoney(l.amount)}`);
  if (rest > 0n) parts.push(`on account ${formatMoney(rest)}`);
  return parts.join(" · ");
}

/**
 * Numbers, posts and allocates a receipt inside the caller's transaction — no permission or backdate check (callers
 * do that: createReceipt, and print jobs for money taken at the print, D64).
 */
export async function insertReceipt(tx: Tx, actor: Pick<SessionUser, "id">, input: ReceiptInput) {
  const r = await readReceipt(tx, input);
  const number = await nextNumber(tx, "receipt", r.values.date);
  const [row] = await tx
    .insert(receipts)
    .values({ ...r.values, number, createdBy: actor.id })
    .returning({ id: receipts.id });
  await postReceipt(tx, row.id, number, r.values, r.customer.name);
  await insertAllocations(tx, row.id, r.lines, actor);
  return { id: row.id, number };
}

type CreatePayload = { input: ReceiptInput };

registerExecutor<CreatePayload>("receipt.create", {
  async describe(tx, p) {
    const r = await readReceipt(tx, p.input);
    return {
      summary: `Receipt ${formatMoney(r.values.amountPaise)} from ${r.customer.name}, dated ${formatDate(r.values.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(r.values.date) },
        { label: "Amount", old: null, new: formatMoney(r.values.amountPaise) },
        { label: "Mode", old: null, new: `${RECEIPT_MODE[r.values.mode]} → ${r.account.name}` },
        { label: "Allocated", old: null, new: allocationText(r.lines, r.values.amountPaise) || "on account" },
      ],
    };
  },
  run: (tx, owner, p) => insertReceipt(tx, owner, p.input),
});

/**
 * Save a new receipt: numbered, posted and allocated in one transaction. By anyone but the owner, a date before the
 * backdate window becomes an approval request instead (D49) and nothing is saved.
 */
export async function createReceipt(actor: SessionUser, input: ReceiptInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "payments", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const why = `Dated ${formatDate(date)}, before the backdate window`;
    const outcome = await runOrRequest(actor, "receipt.create", { input } satisfies CreatePayload, why);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => insertReceipt(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lock(tx: Tx, id: number) {
  const [r] = await tx.select().from(receipts).where(eq(receipts.id, id)).for("update");
  if (!r) throw new UserError("That receipt doesn't exist.");
  return r;
}

const accountName = async (tx: Tx, id: number) =>
  (await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, id)))[0]?.name ?? `#${id}`;
const personName = async (tx: Tx, id: string | null) =>
  id ? ((await tx.select({ name: users.name }).from(users).where(eq(users.id, id)))[0]?.name ?? null) : null;

/** The allocations in force, with their invoice / job numbers. */
async function currentLines(tx: Tx, receiptId: number) {
  const rows = await tx
    .select({
      id: allocations.id,
      invoiceId: allocations.invoiceId,
      debitNoteId: allocations.debitNoteId,
      jobId: allocations.jobId,
      printJobId: allocations.printJobId,
      fromJobId: allocations.fromJobId,
      fromPrintJobId: allocations.fromPrintJobId,
      amount: allocations.amountPaise,
      invoice: invoices.number,
      debitNote: debitNotes.number,
      job: jobs.number,
      printJob: printJobs.number,
    })
    .from(allocations)
    .leftJoin(invoices, eq(invoices.id, allocations.invoiceId))
    .leftJoin(debitNotes, eq(debitNotes.id, allocations.debitNoteId))
    .leftJoin(jobs, eq(jobs.id, allocations.jobId))
    .leftJoin(printJobs, eq(printJobs.id, allocations.printJobId))
    .where(and(eq(allocations.receiptId, receiptId), eq(allocations.active, true)))
    .orderBy(asc(allocations.id));
  return rows.map((r) => ({
    ...r,
    target: (r.jobId !== null ? "job" : r.printJobId !== null ? "print_job" : r.debitNoteId !== null ? "debit_note" : "invoice") as AllocationTarget,
    targetId: r.jobId ?? r.printJobId ?? r.debitNoteId ?? r.invoiceId!,
    number: r.job ?? r.printJob ?? r.debitNote ?? r.invoice ?? "",
  }));
}

type EditPayload = { id: number; version: string; input: ReceiptInput };

/** D55: a refund JV that paid back part of the receipt goes first (its allocation would outlive the change). */
async function checkNotRefunded(tx: Tx, receiptId: number) {
  const jv = await refundOf(tx, { kind: "receipt", id: receiptId });
  if (jv) throw new UserError(`Cancel ${jv} first: it paid back part of this receipt.`);
}

/** Checks an edit against the receipt as it is now and lists what changes (old → new). */
async function planEdit(tx: Tx, p: EditPayload) {
  const current = await lock(tx, p.id);
  if (current.status !== "active") throw new UserError("A cancelled receipt can't be changed.");
  checkVersion(current, p.version, "receipt");
  await checkNotRefunded(tx, current.id);
  const r = await readReceipt(tx, p.input, current);
  if (fyKey(r.values.date) !== fyKey(current.date)) {
    throw new UserError("A receipt can't move to another financial year: cancel it and enter a new one.", "date");
  }
  const old = await currentLines(tx, p.id);
  const sameLines =
    old.length === r.lines.length &&
    r.lines.every((l) => old.some((o) => o.target === l.target && o.targetId === l.id && o.amount === l.amount));
  const [oldCustomer] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, current.customerId));

  const changes: Change[] = [];
  const diff = (label: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ label, old: before, new: after });
  };
  const v = r.values;
  diff("Customer", oldCustomer.name, r.customer.name);
  diff("Date", formatDate(current.date), formatDate(v.date));
  diff("Amount", formatMoney(current.amountPaise), formatMoney(v.amountPaise));
  diff("Mode", RECEIPT_MODE[current.mode], RECEIPT_MODE[v.mode]);
  diff("Account", await accountName(tx, current.moneyAccountId), r.account.name);
  diff("Cheque no", current.chequeNo, v.chequeNo);
  diff("Cheque date", current.chequeDate && formatDate(current.chequeDate), v.chequeDate && formatDate(v.chequeDate));
  diff("Reference", current.reference, v.reference);
  diff("Received by", await personName(tx, current.receivedBy), await personName(tx, v.receivedBy));
  diff("Notes", current.notes, v.notes);
  if (!sameLines) {
    diff(
      "Allocated",
      allocationText(old, current.amountPaise) || "on account",
      allocationText(r.lines, v.amountPaise) || "on account",
    );
  }
  const reposts =
    v.date !== current.date ||
    v.customerId !== current.customerId ||
    v.amountPaise !== current.amountPaise ||
    v.moneyAccountId !== current.moneyAccountId;
  return { current, r, old, sameLines, changes, reposts };
}

/** Edit = reverse + repost (only when a posted figure changed) + reallocate (only when the lines changed). */
async function doEdit(tx: Tx, owner: SessionUser, p: EditPayload) {
  const { current, r, old, sameLines, changes, reposts } = await planEdit(tx, p);
  if (!changes.length) return current.number;
  await tx.update(receipts).set(r.values).where(eq(receipts.id, current.id));
  if (reposts) {
    const entry = await liveEntry(tx, "receipts", current.id);
    if (!entry) throw new Error(`Receipt ${current.id} has no journal entry in force`);
    await reverse(tx, entry.id, current.date);
    await postReceipt(tx, current.id, current.number, r.values, r.customer.name);
  }
  if (!sameLines) {
    await deactivate(tx, old.map((o) => o.id));
    const fromJob = new Map(old.filter((o) => o.invoiceId !== null).map((o) => [o.invoiceId!, { jobId: o.fromJobId, printJobId: o.fromPrintJobId }]));
    await insertAllocations(tx, current.id, r.lines, owner, fromJob);
  }
  return current.number;
}

registerExecutor<EditPayload>("receipt.edit", {
  async describe(tx, p) {
    const { current, changes } = await planEdit(tx, p);
    if (!changes.length) throw new UserError("Nothing was changed.");
    return { summary: `Change receipt ${current.number}`, target: { type: "receipts", id: p.id }, changes };
  },
  run: (tx, owner, p) => doEdit(tx, owner, p),
});

/** The owner edits at once; anyone else files a request (A§7). */
export async function updateReceipt(actor: SessionUser, id: number, input: ReceiptInput, reason: string) {
  if (!can(actor, "payments", "edit")) throw new Error("Not allowed");
  const [r] = await db.select().from(receipts).where(eq(receipts.id, id));
  if (!r) throw new UserError("That receipt doesn't exist.");
  if (r.status !== "active") throw new UserError("A cancelled receipt can't be changed.");
  const payload: EditPayload = { id, version: r.updatedAt.toISOString(), input };
  const outcome = await runOrRequest(actor, "receipt.edit", payload, reason);
  return { message: outcome.done ? `Saved ${r.number}.` : outcome.message };
}

type CancelPayload = { id: number };

/** Reverse on the receipt's own date (D45), mark it cancelled, deactivate its allocations (the invoices reopen). */
async function doCancel(tx: Tx, p: CancelPayload) {
  const r = await lock(tx, p.id);
  if (r.status !== "active") throw new UserError("This receipt is already cancelled.");
  await checkNotRefunded(tx, r.id);
  const entry = await liveEntry(tx, "receipts", r.id);
  if (!entry) throw new Error(`Receipt ${r.id} has no journal entry in force`);
  await reverse(tx, entry.id, r.date);
  await tx.update(receipts).set({ status: "cancelled" }).where(eq(receipts.id, r.id));
  await deactivate(tx, (await activeAllocationsOf(tx, r.id)).map((a) => a.id));
}

registerExecutor<CancelPayload>("receipt.cancel", {
  async describe(tx, p) {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, p.id));
    if (!r) throw new UserError("That receipt doesn't exist.");
    if (r.status !== "active") throw new UserError("This receipt is already cancelled.");
    await checkNotRefunded(tx, r.id);
    return {
      summary: `Cancel receipt ${r.number} (${formatMoney(r.amountPaise)})`,
      target: { type: "receipts", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(r.date)}` },
        { label: "Allocations", old: null, new: "Removed: its invoices are open again" },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

export async function cancelReceipt(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "payments", "cancel")) throw new Error("Not allowed");
  const [r] = await db.select().from(receipts).where(eq(receipts.id, id));
  if (!r) throw new UserError("That receipt doesn't exist.");
  if (r.status !== "active") throw new UserError("This receipt is already cancelled.");
  const outcome = await runOrRequest(actor, "receipt.cancel", { id } satisfies CancelPayload, reason);
  return { message: outcome.done ? `Cancelled ${r.number}; its entry is reversed.` : outcome.message };
}

// ---- Loaders

/** Σ active allocations per receipt. */
const allocatedByReceipt = () =>
  db
    .select({ receiptId: allocations.receiptId, paise: sql<string>`sum(${allocations.amountPaise})`.as("allocated_paise") })
    .from(allocations)
    .where(eq(allocations.active, true))
    .groupBy(allocations.receiptId)
    .as("allocated");

/** The receipts list; `range` (D68) = those dated in it, else all. */
export async function listReceipts(range?: Range) {
  const allocated = allocatedByReceipt();
  const rows = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      date: receipts.date,
      mode: receipts.mode,
      status: receipts.status,
      amount: receipts.amountPaise,
      allocated: allocated.paise,
      customer: customers.name,
      firmName: customers.firmName,
    })
    .from(receipts)
    .innerJoin(customers, eq(customers.id, receipts.customerId))
    .leftJoin(allocated, eq(allocated.receiptId, receipts.id))
    .where(dateIn(receipts.date, range))
    .orderBy(desc(receipts.id));
  return rows.map((r) => {
    const allocatedPaise = r.status === "active" ? BigInt(r.allocated ?? 0) : 0n;
    return { ...r, allocated: allocatedPaise, onAccount: r.status === "active" ? r.amount - allocatedPaise : 0n };
  });
}

const receiver = alias(users, "receiver");

export async function getReceipt(id: number) {
  const [row] = await db
    .select({ receipt: receipts, customer: customers, account: accounts.name, receivedBy: receiver.name })
    .from(receipts)
    .innerJoin(customers, eq(customers.id, receipts.customerId))
    .innerJoin(accounts, eq(accounts.id, receipts.moneyAccountId))
    .leftJoin(receiver, eq(receiver.id, receipts.receivedBy))
    .where(eq(receipts.id, id));
  if (!row) return undefined;
  const all = (
    await db
      .select({
        id: allocations.id,
        invoiceId: allocations.invoiceId,
        debitNoteId: allocations.debitNoteId,
        jobId: allocations.jobId,
        printJobId: allocations.printJobId,
        fromJobId: allocations.fromJobId,
        amount: allocations.amountPaise,
        active: allocations.active,
        changedAt: allocations.updatedAt,
        invoice: invoices.number,
        invoiceDate: invoices.date,
        invoiceTotal: invoices.totalPaise,
        debitNote: debitNotes.number,
        debitNoteDate: debitNotes.date,
        debitNoteTotal: debitNotes.totalPaise,
        job: jobs.number,
        jobDate: jobs.date,
        jobTotal: jobs.totalPaise,
        printJob: printJobs.number,
        printJobDate: printJobs.date,
        printJobTotal: printJobs.amountPaise,
        openingBillId: allocations.openingBillId, // T43
        openingBillNo: openingBills.billNo,
        openingBillDate: openingBills.billDate,
        openingBillTotal: openingBills.amountPaise,
        refundId: allocations.refundAdjustmentId, // paid back by a refund JV (D55)
        refund: adjustments.number,
        refundDate: adjustments.date,
        refundTotal: adjustments.amountPaise,
      })
      .from(allocations)
      .leftJoin(invoices, eq(invoices.id, allocations.invoiceId))
      .leftJoin(debitNotes, eq(debitNotes.id, allocations.debitNoteId))
      .leftJoin(jobs, eq(jobs.id, allocations.jobId))
      .leftJoin(printJobs, eq(printJobs.id, allocations.printJobId))
      .leftJoin(openingBills, eq(openingBills.id, allocations.openingBillId))
      .leftJoin(adjustments, eq(adjustments.id, allocations.refundAdjustmentId))
      .where(eq(allocations.receiptId, id))
      .orderBy(asc(allocations.id))
  ).map((l) => ({
    id: l.id,
    invoiceId: l.invoiceId,
    debitNoteId: l.debitNoteId,
    jobId: l.jobId,
    printJobId: l.printJobId,
    openingBillId: l.openingBillId,
    refundId: l.refundId,
    fromJobId: l.fromJobId,
    amount: l.amount,
    active: l.active,
    changedAt: l.changedAt,
    number: l.job ?? l.printJob ?? l.debitNote ?? l.invoice ?? l.refund ?? (l.openingBillNo ? openingBillLabel(l.openingBillNo) : ""),
    date: (l.jobDate ?? l.printJobDate ?? l.debitNoteDate ?? l.invoiceDate ?? l.refundDate ?? l.openingBillDate)!,
    total: (l.jobTotal ?? l.printJobTotal ?? l.debitNoteTotal ?? l.invoiceTotal ?? l.refundTotal ?? l.openingBillTotal)!,
  }));
  const lines = all.filter((l) => l.active);
  const allocated = lines.reduce((s, l) => s + l.amount, 0n);
  const r = row.receipt;
  return {
    ...r,
    customer: row.customer,
    account: row.account,
    receivedByName: row.receivedBy,
    lines,
    removed: all.filter((l) => !l.active), // deactivated by an edit / cancel (D49), kept for the trail
    allocated,
    onAccount: r.status === "active" ? r.amountPaise - allocated : 0n,
  };
}

/**
 * The money paying a target (live allocations), oldest first: receipts, credit notes applied to it (D50) and write-off /
 * discount JVs (D55; a receipt has `mode`, a JV `kind`, a credit note neither). fromJob = a job's advance moved onto an invoice.
 */
async function paymentsTo(target: SQL) {
  const date = sql<string>`coalesce(${receipts.date}, ${creditNotes.date}, ${adjustments.date})`;
  const rows = await db
    .select({
      receiptId: allocations.receiptId,
      creditNoteId: allocations.creditNoteId,
      adjustmentId: allocations.adjustmentId,
      number: sql<string>`coalesce(${receipts.number}, ${creditNotes.number}, ${adjustments.number})`,
      date,
      mode: receipts.mode,
      kind: adjustments.kind,
      amount: allocations.amountPaise,
      fromJob: jobs.number,
    })
    .from(allocations)
    .leftJoin(receipts, eq(receipts.id, allocations.receiptId))
    .leftJoin(creditNotes, eq(creditNotes.id, allocations.creditNoteId))
    .leftJoin(adjustments, eq(adjustments.id, allocations.adjustmentId))
    .leftJoin(jobs, eq(jobs.id, allocations.fromJobId))
    .where(and(target, liveAllocation()))
    .orderBy(date, asc(allocations.id));
  return rows.map((r) => ({
    ...r,
    href:
      r.receiptId !== null
        ? `/receipts/${r.receiptId}`
        : r.adjustmentId !== null
          ? `/journal-vouchers/${r.adjustmentId}`
          : `/credit-debit-notes/cn/${r.creditNoteId}`,
  }));
}

/** What pays an invoice; its own credit notes are left out (the Payments tab lists them as notes). */
export const invoicePayments = (invoiceId: number) =>
  paymentsTo(
    and(
      eq(allocations.invoiceId, invoiceId),
      notExists(
        db
          .select({ one: sql`1` })
          .from(creditNotes)
          .where(and(eq(creditNotes.id, allocations.creditNoteId), eq(creditNotes.invoiceId, invoiceId))),
      ),
    )!,
  );

/** What pays a debit note (T16). */
export const debitNotePayments = (noteId: number) => paymentsTo(eq(allocations.debitNoteId, noteId));

/** A job's advances in force (S12). */
export const jobAdvances = (jobId: number) => paymentsTo(eq(allocations.jobId, jobId));

/** The money for a print job (D64): on it, or moved onto the invoice that billed it. */
export const printJobPayments = (printJobId: number) =>
  paymentsTo(or(eq(allocations.printJobId, printJobId), eq(allocations.fromPrintJobId, printJobId))!);

/** Pick lists for the receipt form: active customers (plus this receipt's), money accounts, staff. */
export async function receiptFormOptions(keepCustomerId?: number) {
  const [all, money, staff] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, firmName: customers.firmName, active: customers.active })
      .from(customers)
      .orderBy(asc(customers.name)),
    moneyAccounts(),
    staffOptions(),
  ]);
  return {
    customers: all
      .filter((c) => c.active || c.id === keepCustomerId)
      .map((c) => ({ id: c.id, name: c.name, firmName: c.firmName })),
    accounts: money.map((a) => ({ id: a.id, name: a.name, systemKey: a.systemKey })),
    staff,
  };
}
