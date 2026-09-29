import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { customers, expenseCategories, jobs, purchaseBillLines, purchaseBills, stockItems, vendors } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { type Change, needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { addDays, formatDate, fyKey } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse, type PostLine } from "@/lib/ledger";
import { gstMode } from "@/lib/lines";
import { bpText, formatMoney, milliText, moneyText } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import {
  billTotals,
  blankLine,
  PURCHASE_LINE_KEYS,
  readPurchaseLine,
  type PurchaseLine,
  type PurchaseLineText,
} from "@/lib/purchase-lines";
import { checkVersion, companyState, readDate } from "@/lib/sales";
import { addMove, checkNotNegative, liveMoves, lockItems, reverseMoves } from "@/lib/stock-moves";
import { billStatus, paidByBill, paidTowardsBills, releaseBill } from "@/lib/vendor-payments";

// Purchase bills (S9, S24, A§2, A§3, D51): a vendor's bill, numbered PB/ and posted when saved:
//   Dr stock (stock lines) / category expense accounts (expense lines, with their job) + gst_in_*, round_off ±,
//   Cr ap (vendor). Stock lines add stock moves at their taxable value (excl. GST).
// Edit = reverse + repost, cancel = reverse on the bill date (D45); both by the owner at once, anyone else through an
// approval request (A§7); neither may leave an item below zero stock. A backdated save by a non-owner is a request
// too. Purchase rates are cost: every entry point needs can_view_cost (D51).

type Bill = typeof purchaseBills.$inferSelect;
type BillLine = typeof purchaseBillLines.$inferSelect;

/** The form as typed. lines = JSON of PurchaseLineText[]; roundOff blank = to the nearest rupee. */
export type BillInput = { vendorId: string; vendorBillNo: string; date: string; roundOff: string; notes: string; lines: string };

function allowed(actor: SessionUser, action: "create" | "edit" | "cancel") {
  if (!can(actor, "books", action) || !canViewCost(actor)) throw new Error("Not allowed");
}

function readLines(json: string): PurchaseLine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  if (raw.length > 200) throw new UserError("A bill can have 200 lines at most.", "lines");
  const lines: PurchaseLine[] = [];
  for (const [i, row] of raw.entries()) {
    const o = (row ?? {}) as Record<string, unknown>;
    const t = Object.fromEntries(PURCHASE_LINE_KEYS.map((k) => [k, typeof o[k] === "string" ? o[k] : ""])) as PurchaseLineText;
    if (blankLine(t)) continue;
    try {
      lines.push(readPurchaseLine(t, i + 1));
    } catch (e) {
      throw new UserError((e as Error).message, "lines");
    }
  }
  if (!lines.length) throw new UserError("Add at least one line.", "lines");
  return lines;
}

const activeLines = (q: Tx | typeof db, billId: number) =>
  q
    .select()
    .from(purchaseBillLines)
    .where(and(eq(purchaseBillLines.billId, billId), eq(purchaseBillLines.active, true)))
    .orderBy(asc(purchaseBillLines.position));

const ids = (values: (number | null)[]) => [...new Set(values.filter((v): v is number => v !== null))];

/** The form → checked values, lines, totals. Masters new to this bill must be active; jobs not cancelled. */
async function readBill(tx: Tx, input: BillInput, current?: Bill) {
  const vendorId = Number(input.vendorId);
  const [vendor] = Number.isSafeInteger(vendorId) ? await tx.select().from(vendors).where(eq(vendors.id, vendorId)) : [];
  if (!vendor) throw new UserError("Pick the vendor.", "vendorId");
  if (!vendor.active && vendor.id !== current?.vendorId) throw new UserError("This vendor is inactive.", "vendorId");
  const vendorBillNo = formText(input.vendorBillNo, "vendorBillNo", 50);
  if (!vendorBillNo) throw new UserError("Enter the vendor's bill number.", "vendorBillNo");
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const lines = readLines(input.lines);

  const old = current ? await activeLines(tx, current.id) : [];
  const [itemIds, categoryIds, jobIds] = [ids(lines.map((l) => l.itemId)), ids(lines.map((l) => l.categoryId)), ids(lines.map((l) => l.jobId))];
  const [items, categories, jobRows] = await Promise.all([
    itemIds.length ? tx.select().from(stockItems).where(inArray(stockItems.id, itemIds)) : [],
    categoryIds.length ? tx.select().from(expenseCategories).where(inArray(expenseCategories.id, categoryIds)) : [],
    jobIds.length ? tx.select({ id: jobs.id, number: jobs.number, status: jobs.status }).from(jobs).where(inArray(jobs.id, jobIds)) : [],
  ]);
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    const fail = (message: string) => {
      throw new UserError(`${n}: ${message}`, "lines");
    };
    if (l.itemId !== null) {
      const item = items.find((x) => x.id === l.itemId);
      if (!item) fail("that item doesn't exist; pick it again.");
      else if (!item.active && !old.some((o) => o.stockItemId === item.id)) fail(`${item.name} is inactive.`);
    } else {
      const c = categories.find((x) => x.id === l.categoryId);
      if (!c) fail("that category doesn't exist; pick it again.");
      else if (!c.active && !old.some((o) => o.expenseCategoryId === c.id)) fail(`${c.name} is inactive.`);
    }
    if (l.jobId !== null) {
      const job = jobRows.find((j) => j.id === l.jobId);
      if (!job) fail("that job doesn't exist; pick it again.");
      else if (job.status === "cancelled") fail(`job ${job.number} is cancelled.`);
    }
  });

  const mode = gstMode(vendor.stateCode, await companyState(tx));
  const typed = formMoney(input.roundOff, "roundOff");
  let totals: ReturnType<typeof billTotals>;
  try {
    totals = billTotals(lines, mode, typed);
  } catch (e) {
    throw new UserError((e as Error).message, "roundOff");
  }
  if (totals.total <= 0n) throw new UserError("The bill total must be more than zero.", "lines");
  return {
    vendor,
    lines,
    mode,
    totals,
    categories,
    values: {
      vendorId: vendor.id,
      vendorBillNo,
      date,
      dueDate: addDays(date, vendor.creditDays ?? 0),
      vendorStateCode: vendor.stateCode,
      roundOffPaise: totals.roundOff,
      totalPaise: totals.total,
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

type Read = Awaited<ReturnType<typeof readBill>>;

/** The vendor's bill no is unique among their live bills. */
async function checkDuplicate(tx: Tx, vendorId: number, billNo: string, exceptId?: number) {
  const [dup] = await tx
    .select({ number: purchaseBills.number })
    .from(purchaseBills)
    .where(
      and(
        eq(purchaseBills.vendorId, vendorId),
        sql`upper(${purchaseBills.vendorBillNo}) = upper(${billNo})`,
        ne(purchaseBills.status, "cancelled"),
        exceptId ? ne(purchaseBills.id, exceptId) : undefined,
      ),
    );
  if (dup) throw new UserError(`This vendor's bill ${billNo} is already entered as ${dup.number}.`, "vendorBillNo");
}

/** A§3 + D51: Dr stock / category accounts (with job) + input GST, round_off ±, Cr ap (vendor) = the total. */
function entryLines(r: Read): PostLine[] {
  const dr = new Map<string, PostLine & { debit: bigint }>();
  const add = (account: PostLine["account"], amount: bigint, jobId: number | null = null) => {
    const key = `${account}:${jobId ?? ""}`;
    const line = dr.get(key) ?? { account, jobId: jobId ?? undefined, debit: 0n };
    line.debit += amount;
    dr.set(key, line);
  };
  r.lines.forEach((l, i) => {
    const taxable = r.totals.lines[i].taxable;
    if (l.itemId !== null) add("stock", taxable);
    else add(r.categories.find((c) => c.id === l.categoryId)!.accountId, taxable, l.jobId);
  });
  add("gst_in_cgst", r.totals.cgst);
  add("gst_in_sgst", r.totals.sgst);
  add("gst_in_igst", r.totals.igst);
  const round = r.totals.roundOff;
  return [
    ...dr.values(),
    ...(round > 0n ? [{ account: "round_off" as const, debit: round }] : []),
    ...(round < 0n ? [{ account: "round_off" as const, credit: -round }] : []),
    { account: "ap", vendorId: r.vendor.id, credit: r.totals.total },
  ];
}

const postBill = (tx: Tx, id: number, number: string, r: Read) =>
  post(tx, {
    date: r.values.date,
    docType: "purchase_bills",
    docId: id,
    number,
    narration: `Purchase bill ${number} · ${r.vendor.name} bill ${r.values.vendorBillNo}`,
    lines: entryLines(r),
  });

const insertLines = (tx: Tx, billId: number, lines: PurchaseLine[]) =>
  tx.insert(purchaseBillLines).values(
    lines.map((l, i) => ({
      billId,
      position: i + 1,
      stockItemId: l.itemId,
      expenseCategoryId: l.categoryId,
      description: l.description,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise,
      gstBp: l.gstBp,
      jobId: l.jobId,
    })),
  );

/** Stock lines in at their taxable value (items locked by the caller). */
async function stockIn(tx: Tx, billId: number, r: Read) {
  for (const [i, l] of r.lines.entries()) {
    if (l.itemId === null) continue;
    await addMove(tx, { itemId: l.itemId, date: r.values.date, qty: l.qtyMilli, value: r.totals.lines[i].taxable, source: "purchase", sourceId: billId });
  }
}

const itemsOf = (lines: { itemId: number | null }[]) => ids(lines.map((l) => l.itemId));

async function doCreate(tx: Tx, actor: SessionUser, input: BillInput) {
  const r = await readBill(tx, input);
  await checkDuplicate(tx, r.vendor.id, r.values.vendorBillNo);
  await lockItems(tx, itemsOf(r.lines));
  const number = await nextNumber(tx, "purchase_bill", r.values.date);
  const [row] = await tx
    .insert(purchaseBills)
    .values({ ...r.values, number, createdBy: actor.id })
    .returning({ id: purchaseBills.id });
  await insertLines(tx, row.id, r.lines);
  await stockIn(tx, row.id, r);
  await postBill(tx, row.id, number, r);
  return { id: row.id, number };
}

type CreatePayload = { input: BillInput };

registerExecutor<CreatePayload>("purchase_bill.create", {
  async describe(tx, p) {
    const r = await readBill(tx, p.input);
    await checkDuplicate(tx, r.vendor.id, r.values.vendorBillNo);
    return {
      summary: `Purchase bill ${r.values.vendorBillNo} from ${r.vendor.name}, ${formatMoney(r.values.totalPaise)}, dated ${formatDate(r.values.date)}`,
      changes: [
        { label: "Bill date", old: null, new: formatDate(r.values.date) },
        { label: "Total", old: null, new: formatMoney(r.values.totalPaise) },
        { label: "Lines", old: null, new: `${r.lines.length}` },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

/** Save a new bill: numbered, posted and stocked in one transaction. A non-owner's backdated bill → a request (A§7). */
export async function createPurchaseBill(actor: SessionUser, input: BillInput): Promise<{ id: number | null; message: string }> {
  allowed(actor, "create");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "purchase_bill.create", { input } satisfies CreatePayload, `Dated ${formatDate(date)}, before the backdate window`);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lock(tx: Tx, id: number) {
  const [b] = await tx.select().from(purchaseBills).where(eq(purchaseBills.id, id)).for("update");
  if (!b) throw new UserError("That bill doesn't exist.");
  return b;
}

/** "ACP sheet × 10 @ ₹1,500.00 (18%)" per line, for the owner's review. */
async function linesText(tx: Tx, lines: Pick<BillLine, "stockItemId" | "expenseCategoryId" | "qtyMilli" | "ratePaise" | "gstBp" | "jobId">[]) {
  const [items, categories, jobRows] = await Promise.all([
    tx.select({ id: stockItems.id, name: stockItems.name }).from(stockItems),
    tx.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories),
    tx.select({ id: jobs.id, number: jobs.number }).from(jobs).where(inArray(jobs.id, [0, ...ids(lines.map((l) => l.jobId))])),
  ]);
  return lines
    .map((l) => {
      const what = l.stockItemId !== null ? items.find((i) => i.id === l.stockItemId)?.name : categories.find((c) => c.id === l.expenseCategoryId)?.name;
      const job = l.jobId !== null ? ` · job ${jobRows.find((j) => j.id === l.jobId)?.number}` : "";
      return `${what} × ${milliText(l.qtyMilli)} @ ${formatMoney(l.ratePaise)} (${bpText(l.gstBp)}%)${job}`;
    })
    .join("\n");
}

type EditPayload = { id: number; version: string; input: BillInput };

async function planEdit(tx: Tx, p: EditPayload) {
  const current = await lock(tx, p.id);
  if (current.status !== "active") throw new UserError("A cancelled bill can't be changed.");
  checkVersion(current, p.version, "bill");
  const r = await readBill(tx, p.input, current);
  if (fyKey(r.values.date) !== fyKey(current.date)) {
    throw new UserError("A bill can't move to another financial year: cancel it and enter it again.", "date");
  }
  await checkDuplicate(tx, r.vendor.id, r.values.vendorBillNo, current.id);
  // Payments already on the bill stay valid: same vendor, total not below them (T19).
  const paid = (await paidTowardsBills(tx, [current.id])).get(current.id) ?? 0n;
  if (paid > 0n && r.vendor.id !== current.vendorId) {
    throw new UserError("Payments are allocated to this bill: take them off it before changing the vendor.", "vendorId");
  }
  if (r.values.totalPaise < paid) {
    throw new UserError(`${formatMoney(paid)} is already paid against this bill: the total can't go below it.`, "lines");
  }
  const old = await activeLines(tx, current.id);
  const asSaved = (l: PurchaseLine) => ({
    stockItemId: l.itemId,
    expenseCategoryId: l.categoryId,
    description: l.description,
    qtyMilli: l.qtyMilli,
    ratePaise: l.ratePaise,
    gstBp: l.gstBp,
    jobId: l.jobId,
  });
  const sameLines =
    old.length === r.lines.length &&
    r.lines.every((l, i) => {
      const n = asSaved(l);
      const o = old[i];
      return (Object.keys(n) as (keyof typeof n)[]).every((k) => n[k] === o[k]);
    });
  const [oldVendor] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, current.vendorId));

  const changes: Change[] = [];
  const diff = (label: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ label, old: before, new: after });
  };
  const v = r.values;
  diff("Vendor", oldVendor.name, r.vendor.name);
  diff("Vendor bill no", current.vendorBillNo, v.vendorBillNo);
  diff("Bill date", formatDate(current.date), formatDate(v.date));
  diff("Due date", formatDate(current.dueDate), formatDate(v.dueDate));
  diff("Round off", formatMoney(current.roundOffPaise), formatMoney(v.roundOffPaise));
  diff("Total", formatMoney(current.totalPaise), formatMoney(v.totalPaise));
  diff("Notes", current.notes, v.notes);
  if (!sameLines) diff("Lines", await linesText(tx, old), await linesText(tx, r.lines.map(asSaved)));
  const reposts = !sameLines || v.vendorId !== current.vendorId || v.date !== current.date || v.roundOffPaise !== current.roundOffPaise || v.vendorStateCode !== current.vendorStateCode;
  return { current, r, old, sameLines, changes, reposts };
}

/** Edit = reverse + repost (books and stock) when a posted figure changed; the old lines stay, deactivated. */
async function doEdit(tx: Tx, p: EditPayload) {
  const { current, r, old, sameLines, changes, reposts } = await planEdit(tx, p);
  if (!changes.length) return current.number;
  await tx.update(purchaseBills).set(r.values).where(eq(purchaseBills.id, current.id));
  if (!sameLines) {
    await tx.update(purchaseBillLines).set({ active: false }).where(inArray(purchaseBillLines.id, old.map((o) => o.id)));
    await insertLines(tx, current.id, r.lines);
  }
  if (reposts) {
    const items = [...itemsOf(old.map((o) => ({ itemId: o.stockItemId }))), ...itemsOf(r.lines)];
    await lockItems(tx, items);
    const entry = await liveEntry(tx, "purchase_bills", current.id);
    if (!entry) throw new Error(`Purchase bill ${current.id} has no journal entry in force`);
    await reverse(tx, entry.id, current.date);
    await reverseMoves(tx, "purchase", current.id);
    await stockIn(tx, current.id, r);
    await postBill(tx, current.id, current.number, r);
    await checkNotNegative(tx, items);
  }
  return current.number;
}

registerExecutor<EditPayload>("purchase_bill.edit", {
  async describe(tx, p) {
    const { current, changes } = await planEdit(tx, p);
    if (!changes.length) throw new UserError("Nothing was changed.");
    return { summary: `Change purchase bill ${current.number}`, target: { type: "purchase_bills", id: p.id }, changes };
  },
  run: (tx, _owner, p) => doEdit(tx, p),
});

/** The owner edits at once; anyone else files a request (A§7). */
export async function updatePurchaseBill(actor: SessionUser, id: number, input: BillInput, reason: string) {
  allowed(actor, "edit");
  const [b] = await db.select().from(purchaseBills).where(eq(purchaseBills.id, id));
  if (!b) throw new UserError("That bill doesn't exist.");
  if (b.status !== "active") throw new UserError("A cancelled bill can't be changed.");
  const outcome = await runOrRequest(actor, "purchase_bill.edit", { id, version: b.updatedAt.toISOString(), input } satisfies EditPayload, reason);
  return { message: outcome.done ? `Saved ${b.number}.` : outcome.message };
}

type CancelPayload = { id: number };

/** Reverse the entry and the stock on the bill date (D45); refused if that leaves an item below zero (D51). */
async function doCancel(tx: Tx, p: CancelPayload) {
  const b = await lock(tx, p.id);
  if (b.status !== "active") throw new UserError("This bill is already cancelled.");
  const entry = await liveEntry(tx, "purchase_bills", b.id);
  if (!entry) throw new Error(`Purchase bill ${b.id} has no journal entry in force`);
  const items = ids((await liveMoves(tx, "purchase", b.id)).map((m) => m.itemId));
  await lockItems(tx, items);
  await reverse(tx, entry.id, b.date);
  await reverseMoves(tx, "purchase", b.id);
  await checkNotNegative(tx, items);
  await tx.update(purchaseBills).set({ status: "cancelled" }).where(eq(purchaseBills.id, b.id));
  await releaseBill(tx, b.id); // its payments go back on account (D49)
}

registerExecutor<CancelPayload>("purchase_bill.cancel", {
  async describe(tx, p) {
    const [b] = await tx.select().from(purchaseBills).where(eq(purchaseBills.id, p.id));
    if (!b) throw new UserError("That bill doesn't exist.");
    if (b.status !== "active") throw new UserError("This bill is already cancelled.");
    return {
      summary: `Cancel purchase bill ${b.number} (${b.vendorBillNo}, ${formatMoney(b.totalPaise)})`,
      target: { type: "purchase_bills", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal and stock", old: null, new: `Reversed on ${formatDate(b.date)}` },
        { label: "Payments", old: null, new: "Allocations to it removed: they go back on account" },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

export async function cancelPurchaseBill(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  allowed(actor, "cancel");
  const [b] = await db.select().from(purchaseBills).where(eq(purchaseBills.id, id));
  if (!b) throw new UserError("That bill doesn't exist.");
  if (b.status !== "active") throw new UserError("This bill is already cancelled.");
  const outcome = await runOrRequest(actor, "purchase_bill.cancel", { id } satisfies CancelPayload, reason);
  return { message: outcome.done ? `Cancelled ${b.number}; its entry and stock are reversed.` : outcome.message };
}

// ---- Loaders (callers have checked books + can_view_cost)

/** Bills with paid / open and the computed payment status (A§5). */
export async function listPurchaseBills(vendorId?: number) {
  const paid = paidByBill();
  const rows = await db
    .select({
      id: purchaseBills.id,
      number: purchaseBills.number,
      vendorBillNo: purchaseBills.vendorBillNo,
      date: purchaseBills.date,
      dueDate: purchaseBills.dueDate,
      status: purchaseBills.status,
      total: purchaseBills.totalPaise,
      paid: paid.paise,
      vendorId: purchaseBills.vendorId,
      vendor: vendors.name,
    })
    .from(purchaseBills)
    .innerJoin(vendors, eq(vendors.id, purchaseBills.vendorId))
    .leftJoin(paid, eq(paid.billId, purchaseBills.id))
    .where(vendorId === undefined ? undefined : eq(purchaseBills.vendorId, vendorId))
    .orderBy(desc(purchaseBills.id));
  return rows.map((r) => {
    const paidPaise = r.status === "active" ? BigInt(r.paid ?? 0) : 0n;
    const open = r.status === "active" ? r.total - paidPaise : 0n;
    return { ...r, paid: paidPaise, open, payment: billStatus({ ...r, totalPaise: r.total }, open) };
  });
}

export async function getPurchaseBill(id: number) {
  const [row] = await db
    .select({ bill: purchaseBills, vendor: vendors })
    .from(purchaseBills)
    .innerJoin(vendors, eq(vendors.id, purchaseBills.vendorId))
    .where(eq(purchaseBills.id, id));
  if (!row) return undefined;
  const lines = await db
    .select({ line: purchaseBillLines, item: stockItems.name, unit: stockItems.unit, category: expenseCategories.name, job: jobs.number })
    .from(purchaseBillLines)
    .leftJoin(stockItems, eq(stockItems.id, purchaseBillLines.stockItemId))
    .leftJoin(expenseCategories, eq(expenseCategories.id, purchaseBillLines.expenseCategoryId))
    .leftJoin(jobs, eq(jobs.id, purchaseBillLines.jobId))
    .where(and(eq(purchaseBillLines.billId, id), eq(purchaseBillLines.active, true)))
    .orderBy(asc(purchaseBillLines.position));
  const mode = gstMode(row.bill.vendorStateCode, await companyState(db));
  const totals = billTotals(
    lines.map((l) => l.line),
    mode,
    row.bill.roundOffPaise,
  );
  const active = row.bill.status === "active";
  const paid = active ? ((await paidTowardsBills(db, [id])).get(id) ?? 0n) : 0n;
  const open = active ? row.bill.totalPaise - paid : 0n;
  return {
    ...row.bill,
    vendor: row.vendor,
    mode,
    totals,
    paid,
    open,
    payment: billStatus(row.bill, open),
    lines: lines.map((l) => ({ ...l.line, what: l.item ?? l.category ?? "", unit: l.unit, job: l.job })),
  };
}

/** A saved bill's lines as the form's text (edit). */
export const formLines = (lines: BillLine[]): PurchaseLineText[] =>
  lines.map((l) => ({
    what: l.stockItemId !== null ? `item:${l.stockItemId}` : `cat:${l.expenseCategoryId}`,
    description: l.description ?? "",
    qty: milliText(l.qtyMilli),
    rate: moneyText(l.ratePaise),
    gst: bpText(l.gstBp),
    jobId: l.jobId === null ? "" : String(l.jobId),
  }));

/** Pick lists: active vendors, items and categories (plus what this bill already uses), jobs not cancelled. */
export async function purchaseFormOptions(keep: { vendorId?: number; lines?: BillLine[] } = {}) {
  const used = (k: "stockItemId" | "expenseCategoryId" | "jobId") => ids((keep.lines ?? []).map((l) => l[k]));
  const [vendorRows, itemRows, categoryRows, jobRows, state] = await Promise.all([
    db.select().from(vendors).orderBy(asc(vendors.name)),
    db.select().from(stockItems).orderBy(asc(stockItems.name)),
    db.select().from(expenseCategories).orderBy(asc(expenseCategories.name)),
    db
      .select({ id: jobs.id, number: jobs.number, status: jobs.status, customer: customers.name })
      .from(jobs)
      .innerJoin(customers, eq(customers.id, jobs.customerId))
      .orderBy(desc(jobs.id)),
    companyState(db),
  ]);
  return {
    vendors: vendorRows
      .filter((v) => v.active || v.id === keep.vendorId)
      .map((v) => ({ id: v.id, name: v.name, stateCode: v.stateCode, registered: !!v.gstin, creditDays: v.creditDays })),
    items: itemRows
      .filter((i) => i.active || used("stockItemId").includes(i.id))
      .map((i) => ({ id: i.id, name: i.name, unit: i.unit, gstBp: i.gstBp })),
    categories: categoryRows.filter((c) => c.active || used("expenseCategoryId").includes(c.id)).map((c) => ({ id: c.id, name: c.name })),
    jobs: jobRows.filter((j) => j.status !== "cancelled" || used("jobId").includes(j.id)).map((j) => ({ id: j.id, number: j.number, customer: j.customer })),
    companyState: state,
  };
}
