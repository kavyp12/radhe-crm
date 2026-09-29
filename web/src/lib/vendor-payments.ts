import { and, asc, desc, eq, inArray, isNotNull, notExists, sql, type SQL } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { accounts, purchaseBills, vendorAllocations, vendorPayments, vendors } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { paymentStatus, type PaymentStatus } from "@/lib/allocations";
import { type Change, needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, fyKey, parseDate } from "@/lib/dates";
import { checkBooksDate, liveEntry, moneyAccounts, post, reverse } from "@/lib/ledger";
import { formatMoney, parseMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { RECEIPT_MODE, RECEIPT_MODES } from "@/lib/receipt-modes";
import { checkVersion, readDate } from "@/lib/sales";

// Vendor payments (S9, A§2, A§3, A§5, D49, D51): money out to a vendor, numbered VP/ and posted on save (Dr ap /
// Cr money account). Vendor allocations link it to the vendor's purchase bills, oldest bill first; what isn't
// allocated is on account. Allocations never post and are never deleted. Bill statuses are computed from them
// (A§5), never stored. Edit / cancel: the owner at once, anyone else through approval; a backdated save by a
// non-owner is a request too. What is on account is put on bills later for free (applyVendorOnAccount, D52).

type Q = Tx | typeof db;
type Payment = typeof vendorPayments.$inferSelect;

// ---- Allocations and bill status

/** Active rows of payments that aren't cancelled. */
const liveVendorAllocation = (): SQL =>
  and(
    eq(vendorAllocations.active, true),
    notExists(
      db
        .select({ one: sql`1` })
        .from(vendorPayments)
        .where(and(eq(vendorPayments.id, vendorAllocations.paymentId), eq(vendorPayments.status, "cancelled"))),
    ),
  )!;

/** Σ live allocations per bill, leaving out one payment's own (the payment being edited). */
export async function paidTowardsBills(q: Q, billIds: number[], exceptPaymentId?: number): Promise<Map<number, bigint>> {
  if (!billIds.length) return new Map();
  const rows = await q
    .select({ id: vendorAllocations.purchaseBillId, paise: sql<string>`sum(${vendorAllocations.amountPaise})` })
    .from(vendorAllocations)
    .where(
      and(
        liveVendorAllocation(),
        inArray(vendorAllocations.purchaseBillId, billIds),
        exceptPaymentId ? sql`${vendorAllocations.paymentId} <> ${exceptPaymentId}` : undefined,
      ),
    )
    .groupBy(vendorAllocations.purchaseBillId);
  return new Map(rows.map((r) => [r.id, BigInt(r.paise)]));
}

/** Σ live allocations per bill, as a subquery to join in lists. */
export const paidByBill = () =>
  db
    .select({ billId: vendorAllocations.purchaseBillId, paise: sql<string>`sum(${vendorAllocations.amountPaise})`.as("bill_paid_paise") })
    .from(vendorAllocations)
    .where(and(liveVendorAllocation(), isNotNull(vendorAllocations.purchaseBillId)))
    .groupBy(vendorAllocations.purchaseBillId)
    .as("bill_paid");

/** A§5 for vendor bills: Cancelled; open 0 → Paid; past the due date → Overdue; partly paid → Part Payment; else Unpaid. */
export const billStatus = (bill: { status: string; totalPaise: bigint; dueDate: string }, open: bigint, today?: string): PaymentStatus =>
  paymentStatus({ ...bill, status: bill.status === "active" ? "issued" : "cancelled" }, open, today)!;

/** A vendor's live bills with something still open, oldest bill date first, then number (D49, D51). */
export async function openBills(q: Q, vendorId: number, exceptPaymentId?: number) {
  const rows = await q
    .select({ id: purchaseBills.id, number: purchaseBills.number, vendorBillNo: purchaseBills.vendorBillNo, date: purchaseBills.date, dueDate: purchaseBills.dueDate, total: purchaseBills.totalPaise })
    .from(purchaseBills)
    .where(and(eq(purchaseBills.vendorId, vendorId), eq(purchaseBills.status, "active")))
    .orderBy(asc(purchaseBills.date), asc(purchaseBills.number));
  const paid = await paidTowardsBills(q, rows.map((r) => r.id), exceptPaymentId);
  return rows.map((r) => ({ ...r, open: r.total - (paid.get(r.id) ?? 0n) })).filter((r) => r.open > 0n);
}

export type BillAllocation = { billId: number; amount: bigint };

/** The panel as typed (JSON of { id, amount }) → lines; blank / zero skipped; each bill once. */
export function readBillAllocations(json: string): BillAllocation[] {
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
  const lines: BillAllocation[] = [];
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
    const billId = Number(o.id);
    if (!Number.isSafeInteger(billId) || billId < 1) fail("The allocations couldn't be read: reload the page.");
    lines.push({ billId, amount });
  }
  if (new Set(lines.map((l) => l.billId)).size !== lines.length) fail("Put each bill on one line only.");
  return lines;
}

/**
 * Locks the bills (id order) and refuses a total over `available`, a line over its bill's open amount, or a bill that
 * isn't this vendor's live bill (D51: two payments can't both take the same open amount).
 */
export async function checkBillAllocations(tx: Tx, vendorId: number, available: bigint, lines: BillAllocation[], exceptPaymentId?: number) {
  const total = lines.reduce((s, l) => s + l.amount, 0n);
  if (total > available) {
    throw new UserError(`${formatMoney(total)} allocated is more than the ${formatMoney(available)} paid.`, "allocations");
  }
  const billIds = lines.map((l) => l.billId).sort((a, b) => a - b);
  const bills = billIds.length
    ? await tx.select().from(purchaseBills).where(inArray(purchaseBills.id, billIds)).orderBy(asc(purchaseBills.id)).for("update")
    : [];
  const paid = await paidTowardsBills(tx, billIds, exceptPaymentId);
  return lines.map((l) => {
    const b = bills.find((x) => x.id === l.billId);
    if (!b || b.vendorId !== vendorId) throw new UserError("A bill here isn't this vendor's: reload the page.", "allocations");
    if (b.status !== "active") throw new UserError(`Bill ${b.number} is cancelled.`, "allocations");
    const open = b.totalPaise - (paid.get(b.id) ?? 0n);
    if (l.amount > open) throw new UserError(`${b.number}: ${formatMoney(l.amount)} is more than its open ${formatMoney(open)}.`, "allocations");
    return { ...l, number: b.number };
  });
}

const deactivate = async (tx: Tx, ids: number[]) => {
  if (ids.length) await tx.update(vendorAllocations).set({ active: false }).where(inArray(vendorAllocations.id, ids));
};

/** A cancelled bill: what was allocated to it goes back on account with its payments (D49). */
export async function releaseBill(tx: Tx, billId: number) {
  const rows = await tx
    .select({ id: vendorAllocations.id })
    .from(vendorAllocations)
    .where(and(eq(vendorAllocations.purchaseBillId, billId), eq(vendorAllocations.active, true)));
  await deactivate(tx, rows.map((r) => r.id));
}

// ---- Payments

/** The form as typed. allocations = JSON of { id (bill), amount }[]. */
export type VendorPaymentInput = {
  vendorId: string;
  date: string;
  amount: string;
  mode: string;
  moneyAccountId: string;
  reference: string;
  chequeNo: string;
  chequeDate: string;
  notes: string;
  allocations: string;
};

async function readPayment(tx: Tx, input: VendorPaymentInput, current?: Payment) {
  const vendorId = Number(input.vendorId);
  const [vendor] = Number.isSafeInteger(vendorId) ? await tx.select().from(vendors).where(eq(vendors.id, vendorId)) : [];
  if (!vendor) throw new UserError("Pick the vendor.", "vendorId");
  if (!vendor.active && vendor.id !== current?.vendorId) throw new UserError("This vendor is inactive.", "vendorId");
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const amountPaise = formMoney(input.amount, "amount");
  if (amountPaise === null || amountPaise <= 0n) throw new UserError("Enter the amount paid.", "amount");
  const mode = RECEIPT_MODES.find((m) => m === input.mode);
  if (!mode) throw new UserError("Pick how it was paid.", "mode");
  const accountId = Number(input.moneyAccountId);
  const [account] = Number.isSafeInteger(accountId)
    ? await tx.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isMoney, true)))
    : [];
  if (!account) throw new UserError("Pick the account the money went out of.", "moneyAccountId");
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
  const lines = await checkBillAllocations(tx, vendor.id, amountPaise, readBillAllocations(input.allocations), current?.id);
  return {
    vendor,
    account,
    lines,
    values: {
      vendorId: vendor.id,
      date,
      amountPaise,
      mode,
      moneyAccountId: account.id,
      reference: formText(input.reference, "reference", 100),
      chequeNo,
      chequeDate,
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

type Values = Awaited<ReturnType<typeof readPayment>>["values"];

/** A§3: Dr ap (vendor) / Cr the money account. */
const postPayment = (tx: Tx, id: number, number: string, v: Values, vendorName: string) =>
  post(tx, {
    date: v.date,
    docType: "vendor_payments",
    docId: id,
    number,
    narration: `Vendor payment ${number} · ${vendorName}`,
    lines: [
      { account: "ap", vendorId: v.vendorId, debit: v.amountPaise },
      { account: v.moneyAccountId, credit: v.amountPaise },
    ],
  });

const insertAllocations = (tx: Tx, paymentId: number, lines: BillAllocation[], by: SessionUser) =>
  lines.length
    ? tx.insert(vendorAllocations).values(lines.map((l) => ({ paymentId, purchaseBillId: l.billId, amountPaise: l.amount, createdBy: by.id })))
    : Promise.resolve();

/** "PB/26-27/0001 ₹20,000.00 · on account ₹5,000.00". */
function allocationText(lines: { number: string; amount: bigint }[], amount: bigint) {
  const rest = amount - lines.reduce((s, l) => s + l.amount, 0n);
  const parts = lines.map((l) => `${l.number} ${formatMoney(l.amount)}`);
  if (rest > 0n) parts.push(`on account ${formatMoney(rest)}`);
  return parts.join(" · ");
}

async function doCreate(tx: Tx, actor: SessionUser, input: VendorPaymentInput) {
  const r = await readPayment(tx, input);
  const number = await nextNumber(tx, "vendor_payment", r.values.date);
  const [row] = await tx.insert(vendorPayments).values({ ...r.values, number, createdBy: actor.id }).returning({ id: vendorPayments.id });
  await postPayment(tx, row.id, number, r.values, r.vendor.name);
  await insertAllocations(tx, row.id, r.lines, actor);
  return { id: row.id, number };
}

type CreatePayload = { input: VendorPaymentInput };

registerExecutor<CreatePayload>("vendor_payment.create", {
  async describe(tx, p) {
    const r = await readPayment(tx, p.input);
    return {
      summary: `Vendor payment ${formatMoney(r.values.amountPaise)} to ${r.vendor.name}, dated ${formatDate(r.values.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(r.values.date) },
        { label: "Amount", old: null, new: formatMoney(r.values.amountPaise) },
        { label: "Mode", old: null, new: `${RECEIPT_MODE[r.values.mode]} ← ${r.account.name}` },
        { label: "Allocated", old: null, new: allocationText(r.lines, r.values.amountPaise) || "on account" },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

/** Save a payment: numbered, posted and allocated in one transaction; a non-owner's backdated one → a request. */
export async function createVendorPayment(actor: SessionUser, input: VendorPaymentInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "payments", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "vendor_payment.create", { input } satisfies CreatePayload, `Dated ${formatDate(date)}, before the backdate window`);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lock(tx: Tx, id: number) {
  const [p] = await tx.select().from(vendorPayments).where(eq(vendorPayments.id, id)).for("update");
  if (!p) throw new UserError("That payment doesn't exist.");
  return p;
}

/** The payment's allocations in force, with their bill numbers. */
const currentLines = (tx: Tx, paymentId: number) =>
  tx
    .select({ id: vendorAllocations.id, billId: vendorAllocations.purchaseBillId, amount: vendorAllocations.amountPaise, number: purchaseBills.number })
    .from(vendorAllocations)
    .innerJoin(purchaseBills, eq(purchaseBills.id, vendorAllocations.purchaseBillId))
    .where(and(eq(vendorAllocations.paymentId, paymentId), eq(vendorAllocations.active, true)))
    .orderBy(asc(vendorAllocations.id));

type EditPayload = { id: number; version: string; input: VendorPaymentInput };

async function planEdit(tx: Tx, p: EditPayload) {
  const current = await lock(tx, p.id);
  if (current.status !== "active") throw new UserError("A cancelled payment can't be changed.");
  checkVersion(current, p.version, "payment");
  const r = await readPayment(tx, p.input, current);
  if (fyKey(r.values.date) !== fyKey(current.date)) {
    throw new UserError("A payment can't move to another financial year: cancel it and enter a new one.", "date");
  }
  const old = await currentLines(tx, p.id);
  const sameLines = old.length === r.lines.length && r.lines.every((l) => old.some((o) => o.billId === l.billId && o.amount === l.amount));
  const [oldVendor] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, current.vendorId));
  const [oldAccount] = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, current.moneyAccountId));

  const changes: Change[] = [];
  const diff = (label: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ label, old: before, new: after });
  };
  const v = r.values;
  diff("Vendor", oldVendor.name, r.vendor.name);
  diff("Date", formatDate(current.date), formatDate(v.date));
  diff("Amount", formatMoney(current.amountPaise), formatMoney(v.amountPaise));
  diff("Mode", RECEIPT_MODE[current.mode], RECEIPT_MODE[v.mode]);
  diff("Account", oldAccount.name, r.account.name);
  diff("Cheque no", current.chequeNo, v.chequeNo);
  diff("Cheque date", current.chequeDate && formatDate(current.chequeDate), v.chequeDate && formatDate(v.chequeDate));
  diff("Reference", current.reference, v.reference);
  diff("Notes", current.notes, v.notes);
  if (!sameLines) diff("Allocated", allocationText(old, current.amountPaise) || "on account", allocationText(r.lines, v.amountPaise) || "on account");
  const reposts =
    v.date !== current.date || v.vendorId !== current.vendorId || v.amountPaise !== current.amountPaise || v.moneyAccountId !== current.moneyAccountId;
  return { current, r, old, sameLines, changes, reposts };
}

/** Edit = reverse + repost (a posted figure changed) + reallocate (the lines changed). */
async function doEdit(tx: Tx, owner: SessionUser, p: EditPayload) {
  const { current, r, old, sameLines, changes, reposts } = await planEdit(tx, p);
  if (!changes.length) return current.number;
  await tx.update(vendorPayments).set(r.values).where(eq(vendorPayments.id, current.id));
  if (reposts) {
    const entry = await liveEntry(tx, "vendor_payments", current.id);
    if (!entry) throw new Error(`Vendor payment ${current.id} has no journal entry in force`);
    await reverse(tx, entry.id, current.date);
    await postPayment(tx, current.id, current.number, r.values, r.vendor.name);
  }
  if (!sameLines) {
    await deactivate(tx, old.map((o) => o.id));
    await insertAllocations(tx, current.id, r.lines, owner);
  }
  return current.number;
}

registerExecutor<EditPayload>("vendor_payment.edit", {
  async describe(tx, p) {
    const { current, changes } = await planEdit(tx, p);
    if (!changes.length) throw new UserError("Nothing was changed.");
    return { summary: `Change vendor payment ${current.number}`, target: { type: "vendor_payments", id: p.id }, changes };
  },
  run: (tx, owner, p) => doEdit(tx, owner, p),
});

/** The owner edits at once; anyone else files a request (A§7). */
export async function updateVendorPayment(actor: SessionUser, id: number, input: VendorPaymentInput, reason: string) {
  if (!can(actor, "payments", "edit")) throw new Error("Not allowed");
  const [p] = await db.select().from(vendorPayments).where(eq(vendorPayments.id, id));
  if (!p) throw new UserError("That payment doesn't exist.");
  if (p.status !== "active") throw new UserError("A cancelled payment can't be changed.");
  const outcome = await runOrRequest(actor, "vendor_payment.edit", { id, version: p.updatedAt.toISOString(), input } satisfies EditPayload, reason);
  return { message: outcome.done ? `Saved ${p.number}.` : outcome.message };
}

type CancelPayload = { id: number };

/** Reverse on the payment's own date (D45), mark it cancelled, deactivate its allocations (the bills reopen). */
async function doCancel(tx: Tx, p: CancelPayload) {
  const pay = await lock(tx, p.id);
  if (pay.status !== "active") throw new UserError("This payment is already cancelled.");
  const entry = await liveEntry(tx, "vendor_payments", pay.id);
  if (!entry) throw new Error(`Vendor payment ${pay.id} has no journal entry in force`);
  await reverse(tx, entry.id, pay.date);
  await tx.update(vendorPayments).set({ status: "cancelled" }).where(eq(vendorPayments.id, pay.id));
  await deactivate(tx, (await currentLines(tx, pay.id)).map((l) => l.id));
}

registerExecutor<CancelPayload>("vendor_payment.cancel", {
  async describe(tx, p) {
    const [pay] = await tx.select().from(vendorPayments).where(eq(vendorPayments.id, p.id));
    if (!pay) throw new UserError("That payment doesn't exist.");
    if (pay.status !== "active") throw new UserError("This payment is already cancelled.");
    return {
      summary: `Cancel vendor payment ${pay.number} (${formatMoney(pay.amountPaise)})`,
      target: { type: "vendor_payments", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(pay.date)}` },
        { label: "Allocations", old: null, new: "Removed: its bills are open again" },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

export async function cancelVendorPayment(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "payments", "cancel")) throw new Error("Not allowed");
  const [p] = await db.select().from(vendorPayments).where(eq(vendorPayments.id, id));
  if (!p) throw new UserError("That payment doesn't exist.");
  if (p.status !== "active") throw new UserError("This payment is already cancelled.");
  const outcome = await runOrRequest(actor, "vendor_payment.cancel", { id } satisfies CancelPayload, reason);
  return { message: outcome.done ? `Cancelled ${p.number}; its entry is reversed.` : outcome.message };
}

// ---- Apply on-account (D52, as D50 for customers)

/** A vendor's live payments with an unallocated rest, oldest first. */
export async function vendorOnAccount(q: Q, vendorId: number) {
  // The subquery names the outer row in full: drizzle leaves columns unqualified in a one-table select.
  const rows = await q
    .select({
      id: vendorPayments.id,
      number: vendorPayments.number,
      date: vendorPayments.date,
      amount: vendorPayments.amountPaise,
      used: sql<string>`coalesce((select sum(a.amount_paise) from vendor_allocations a where a.payment_id = "vendor_payments"."id" and a.active), 0)`,
    })
    .from(vendorPayments)
    .where(and(eq(vendorPayments.vendorId, vendorId), eq(vendorPayments.status, "active")))
    .orderBy(asc(vendorPayments.date), asc(vendorPayments.number));
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, rest: r.amount - BigInt(r.used) })).filter((r) => r.rest > 0n);
}

/**
 * Puts a payment's unallocated rest on the vendor's open bills. Only adds (free for owner / accountant, no approval);
 * changing existing allocations stays a payment edit. An amount on a bill the payment already pays merges into that
 * row (the old row deactivated, D49), so each bill keeps one line.
 */
export async function applyVendorOnAccount(actor: SessionUser, vendorId: number, paymentId: number, json: string) {
  if (!can(actor, "payments", "create")) throw new Error("Not allowed");
  const lines = readBillAllocations(json);
  if (!lines.length) throw new UserError("Enter an amount on at least one bill.", "allocations");
  return writeTx(actor, async (tx) => {
    const p = await lock(tx, paymentId); // two applies of the same money queue
    if (p.vendorId !== vendorId) throw new UserError("That payment isn't this vendor's: reload the page.");
    if (p.status !== "active") throw new UserError(`${p.number} is cancelled.`);
    const own = await currentLines(tx, p.id);
    const rest = p.amountPaise - own.reduce((s, l) => s + l.amount, 0n);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    if (total > rest) {
      throw new UserError(`${formatMoney(total)} is more than the ${formatMoney(rest)} ${p.number} has on account.`, "allocations");
    }
    await checkBillAllocations(tx, vendorId, rest, lines);
    for (const l of lines) {
      const same = own.find((o) => o.billId === l.billId);
      if (same) await deactivate(tx, [same.id]);
      await insertAllocations(tx, p.id, [{ billId: l.billId, amount: l.amount + (same?.amount ?? 0n) }], actor);
    }
    return { message: `Applied ${formatMoney(total)} from ${p.number}.` };
  });
}

// ---- Loaders

const allocatedByPayment = () =>
  db
    .select({ paymentId: vendorAllocations.paymentId, paise: sql<string>`sum(${vendorAllocations.amountPaise})`.as("vp_allocated_paise") })
    .from(vendorAllocations)
    .where(eq(vendorAllocations.active, true))
    .groupBy(vendorAllocations.paymentId)
    .as("vp_allocated");

export async function listVendorPayments() {
  const allocated = allocatedByPayment();
  const rows = await db
    .select({
      id: vendorPayments.id,
      number: vendorPayments.number,
      date: vendorPayments.date,
      mode: vendorPayments.mode,
      status: vendorPayments.status,
      amount: vendorPayments.amountPaise,
      allocated: allocated.paise,
      vendor: vendors.name,
    })
    .from(vendorPayments)
    .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId))
    .leftJoin(allocated, eq(allocated.paymentId, vendorPayments.id))
    .orderBy(desc(vendorPayments.id));
  return rows.map((r) => {
    const a = r.status === "active" ? BigInt(r.allocated ?? 0) : 0n;
    return { ...r, allocated: a, onAccount: r.status === "active" ? r.amount - a : 0n };
  });
}

export async function getVendorPayment(id: number) {
  const [row] = await db
    .select({ payment: vendorPayments, vendor: vendors, account: accounts.name })
    .from(vendorPayments)
    .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId))
    .innerJoin(accounts, eq(accounts.id, vendorPayments.moneyAccountId))
    .where(eq(vendorPayments.id, id));
  if (!row) return undefined;
  const all = await db
    .select({
      id: vendorAllocations.id,
      billId: vendorAllocations.purchaseBillId,
      amount: vendorAllocations.amountPaise,
      active: vendorAllocations.active,
      changedAt: vendorAllocations.updatedAt,
      number: purchaseBills.number,
      vendorBillNo: purchaseBills.vendorBillNo,
      date: purchaseBills.date,
      total: purchaseBills.totalPaise,
    })
    .from(vendorAllocations)
    .innerJoin(purchaseBills, eq(purchaseBills.id, vendorAllocations.purchaseBillId))
    .where(eq(vendorAllocations.paymentId, id))
    .orderBy(asc(vendorAllocations.id));
  const lines = all.filter((l) => l.active);
  const allocated = lines.reduce((s, l) => s + l.amount, 0n);
  const p = row.payment;
  return {
    ...p,
    vendor: row.vendor,
    account: row.account,
    lines,
    removed: all.filter((l) => !l.active), // deactivated by an edit / cancel (D49), kept for the trail
    allocated,
    onAccount: p.status === "active" ? p.amountPaise - allocated : 0n,
  };
}

/** The payments on a bill (live allocations), oldest first. */
export const billPayments = (billId: number) =>
  db
    .select({ paymentId: vendorPayments.id, number: vendorPayments.number, date: vendorPayments.date, mode: vendorPayments.mode, amount: vendorAllocations.amountPaise })
    .from(vendorAllocations)
    .innerJoin(vendorPayments, eq(vendorPayments.id, vendorAllocations.paymentId))
    .where(and(eq(vendorAllocations.purchaseBillId, billId), eq(vendorAllocations.active, true), eq(vendorPayments.status, "active")))
    .orderBy(asc(vendorPayments.date), asc(vendorPayments.id));

/** Pick lists for the payment form: active vendors (plus this payment's), money accounts. */
export async function vendorPaymentFormOptions(keepVendorId?: number) {
  const [all, money] = await Promise.all([db.select().from(vendors).orderBy(asc(vendors.name)), moneyAccounts()]);
  return {
    vendors: all.filter((v) => v.active || v.id === keepVendorId).map((v) => ({ id: v.id, name: v.name })),
    accounts: money.map((a) => ({ id: a.id, name: a.name, systemKey: a.systemKey })),
  };
}
