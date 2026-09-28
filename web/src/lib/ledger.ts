import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { accounts, journalEntries, journalLines, settings } from "@/db/schema";
import { UserError } from "@/lib/action";
import { dateParts, formatDate } from "@/lib/dates";

// The journal (A§3, D14, D32). post() is the ONLY code that inserts journal rows (hard rule 2). It runs inside the
// document's writeTx, so the entry commits or rolls back with the document; the DB re-checks balance at commit.
// Balances everywhere are Dr − Cr (positive = Dr).

/** The A§3 system accounts, inserted by migration 0006. Posting rules name accounts by these keys. */
export const SYSTEM_KEYS = [
  "cash", "petty_cash", "upi", "bank_1", "bank_2", "ar", "stock", "gst_in_cgst", "gst_in_sgst", "gst_in_igst",
  "ap", "gst_out_cgst", "gst_out_sgst", "gst_out_igst", "grn_clearing", "capital", "opening_equity", "sales",
  "sales_returns", "round_off", "materials_consumed", "price_variance", "cash_short_excess", "bad_debts",
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];
type AccountRef = SystemKey | number; // a system key or an account id

/** Where a line goes: the account, plus the sub-ledgers it belongs to. */
export type LineTarget = { account: AccountRef; customerId?: number; vendorId?: number; jobId?: number };
/** One of debit / credit, in paise. Zero lines are dropped. */
export type PostLine = LineTarget & { debit?: bigint; credit?: bigint };

export type PostEntry = {
  date: string; // 'YYYY-MM-DD'
  docType: string; // the posting row's table ("invoices"); opening balances: the master's ("customers")
  docId: number;
  number?: string | null; // the document's number (D32)
  narration?: string | null;
  lines: PostLine[];
};

export async function systemAccountId(key: SystemKey, q: Tx | typeof db = db): Promise<number> {
  const [row] = await q.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, key));
  if (!row) throw new Error(`No system account "${key}"`);
  return row.id;
}

/** The money accounts (cash, petty cash, UPI, banks), in code order. */
export const moneyAccounts = () =>
  db.select().from(accounts).where(eq(accounts.isMoney, true)).orderBy(asc(accounts.code));

/** Posts one balanced entry inside the document's writeTx. Returns the entry id. */
export function post(tx: Tx, entry: PostEntry): Promise<number> {
  return insert(tx, entry, null);
}

async function insert(tx: Tx, entry: PostEntry, reversesEntryId: number | null): Promise<number> {
  const [{ userId }] = await tx.execute<{ userId: string | null }>(
    sql`select nullif(current_setting('app.user_id', true), '') as "userId"`,
  );
  if (!userId) throw new Error("Posting needs a signed-in user: run it inside writeTx(user, …)");
  dateParts(entry.date);
  if (!(OPENING_DOCS as readonly string[]).includes(entry.docType)) await checkBooksDate(tx, entry.date);

  const lines = entry.lines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n);
  const sum = (side: "debit" | "credit") => lines.reduce((s, l) => s + (l[side] ?? 0n), 0n);
  // The DB checks this at commit too; failing here names the document instead of an entry id.
  if (lines.length < 2 || sum("debit") !== sum("credit")) {
    const [dr, cr] = [sum("debit"), sum("credit")];
    throw new Error(`Unbalanced entry for ${entry.docType} ${entry.docId}: Dr ${dr} ≠ Cr ${cr} (${lines.length} lines)`);
  }

  const keys = [...new Set(lines.map((l) => l.account).filter((a): a is SystemKey => typeof a === "string"))];
  const found = keys.length
    ? await tx
        .select({ id: accounts.id, key: accounts.systemKey })
        .from(accounts)
        .where(inArray(accounts.systemKey, keys))
    : [];
  const idOf = (ref: AccountRef) => {
    const id = typeof ref === "number" ? ref : found.find((f) => f.key === ref)?.id;
    if (id === undefined) throw new Error(`No system account "${ref}"`);
    return id;
  };

  const [{ id }] = await tx
    .insert(journalEntries)
    .values({
      date: entry.date,
      number: entry.number ?? null,
      docType: entry.docType,
      docId: entry.docId,
      narration: entry.narration ?? null,
      reversesEntryId,
    })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      entryId: id,
      accountId: idOf(l.account),
      debitPaise: l.debit ?? 0n,
      creditPaise: l.credit ?? 0n,
      customerId: l.customerId ?? null,
      vendorId: l.vendorId ?? null,
      jobId: l.jobId ?? null,
    })),
  );
  return id;
}

/** An entry's lines as post() input; `swap` turns debits into credits and back. */
async function linesOf(tx: Tx, entryId: number, swap: boolean): Promise<PostLine[]> {
  const rows = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.id));
  return rows.map((l) => ({
    account: l.accountId,
    debit: swap ? l.creditPaise : l.debitPaise,
    credit: swap ? l.debitPaise : l.creditPaise,
    customerId: l.customerId ?? undefined,
    vendorId: l.vendorId ?? undefined,
    jobId: l.jobId ?? undefined,
  }));
}

/**
 * Cancels an entry: writes its mirror image (Dr ↔ Cr) for the same document and number (D32), dated `date`.
 * Each entry can be reversed once (the DB enforces it too); a reversal itself can't be reversed.
 */
export async function reverse(tx: Tx, entryId: number, date: string): Promise<number> {
  const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId));
  if (!entry) throw new Error(`No journal entry ${entryId}`);
  if (entry.reversesEntryId !== null) throw new Error(`Journal entry ${entryId} is a reversal; it can't be reversed`);
  const [done] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.reversesEntryId, entryId));
  if (done) throw new Error(`Journal entry ${entryId} is already reversed`);
  const narration = entry.narration ? `Reversal: ${entry.narration}` : "Reversal";
  const lines = await linesOf(tx, entryId, true);
  return insert(tx, { ...entry, date, narration, lines }, entryId);
}

const reversal = alias(journalEntries, "reversal");

/** Entries still in force (not reversals, not reversed), optionally only these documents. */
function liveEntries(tx: Tx, where?: SQL) {
  return tx
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      docType: journalEntries.docType,
      docId: journalEntries.docId,
      narration: journalEntries.narration,
    })
    .from(journalEntries)
    .leftJoin(reversal, eq(reversal.reversesEntryId, journalEntries.id))
    .where(and(isNull(journalEntries.reversesEntryId), isNull(reversal.id), where));
}

// Opening balances (A§3, D40) are posted by the master row itself: doc_type = its table, doc_id = its id.
const OPENING_DOCS = ["accounts", "customers", "vendors"] as const;

/**
 * No document may be dated before the books start date (D43). FOR SHARE: Settings can't move the date while a
 * document is being saved, and a saved document is seen by Settings' lock check (saveBooks).
 */
export async function checkBooksDate(tx: Tx, date: string) {
  const [s] = await tx.select({ start: settings.booksStartDate }).from(settings).where(eq(settings.id, 1)).for("share");
  if (s?.start && date < s.start) {
    throw new UserError(`The books start on ${formatDate(s.start)}: date it on or after that.`, "date");
  }
}

/** The earliest date anything but an opening balance has posted on, or null. Posted = books start date locked (D43). */
export async function firstDocumentDate(q: Tx | typeof db = db): Promise<string | null> {
  const [row] = await q
    .select({ date: sql<string | null>`min(${journalEntries.date})` })
    .from(journalEntries)
    .where(notInArray(journalEntries.docType, [...OPENING_DOCS]));
  return row.date;
}

/**
 * Sets a record's opening balance: reverses the one in force (on its own date, so the pair nets to zero in every
 * period) and posts `amount` on the books start date. amount > 0 = Dr `dr` / Cr `cr`; < 0 = the other way; 0 = none.
 */
export async function setOpening(
  tx: Tx,
  doc: { type: (typeof OPENING_DOCS)[number]; id: number; narration: string },
  amount: bigint,
  dr: LineTarget,
  cr: LineTarget,
) {
  const live = await liveEntries(tx, and(eq(journalEntries.docType, doc.type), eq(journalEntries.docId, doc.id)));
  for (const e of live) await reverse(tx, e.id, e.date);
  if (amount === 0n) return;
  const [s] = await tx.select({ date: settings.booksStartDate }).from(settings).where(eq(settings.id, 1));
  if (!s?.date) {
    throw new UserError(
      "Set the books start date in Settings first: opening balances are posted on it.",
      "booksStartDate",
    );
  }
  const a = amount < 0n ? -amount : amount;
  const [debit, credit] = amount > 0n ? [dr, cr] : [cr, dr];
  await post(tx, {
    date: s.date,
    docType: doc.type,
    docId: doc.id,
    narration: doc.narration,
    lines: [
      { ...debit, debit: a },
      { ...credit, credit: a },
    ],
  });
}

/** The opening balances in force. */
export const liveOpenings = (tx: Tx) => liveEntries(tx, inArray(journalEntries.docType, [...OPENING_DOCS]));

/** The books start date moved: every opening balance in force is reversed and posted again on `date`. */
export async function moveOpenings(tx: Tx, date: string) {
  const elsewhere = and(inArray(journalEntries.docType, [...OPENING_DOCS]), ne(journalEntries.date, date));
  for (const e of await liveEntries(tx, elsewhere)) {
    const lines = await linesOf(tx, e.id, false);
    await reverse(tx, e.id, e.date);
    await post(tx, { date, docType: e.docType, docId: e.docId, narration: e.narration, lines });
  }
}

export type LedgerFilter = { account?: AccountRef; customerId?: number; vendorId?: number; jobId?: number };

/**
 * A ledger: the balance before `from`, the lines from `from` to `to` (inclusive, 'YYYY-MM-DD', either optional) with
 * a running balance, and the closing balance. Filters combine (account + customer = that customer's AR).
 */
export async function ledger(filter: LedgerFilter, from?: string, to?: string) {
  const where: SQL[] = [];
  if (filter.account !== undefined) {
    const id = typeof filter.account === "number" ? filter.account : await systemAccountId(filter.account);
    where.push(eq(journalLines.accountId, id));
  }
  if (filter.customerId !== undefined) where.push(eq(journalLines.customerId, filter.customerId));
  if (filter.vendorId !== undefined) where.push(eq(journalLines.vendorId, filter.vendorId));
  if (filter.jobId !== undefined) where.push(eq(journalLines.jobId, filter.jobId));
  if (!where.length) throw new Error("ledger() needs an account, customer, vendor or job");

  let opening = 0n;
  if (from) {
    const [row] = await db
      .select({ net: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(...where, lt(journalEntries.date, from)));
    opening = BigInt(row.net);
  }
  const lines = await db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      number: journalEntries.number,
      docType: journalEntries.docType,
      docId: journalEntries.docId,
      narration: journalEntries.narration,
      account: accounts.name,
      debit: journalLines.debitPaise,
      credit: journalLines.creditPaise,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...where, from ? gte(journalEntries.date, from) : undefined, to ? lte(journalEntries.date, to) : undefined))
    .orderBy(asc(journalEntries.date), asc(journalEntries.id), asc(journalLines.id));

  let balance = opening;
  const rows = lines.map((l) => {
    balance += l.debit - l.credit;
    return { ...l, balance };
  });
  return { opening, rows, closing: balance };
}
