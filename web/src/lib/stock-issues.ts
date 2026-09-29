import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { customers, jobs, STOCK_ISSUE_KINDS, stockIssueLines, stockIssues, stockItems, stockMoves } from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse } from "@/lib/ledger";
import { divRound, milliText, parseQty } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";
import { itemOptions } from "@/lib/stock";
import {
  addMove,
  checkNoReturnSince,
  checkNothingOutSince,
  checkNotNegative,
  liveMoves,
  lockItems,
  outValue,
  pair,
  reverseMoves,
} from "@/lib/stock-moves";

// Issue to job (S17, S11, A§3, A§9, D53): materials leave stock for a job at the moving average — Dr
// materials_consumed (with the job) / Cr stock — and come back at the job's own issue average for the item (the
// other way), so an issue fully returned nets the job to zero. Issues and returns share the SI/ series and post when
// saved. Production enters qty only: values reach can_view_cost users only (stripped in the loaders, hard rule 5).
// Cancel (owner / accountant) = mirror moves + reversal on the document's own date (D45). A non-owner's backdated
// save or cancel goes to the owner (A§7).

export type IssueKind = (typeof STOCK_ISSUE_KINDS)[number];
export const ISSUE_KIND = { issue: "Issue", return: "Return" } as const satisfies Record<IssueKind, string>;

/** The form as typed. lines = JSON of { itemId, qty }[] (blank rows skipped). */
export type IssueInput = { kind: string; jobId: string; date: string; notes: string; lines: string };
type Line = { itemId: number; qty: bigint };

function readLines(json: string): Line[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  if (raw.length > 100) throw new UserError("Up to 100 lines at a time.", "lines");
  const lines: Line[] = [];
  for (const [i, row] of raw.entries()) {
    const o = (row ?? {}) as Record<string, unknown>;
    const item = typeof o.itemId === "string" ? o.itemId : "";
    const qtyText = typeof o.qty === "string" ? o.qty.trim() : "";
    if (!item && !qtyText) continue;
    const fail = (message: string): never => {
      throw new UserError(`Line ${i + 1}: ${message}`, "lines");
    };
    const itemId = Number(item);
    if (!item || !Number.isSafeInteger(itemId)) fail("pick the item.");
    let qty = 0n;
    try {
      qty = parseQty(qtyText);
    } catch {
      fail("enter the qty like 10 or 2.5.");
    }
    if (qty <= 0n) fail("the qty must be more than 0.");
    lines.push({ itemId, qty });
  }
  if (!lines.length) throw new UserError("Add at least one item.", "lines");
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new UserError("Put each item on one line only.", "lines");
  return lines;
}

/** What a job holds of each item: issued less returned, qty and value (all its issue / return moves, cancels net out). */
async function jobHolds(q: Tx | typeof db, jobId: number, itemIds?: number[]) {
  const rows = await q
    .select({
      itemId: stockMoves.itemId,
      qty: sql<string>`-sum(${stockMoves.qtyMilli})`,
      value: sql<string>`-sum(${stockMoves.valuePaise})`,
    })
    .from(stockMoves)
    .where(
      and(
        eq(stockMoves.jobId, jobId),
        inArray(stockMoves.source, ["issue", "return"]),
        itemIds ? inArray(stockMoves.itemId, [0, ...itemIds]) : undefined,
      ),
    )
    .groupBy(stockMoves.itemId);
  return new Map(rows.map((r) => [r.itemId, { qty: BigInt(r.qty), value: BigInt(r.value) }]));
}

/**
 * The document as it would post now (items locked): an issue at the moving average, refused beyond stock (D20); a
 * return at the job's own issue average for the item, refused beyond what the job holds (D53). Holdings are issued
 * less returned, so the last of an item back takes exactly the value left on the job.
 */
async function plan(tx: Tx, input: IssueInput) {
  const kind = STOCK_ISSUE_KINDS.find((k) => k === input.kind);
  if (!kind) throw new UserError("Pick issue or return.", "kind");
  const jobId = Number(input.jobId);
  const [job] = Number.isSafeInteger(jobId)
    ? await tx.select({ id: jobs.id, number: jobs.number, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId))
    : [];
  if (!job) throw new UserError("Pick the job.", "jobId");
  if (kind === "issue" && job.status === "cancelled") throw new UserError(`Job ${job.number} is cancelled.`, "jobId");
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const read = readLines(input.lines);
  const notes = formText(input.notes, "notes", 500);

  const items = await lockItems(tx, read.map((l) => l.itemId));
  const holds = kind === "return" ? await jobHolds(tx, job.id, read.map((l) => l.itemId)) : new Map<number, { qty: bigint; value: bigint }>();
  const lines = read.map((l, i) => {
    const fail = (message: string): never => {
      throw new UserError(`Line ${i + 1}: ${message}`, "lines");
    };
    const item = items.get(l.itemId) ?? fail("that item doesn't exist; pick it again.");
    if (kind === "issue") {
      if (!item.active) fail(`${item.name} is inactive.`);
      try {
        return { ...l, item, value: outValue(l.qty, item) };
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    const held = holds.get(l.itemId) ?? { qty: 0n, value: 0n };
    if (held.qty <= 0n) fail(`${item.name} isn't with job ${job.number} (nothing issued to it that hasn't come back).`);
    if (l.qty > held.qty) fail(`only ${milliText(held.qty)} ${item.unit} of ${item.name} is with job ${job.number} (issued less returned).`);
    return { ...l, item, value: divRound(l.qty * held.value, held.qty) };
  });
  return { kind, job, date, notes, lines, total: lines.reduce((s, l) => s + l.value, 0n) };
}

type Plan = Awaited<ReturnType<typeof plan>>;
const itemsText = (p: Plan) => p.lines.map((l) => `${l.item.name} × ${milliText(l.qty)} ${l.item.unit}`).join(", ");

async function doCreate(tx: Tx, actor: SessionUser, input: IssueInput) {
  const p = await plan(tx, input);
  const number = await nextNumber(tx, "stock_issue", p.date);
  const [row] = await tx
    .insert(stockIssues)
    .values({ number, kind: p.kind, date: p.date, jobId: p.job.id, notes: p.notes, createdBy: actor.id })
    .returning({ id: stockIssues.id });
  await tx
    .insert(stockIssueLines)
    .values(p.lines.map((l, i) => ({ issueId: row.id, position: i + 1, itemId: l.itemId, qtyMilli: l.qty, valuePaise: l.value })));
  const sign = p.kind === "issue" ? -1n : 1n;
  for (const l of p.lines) {
    await addMove(tx, { itemId: l.itemId, date: p.date, qty: sign * l.qty, value: sign * l.value, source: p.kind, sourceId: row.id, jobId: p.job.id });
  }
  // A§3: an issue Dr materials_consumed (job) / Cr stock; a return the other way.
  const consumed = { account: "materials_consumed" as const, jobId: p.job.id };
  const lines = p.kind === "issue" ? pair(p.total, consumed, "stock") : pair(p.total, "stock", consumed);
  if (lines.length) {
    await post(tx, {
      date: p.date,
      docType: "stock_issues",
      docId: row.id,
      number,
      narration: `${p.kind === "issue" ? "Issue to" : "Return from"} job ${p.job.number} · ${itemsText(p)}`,
      lines,
    });
  }
  return { id: row.id, number };
}

type CreatePayload = { input: IssueInput };

registerExecutor<CreatePayload>("stock_issue.create", {
  async describe(tx, p) {
    const d = await plan(tx, p.input);
    return {
      summary: `${ISSUE_KIND[d.kind]} ${d.kind === "issue" ? "to" : "from"} job ${d.job.number}, dated ${formatDate(d.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(d.date) },
        { label: "Items", old: null, new: itemsText(d) },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

/** Save an issue / return: numbered, stocked and posted in one transaction; a non-owner's backdated one → a request. */
export async function createStockIssue(actor: SessionUser, input: IssueInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "stockIssue", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "stock_issue.create", { input } satisfies CreatePayload, `Dated ${formatDate(date)}, before the backdate window`);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

type CancelPayload = { id: number };

async function lock(tx: Tx, id: number) {
  const [doc] = await tx.select().from(stockIssues).where(eq(stockIssues.id, id)).for("update");
  if (!doc) throw new UserError("That issue / return doesn't exist.");
  if (doc.status !== "active") throw new UserError(`${doc.number} is already cancelled.`);
  return doc;
}

/**
 * Items locked first. A return's stock can't go back out once any of it has gone out since (D52); an issue can't be
 * undone once the job returned any of its items since (that return was valued on it).
 */
const checkCancel = (tx: Tx, doc: typeof stockIssues.$inferSelect, items: number[]) =>
  doc.kind === "return" ? checkNothingOutSince(tx, "return", doc.id, items, "return") : checkNoReturnSince(tx, doc.id, doc.jobId, items);

/** Mirror moves + reversal on the document's own date (D45); no item may go below zero. */
async function doCancel(tx: Tx, p: CancelPayload) {
  const doc = await lock(tx, p.id);
  const items = [...new Set((await liveMoves(tx, doc.kind, doc.id)).map((m) => m.itemId))];
  await lockItems(tx, items);
  await checkCancel(tx, doc, items);
  const entry = await liveEntry(tx, "stock_issues", doc.id);
  if (entry) await reverse(tx, entry.id, doc.date);
  await reverseMoves(tx, doc.kind, doc.id);
  await checkNotNegative(tx, items);
  await tx.update(stockIssues).set({ status: "cancelled" }).where(eq(stockIssues.id, doc.id));
  return doc.number;
}

registerExecutor<CancelPayload>("stock_issue.cancel", {
  async describe(tx, p) {
    const doc = await lock(tx, p.id);
    await checkCancel(tx, doc, (await liveMoves(tx, doc.kind, doc.id)).map((m) => m.itemId));
    return {
      summary: `Cancel ${ISSUE_KIND[doc.kind].toLowerCase()} ${doc.number}`,
      target: { type: "stock_issues", id: doc.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Stock and journal", old: null, new: `Reversed on ${formatDate(doc.date)}` },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

/** Owner / accountant. Dated before the backdate window: the accountant's cancel waits for the owner (A§7, D52). */
export async function cancelStockIssue(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "stockIssue", "cancel")) throw new Error("Not allowed");
  const [doc] = await db.select().from(stockIssues).where(eq(stockIssues.id, id));
  if (!doc) throw new UserError("That issue / return doesn't exist.");
  if (doc.status !== "active") throw new UserError(`${doc.number} is already cancelled.`);
  const done = `Cancelled ${doc.number}; its stock and entry are reversed.`;
  if (await needsBackdateApproval(doc.date)) {
    const outcome = await runOrRequest(actor, "stock_issue.cancel", { id } satisfies CancelPayload, reason);
    return { message: outcome.done ? done : outcome.message };
  }
  await writeTx(actor, (tx) => doCancel(tx, { id }));
  return { message: done };
}

// ---- Loaders. Values only for can_view_cost users: stripped here (hard rule 5, D51, D53).

async function linesOf(issueIds: number[]) {
  if (!issueIds.length) return [];
  return db
    .select({
      issueId: stockIssueLines.issueId,
      itemId: stockIssueLines.itemId,
      position: stockIssueLines.position,
      name: stockItems.name,
      unit: stockItems.unit,
      qty: stockIssueLines.qtyMilli,
      value: stockIssueLines.valuePaise,
    })
    .from(stockIssueLines)
    .innerJoin(stockItems, eq(stockItems.id, stockIssueLines.itemId))
    .where(inArray(stockIssueLines.issueId, issueIds))
    .orderBy(asc(stockIssueLines.issueId), asc(stockIssueLines.position));
}

/** Issues and returns, newest first (one job's with `jobId`): the items as text; the value for cost users only. */
export async function listStockIssues(user: SessionUser, jobId?: number) {
  const rows = await db
    .select({
      id: stockIssues.id,
      number: stockIssues.number,
      kind: stockIssues.kind,
      date: stockIssues.date,
      status: stockIssues.status,
      jobId: stockIssues.jobId,
      job: jobs.number,
      customer: customers.name,
    })
    .from(stockIssues)
    .innerJoin(jobs, eq(jobs.id, stockIssues.jobId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(jobId === undefined ? undefined : eq(stockIssues.jobId, jobId))
    .orderBy(desc(stockIssues.id));
  const lines = Map.groupBy(await linesOf(rows.map((r) => r.id)), (l) => l.issueId);
  return rows.map((r) => {
    const mine = lines.get(r.id) ?? [];
    const row = { ...r, items: mine.map((l) => `${l.name} × ${milliText(l.qty)} ${l.unit}`).join(", ") };
    return canViewCost(user) ? { ...row, cost: { value: mine.reduce((s, l) => s + l.value, 0n) } } : row;
  });
}

export async function getStockIssue(user: SessionUser, id: number) {
  const [row] = await db
    .select({ doc: stockIssues, job: jobs.number, customer: customers.name })
    .from(stockIssues)
    .innerJoin(jobs, eq(jobs.id, stockIssues.jobId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(eq(stockIssues.id, id));
  if (!row) return undefined;
  const all = await linesOf([id]);
  const cost = canViewCost(user);
  const lines = all.map(({ value, ...l }): typeof l & { cost?: { value: bigint } } => (cost ? { ...l, cost: { value } } : l));
  const doc: typeof row.doc & { job: string; customer: string; lines: typeof lines; cost?: { total: bigint } } = {
    ...row.doc,
    job: row.job,
    customer: row.customer,
    lines,
  };
  if (cost) doc.cost = { total: all.reduce((s, l) => s + l.value, 0n) };
  return doc;
}

/** What a job can return: the items it holds (issued less returned), qty only. */
export async function returnableItems(jobId: number) {
  const holds = await jobHolds(db, jobId);
  const ids = [...holds].filter(([, h]) => h.qty > 0n).map(([id]) => id);
  if (!ids.length) return [];
  const items = await db.select().from(stockItems).where(inArray(stockItems.id, ids)).orderBy(asc(stockItems.name));
  return items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: holds.get(i.id)!.qty }));
}

/** Pick lists: jobs (cancelled ones only for returns), active items with their qty in stock (no values). */
export async function issueFormOptions(user: SessionUser) {
  const [jobRows, items] = await Promise.all([
    db
      .select({ id: jobs.id, number: jobs.number, status: jobs.status, customer: customers.name })
      .from(jobs)
      .innerJoin(customers, eq(customers.id, jobs.customerId))
      .orderBy(desc(jobs.id)),
    itemOptions(user),
  ]);
  return {
    jobs: jobRows.map((j) => ({ id: j.id, number: j.number, customer: j.customer, cancelled: j.status === "cancelled" })),
    items: items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: i.qty })),
  };
}
