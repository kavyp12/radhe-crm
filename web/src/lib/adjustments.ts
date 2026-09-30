import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  accounts,
  ADJUSTMENT_KINDS,
  adjustmentLines,
  adjustments,
  allocations,
  creditNotes,
  customers,
  debitNotes,
  expenseCategories,
  invoices,
  jobs,
  receipts,
  users,
  vendors,
} from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { checkAllocations, deactivate, lockSource, onAccountSources, readAllocations, type OnAccountSource } from "@/lib/allocations";
import { needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse } from "@/lib/ledger";
import { formatMoney, parseMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";

// Adjustment entries (JV, S22, A§3, A§7, A§8, D55): numbered JV/ and posted as entered; the lines must balance
// (checked here, again in post() and by the DB at commit). A customer adjustment is a guided JV for one customer:
//   write-off            Dr bad_debts        / Cr ar (customer)   } allocated to the invoices / debit notes they settle
//   settlement discount  Dr discount_allowed / Cr ar (customer)   }
//   refund of credit     Dr ar (customer)    / Cr a money account — uses up on-account money (receipt rests, credit-note
//                        leftovers): those allocations point at the refund, and it can't be more than there is.
// Anyone but the owner goes through approval, always. No edit: cancel = reverse on its own date (D45), same approval
// rule; its allocations are deactivated (D49), so the invoices / the on-account money come back.

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export const ADJUSTMENT_KIND: Record<AdjustmentKind, string> = {
  journal: "Journal voucher",
  write_off: "Write-off",
  discount: "Settlement discount",
  refund: "Refund",
};
export type CustomerAdjustmentKind = Exclude<AdjustmentKind, "journal">;

/** The form as typed. A JV fills `lines`; a customer adjustment customerId, amount, allocations (+ moneyAccountId: refund). */
export type AdjustmentInput = {
  kind: string;
  date: string;
  narration: string;
  /** JSON of { accountId, debit, credit, customerId, vendorId, jobId } (text as typed); blank rows are skipped. */
  lines: string;
  customerId: string;
  amount: string;
  moneyAccountId: string;
  /** JSON of { target, id, amount }: invoice / debit_note settled (write-off, discount), receipt / credit_note refunded. */
  allocations: string;
};

type Line = {
  accountId: number;
  account: string;
  debit: bigint;
  credit: bigint;
  customerId: number | null;
  vendorId: number | null;
  jobId: number | null;
  party: string | null; // customer / vendor / job, for the approval request
};
type Allocation = { target: "invoice" | "debit_note" | "receipt" | "credit_note"; id: number; number: string; amount: bigint };

const MAX_LINES = 100;

function parseRows(json: string): Record<string, unknown>[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || "[]");
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  return raw.map((r) => (r ?? {}) as Record<string, unknown>);
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const idOf = (v: unknown) => (text(v) ? Number(text(v)) : null);

/** A JV's lines: any active account (inactive expense categories' accounts are out), Dr or Cr, optional tags. */
async function readJournalLines(tx: Tx, json: string): Promise<Line[]> {
  const rows = parseRows(json).filter((o) => ["accountId", "debit", "credit"].some((k) => text(o[k])));
  if (rows.length > MAX_LINES) throw new UserError(`A JV can have ${MAX_LINES} lines at most.`, "lines");
  if (rows.length < 2) throw new UserError("Enter at least two lines: something debited, something credited.", "lines");

  const all = await tx
    .select({ id: accounts.id, name: accounts.name, key: accounts.systemKey, active: expenseCategories.active })
    .from(accounts)
    .leftJoin(expenseCategories, eq(expenseCategories.accountId, accounts.id));
  const ids = (key: string) => [...new Set(rows.map((o) => idOf(o[key])).filter((n): n is number => n !== null && Number.isSafeInteger(n)))];
  const [customerRows, vendorRows, jobRows] = await Promise.all([
    ids("customerId").length ? tx.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, ids("customerId"))) : [],
    ids("vendorId").length ? tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, ids("vendorId"))) : [],
    ids("jobId").length ? tx.select({ id: jobs.id, number: jobs.number, status: jobs.status }).from(jobs).where(inArray(jobs.id, ids("jobId"))) : [],
  ]);

  const lines = rows.map((o, i): Line => {
    const fail = (message: string): never => {
      throw new UserError(`Line ${i + 1}: ${message}`, "lines");
    };
    const money = (key: "debit" | "credit") => {
      const t = text(o[key]);
      if (!t) return 0n;
      let paise = 0n;
      try {
        paise = parseMoney(t);
      } catch {
        fail(`enter the ${key} like 1,250.50 (not "${t}").`);
      }
      if (paise < 0n) fail(`a ${key} can't be negative.`);
      return paise;
    };
    const [debit, credit] = [money("debit"), money("credit")];
    if ((debit > 0n) === (credit > 0n)) fail("enter a debit or a credit (one of them).");
    const account = all.find((a) => a.id === idOf(o.accountId));
    if (!account || account.active === false) fail("pick the account.");
    const pick = <T extends { id: number }>(key: string, list: T[], what: string) => {
      const id = idOf(o[key]);
      if (id === null) return null;
      const found = list.find((x) => x.id === id);
      if (!found) fail(`pick the ${what} again (or leave it blank).`);
      return found!;
    };
    const customer = pick("customerId", customerRows, "customer");
    const vendor = pick("vendorId", vendorRows, "vendor");
    const job = pick("jobId", jobRows, "job");
    if (job?.status === "cancelled") fail(`job ${job.number} is cancelled.`);
    // Sub-ledgers must add up to their control accounts (customer statements, vendor ledgers, T28 outstanding).
    if (account!.key === "ar" && !customer) fail("an Accounts Receivable line needs the customer.");
    if (account!.key === "ap" && !vendor) fail("an Accounts Payable line needs the vendor.");
    return {
      accountId: account!.id,
      account: account!.name,
      debit,
      credit,
      customerId: customer?.id ?? null,
      vendorId: vendor?.id ?? null,
      jobId: job?.id ?? null,
      party: [customer?.name, vendor?.name, job && `job ${job.number}`].filter(Boolean).join(" · ") || null,
    };
  });
  const [dr, cr] = [lines.reduce((s, l) => s + l.debit, 0n), lines.reduce((s, l) => s + l.credit, 0n)];
  if (dr !== cr) {
    throw new UserError(`Debits ${formatMoney(dr)} and credits ${formatMoney(cr)} don't match: the entry must balance.`, "lines");
  }
  return lines;
}

/** Refund sources as typed (JSON of { target: "receipt" | "credit_note", id, amount }); blank / zero skipped. */
function readRefundSources(json: string): { source: OnAccountSource; amount: bigint }[] {
  const out: { source: OnAccountSource; amount: bigint }[] = [];
  for (const o of parseRows(json)) {
    const t = text(o.amount);
    if (!t) continue;
    let amount = 0n;
    try {
      amount = parseMoney(t);
    } catch {
      throw new UserError(`Enter amounts like 2,000 or 1,250.50 (not "${t}").`, "allocations");
    }
    if (amount < 0n) throw new UserError("An amount can't be negative.", "allocations");
    if (amount === 0n) continue;
    const id = Number(o.id);
    const kind = o.target === "receipt" || o.target === "credit_note" ? o.target : null;
    if (!kind || !Number.isSafeInteger(id) || id < 1) throw new UserError("The allocations couldn't be read: reload the page.", "allocations");
    out.push({ source: { kind, id }, amount });
  }
  if (new Set(out.map((s) => `${s.source.kind}:${s.source.id}`)).size !== out.length) {
    throw new UserError("Put each receipt or credit note on one line only.", "allocations");
  }
  return out;
}

async function readAdjustment(tx: Tx, input: AdjustmentInput) {
  const kind = ADJUSTMENT_KINDS.find((k) => k === input.kind);
  if (!kind) throw new Error(`Unknown adjustment kind "${input.kind}"`);
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const typed = formText(input.narration, "narration", 500);

  if (kind === "journal") {
    if (!typed) throw new UserError("Say what the entry is for.", "narration");
    const lines = await readJournalLines(tx, input.lines);
    return { kind, date, narration: typed, customer: null, lines, allocations: [] as Allocation[], amount: lines.reduce((s, l) => s + l.debit, 0n) };
  }

  const customerId = Number(input.customerId);
  const [customer] = Number.isSafeInteger(customerId) ? await tx.select().from(customers).where(eq(customers.id, customerId)) : [];
  if (!customer) throw new UserError("Pick the customer.", "customerId");
  const amount = formMoney(input.amount, "amount");
  if (amount === null || amount <= 0n) throw new UserError("Enter the amount.", "amount");
  const narration = typed ?? `${ADJUSTMENT_KIND[kind]} · ${customer.name}`;
  const [ar] = await tx.select().from(accounts).where(eq(accounts.systemKey, "ar"));
  const arLine = { accountId: ar.id, account: ar.name, customerId: customer.id, vendorId: null, jobId: null, party: customer.name };
  let allocated: Allocation[];
  let other: Line;

  if (kind === "refund") {
    const accountId = Number(input.moneyAccountId);
    const [account] = Number.isSafeInteger(accountId)
      ? await tx.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isMoney, true)))
      : [];
    if (!account) throw new UserError("Pick the account the money was paid from.", "moneyAccountId");
    const onAccount = (await onAccountSources(tx, customer.id)).reduce((s, x) => s + x.rest, 0n);
    if (amount > onAccount) {
      throw new UserError(`${formatMoney(amount)} is more than the ${formatMoney(onAccount)} ${customer.name} has on account.`, "amount");
    }
    // Lock receipts, then credit notes, by id: two refunds / applies of the same money queue (no deadlock).
    const sources = readRefundSources(input.allocations).sort((a, b) =>
      a.source.kind !== b.source.kind ? (a.source.kind === "receipt" ? -1 : 1) : a.source.id - b.source.id,
    );
    allocated = [];
    for (const s of sources) {
      const locked = await lockSource(tx, customer.id, s.source);
      if (s.amount > locked.rest) {
        throw new UserError(`${locked.number}: ${formatMoney(s.amount)} is more than the ${formatMoney(locked.rest)} it has on account.`, "allocations");
      }
      allocated.push({ target: s.source.kind, id: s.source.id, number: locked.number, amount: s.amount });
    }
    other = { accountId: account.id, account: account.name, debit: 0n, credit: amount, customerId: null, vendorId: null, jobId: null, party: null };
  } else {
    const lines = readAllocations(input.allocations);
    if (lines.some((l) => l.target === "job")) throw new UserError("A write-off or discount settles invoices and debit notes only.", "allocations");
    allocated = (await checkAllocations(tx, customer.id, amount, lines)).map((l) => ({ ...l, target: l.target as "invoice" | "debit_note" }));
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.systemKey, kind === "write_off" ? "bad_debts" : "discount_allowed"));
    other ={ accountId: account.id, account: account.name, debit: amount, credit: 0n, customerId: null, vendorId: null, jobId: null, party: null };
  }
  const total = allocated.reduce((s, a) => s + a.amount, 0n);
  if (total !== amount) {
    const what = kind === "refund" ? "the receipts / credit notes it pays back" : "the invoices / debit notes it settles";
    throw new UserError(`Put the whole ${formatMoney(amount)} on ${what}: ${formatMoney(total)} is allocated.`, "allocations");
  }
  const lines: Line[] = kind === "refund" ? [{ ...arLine, debit: amount, credit: 0n }, other] : [other, { ...arLine, debit: 0n, credit: amount }];
  return { kind, date, narration, customer, lines, allocations: allocated, amount };
}

type Read = Awaited<ReturnType<typeof readAdjustment>>;

const linesText = (lines: Line[]) =>
  lines.map((l) => `${l.debit ? "Dr" : "Cr"} ${l.account}${l.party ? ` (${l.party})` : ""} ${formatMoney(l.debit || l.credit)}`).join("\n");
const allocationText = (list: Allocation[]) => list.map((a) => `${a.number} ${formatMoney(a.amount)}`).join(" · ");

async function doCreate(tx: Tx, actor: SessionUser, input: AdjustmentInput) {
  const r = await readAdjustment(tx, input);
  const number = await nextNumber(tx, "adjustment", r.date);
  const [row] = await tx
    .insert(adjustments)
    .values({ number, date: r.date, kind: r.kind, customerId: r.customer?.id ?? null, narration: r.narration, amountPaise: r.amount, createdBy: actor.id })
    .returning({ id: adjustments.id });
  await tx.insert(adjustmentLines).values(
    r.lines.map((l) => ({
      adjustmentId: row.id,
      accountId: l.accountId,
      debitPaise: l.debit,
      creditPaise: l.credit,
      customerId: l.customerId,
      vendorId: l.vendorId,
      jobId: l.jobId,
    })),
  );
  await post(tx, {
    date: r.date,
    docType: "adjustments",
    docId: row.id,
    number,
    narration: r.narration,
    lines: r.lines.map((l) => ({
      account: l.accountId,
      debit: l.debit,
      credit: l.credit,
      customerId: l.customerId ?? undefined,
      vendorId: l.vendorId ?? undefined,
      jobId: l.jobId ?? undefined,
    })),
  });
  if (r.allocations.length) {
    await tx.insert(allocations).values(
      r.allocations.map((a) => ({
        receiptId: a.target === "receipt" ? a.id : null,
        creditNoteId: a.target === "credit_note" ? a.id : null,
        adjustmentId: a.target === "invoice" || a.target === "debit_note" ? row.id : null,
        invoiceId: a.target === "invoice" ? a.id : null,
        debitNoteId: a.target === "debit_note" ? a.id : null,
        refundAdjustmentId: a.target === "receipt" || a.target === "credit_note" ? row.id : null,
        amountPaise: a.amount,
        createdBy: actor.id,
      })),
    );
  }
  return { id: row.id, number };
}

function summary(r: Read) {
  const what = r.customer ? `${ADJUSTMENT_KIND[r.kind]} ${formatMoney(r.amount)} · ${r.customer.name}` : `Journal voucher ${formatMoney(r.amount)}`;
  return `${what}, dated ${formatDate(r.date)}`;
}

type CreatePayload = { input: AdjustmentInput };

registerExecutor<CreatePayload>("adjustment.create", {
  async describe(tx, p) {
    const r = await readAdjustment(tx, p.input);
    return {
      summary: summary(r),
      changes: [
        { label: "Date", old: null, new: formatDate(r.date) },
        { label: "Narration", old: null, new: r.narration },
        { label: "Entry", old: null, new: linesText(r.lines) },
        ...(r.allocations.length ? [{ label: r.kind === "refund" ? "Pays back" : "Settles", old: null, new: allocationText(r.allocations) }] : []),
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

const backdated = (date: string) => `Dated ${formatDate(date)}, before the backdate window`;

/** Save a JV / customer adjustment: the owner at once (numbered + posted), anyone else → an approval request, always. */
export async function createAdjustment(actor: SessionUser, input: AdjustmentInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "books", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  const reason = (await needsBackdateApproval(date)) ? backdated(date) : "";
  const outcome = await runOrRequest(actor, "adjustment.create", { input } satisfies CreatePayload, reason);
  if (!outcome.done) return { id: null, message: outcome.message };
  const done = outcome.result as { id: number; number: string };
  return { id: done.id, message: `Saved ${done.number}.` };
}

type CancelPayload = { id: number };

async function describeCancel(q: Tx, id: number) {
  const [a] = await q.select().from(adjustments).where(eq(adjustments.id, id));
  if (!a) throw new UserError("That JV doesn't exist.");
  if (a.status !== "active") throw new UserError("This JV is already cancelled.");
  return a;
}

/** Reverse on its own date (D45), mark it cancelled, deactivate its allocations (invoices reopen / money back on account). */
async function doCancel(tx: Tx, p: CancelPayload) {
  const [a] = await tx.select().from(adjustments).where(eq(adjustments.id, p.id)).for("update");
  if (!a) throw new UserError("That JV doesn't exist.");
  if (a.status !== "active") throw new UserError("This JV is already cancelled.");
  const entry = await liveEntry(tx, "adjustments", a.id);
  if (!entry) throw new Error(`JV ${a.id} has no journal entry in force`);
  await reverse(tx, entry.id, a.date);
  await tx.update(adjustments).set({ status: "cancelled" }).where(eq(adjustments.id, a.id));
  const rows = await tx
    .select({ id: allocations.id })
    .from(allocations)
    .where(and(or(eq(allocations.adjustmentId, a.id), eq(allocations.refundAdjustmentId, a.id)), eq(allocations.active, true)));
  await deactivate(tx, rows.map((r) => r.id));
}

registerExecutor<CancelPayload>("adjustment.cancel", {
  async describe(tx, p) {
    const a = await describeCancel(tx, p.id);
    const after = { write_off: "The invoices it settled are open again", discount: "The invoices it settled are open again", refund: "The money it paid back is on account again" };
    return {
      summary: `Cancel ${a.number} (${ADJUSTMENT_KIND[a.kind]}, ${formatMoney(a.amountPaise)})`,
      target: { type: "adjustments", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(a.date)}` },
        ...(a.kind === "journal" ? [] : [{ label: "Allocations", old: null, new: after[a.kind] }]),
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

/** Cancel: the owner at once, anyone else through approval (like the JV itself). */
export async function cancelAdjustment(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "books", "cancel")) throw new Error("Not allowed");
  const [a] = await db.select().from(adjustments).where(eq(adjustments.id, id));
  if (!a) throw new UserError("That JV doesn't exist.");
  if (a.status !== "active") throw new UserError("This JV is already cancelled.");
  const why = reason.trim() || ((await needsBackdateApproval(a.date)) ? backdated(a.date) : "");
  const outcome = await runOrRequest(actor, "adjustment.cancel", { id } satisfies CancelPayload, why);
  return { message: outcome.done ? `Cancelled ${a.number}; its entry is reversed.` : outcome.message };
}

// ---- Loaders

export async function listAdjustments() {
  return db
    .select({
      id: adjustments.id,
      number: adjustments.number,
      date: adjustments.date,
      kind: adjustments.kind,
      customer: customers.name,
      narration: adjustments.narration,
      amount: adjustments.amountPaise,
      status: adjustments.status,
    })
    .from(adjustments)
    .leftJoin(customers, eq(customers.id, adjustments.customerId))
    .orderBy(desc(adjustments.id));
}

export async function getAdjustment(id: number) {
  const [row] = await db
    .select({ adjustment: adjustments, customer: customers.name, createdBy: users.name })
    .from(adjustments)
    .leftJoin(customers, eq(customers.id, adjustments.customerId))
    .leftJoin(users, eq(users.id, adjustments.createdBy))
    .where(eq(adjustments.id, id));
  if (!row) return undefined;
  const [lines, links] = await Promise.all([
    db
      .select({
        id: adjustmentLines.id,
        account: accounts.name,
        code: accounts.code,
        debit: adjustmentLines.debitPaise,
        credit: adjustmentLines.creditPaise,
        customerId: adjustmentLines.customerId,
        customer: customers.name,
        vendorId: adjustmentLines.vendorId,
        vendor: vendors.name,
        jobId: adjustmentLines.jobId,
        job: jobs.number,
      })
      .from(adjustmentLines)
      .innerJoin(accounts, eq(accounts.id, adjustmentLines.accountId))
      .leftJoin(customers, eq(customers.id, adjustmentLines.customerId))
      .leftJoin(vendors, eq(vendors.id, adjustmentLines.vendorId))
      .leftJoin(jobs, eq(jobs.id, adjustmentLines.jobId))
      .where(eq(adjustmentLines.adjustmentId, id))
      .orderBy(asc(adjustmentLines.id)),
    db
      .select({
        id: allocations.id,
        amount: allocations.amountPaise,
        active: allocations.active,
        changedAt: allocations.updatedAt,
        invoiceId: allocations.invoiceId,
        invoice: invoices.number,
        invoiceDate: invoices.date,
        debitNoteId: allocations.debitNoteId,
        debitNote: debitNotes.number,
        debitNoteDate: debitNotes.date,
        receiptId: allocations.receiptId,
        receipt: receipts.number,
        receiptDate: receipts.date,
        creditNoteId: allocations.creditNoteId,
        creditNote: creditNotes.number,
        creditNoteDate: creditNotes.date,
      })
      .from(allocations)
      .leftJoin(invoices, eq(invoices.id, allocations.invoiceId))
      .leftJoin(debitNotes, eq(debitNotes.id, allocations.debitNoteId))
      .leftJoin(receipts, eq(receipts.id, allocations.receiptId))
      .leftJoin(creditNotes, eq(creditNotes.id, allocations.creditNoteId))
      .where(or(eq(allocations.adjustmentId, id), eq(allocations.refundAdjustmentId, id)))
      .orderBy(asc(allocations.id)),
  ]);
  const allocated = links.map((l) => ({
    id: l.id,
    amount: l.amount,
    active: l.active,
    changedAt: l.changedAt,
    number: l.invoice ?? l.debitNote ?? l.receipt ?? l.creditNote ?? "",
    date: (l.invoiceDate ?? l.debitNoteDate ?? l.receiptDate ?? l.creditNoteDate)!,
    href:
      l.invoiceId !== null
        ? `/invoices/${l.invoiceId}`
        : l.debitNoteId !== null
          ? `/credit-debit-notes/dn/${l.debitNoteId}`
          : l.receiptId !== null
            ? `/receipts/${l.receiptId}`
            : `/credit-debit-notes/cn/${l.creditNoteId}`,
    what: l.invoiceId !== null ? "Invoice" : l.debitNoteId !== null ? "Debit note" : l.receiptId !== null ? "Receipt" : "Credit note",
  }));
  return { ...row.adjustment, customer: row.customer, createdByName: row.createdBy, lines, allocated };
}

/** The JV form's pick lists: accounts (not those of inactive expense categories), active customers / vendors, open jobs. */
export async function journalFormOptions() {
  const [accountRows, customerRows, vendorRows, jobRows] = await Promise.all([
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, active: expenseCategories.active })
      .from(accounts)
      .leftJoin(expenseCategories, eq(expenseCategories.accountId, accounts.id))
      .orderBy(asc(accounts.code)),
    db.select({ id: customers.id, name: customers.name, active: customers.active }).from(customers).orderBy(asc(customers.name)),
    db.select({ id: vendors.id, name: vendors.name, active: vendors.active }).from(vendors).orderBy(asc(vendors.name)),
    db
      .select({ id: jobs.id, number: jobs.number, customer: customers.name })
      .from(jobs)
      .innerJoin(customers, eq(customers.id, jobs.customerId))
      .where(sql`${jobs.status} <> 'cancelled'`)
      .orderBy(desc(jobs.id)),
  ]);
  return {
    accounts: accountRows.filter((a) => a.active !== false).map((a) => ({ id: a.id, name: `${a.code} · ${a.name}`, type: a.type })),
    customers: customerRows.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
    vendors: vendorRows.filter((v) => v.active).map((v) => ({ id: v.id, name: v.name })),
    jobs: jobRows.map((j) => ({ id: j.id, name: `${j.number} · ${j.customer}` })),
  };
}
