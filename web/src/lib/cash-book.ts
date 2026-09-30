import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { accounts, cashCounts, journalEntries, journalLines, users } from "@/db/schema";
import { formMoney, UserError } from "@/lib/action";
import { registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate } from "@/lib/dates";
import { liveEntry, post } from "@/lib/ledger";
import { formatMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";

// Daily cash book (S14, D55): one day of the Cash account (Petty Cash selectable), from the journal — opening (the
// balance before the day), the day's lines grouped by document type, closing. Groups: received (receipts), expense
// (expenses), purchase (vendor payments), deposited in bank (transfers out to a bank / UPI account), other (transfers in,
// JVs, count differences, anything else). A cash count stores what was counted; its difference from the book closing
// posts to cash_short_excess (A§3) only when asked — the owner at once, anyone else through approval.

export const CASH_BOOK_KEYS = ["cash", "petty_cash"] as const;
export const CASH_BOOK_GROUPS = ["received", "expense", "purchase", "deposited", "other"] as const;
export type CashBookGroup = (typeof CASH_BOOK_GROUPS)[number];
export const GROUP_LABEL: Record<CashBookGroup, string> = {
  received: "Cash received",
  expense: "Cash expense",
  purchase: "Cash purchase (vendor payments)",
  deposited: "Deposited in bank",
  other: "Other (transfers in, JVs, count differences)",
};
const BANKS = ["bank_1", "bank_2", "upi"];

/** The Cash / Petty Cash account, or undefined. */
export async function cashBookAccount(q: Tx | typeof db, id: number) {
  const [a] = Number.isSafeInteger(id)
    ? await q.select().from(accounts).where(and(eq(accounts.id, id), inArray(accounts.systemKey, [...CASH_BOOK_KEYS])))
    : [];
  return a;
}

/** Dr − Cr of the account before `date` (the day's opening) and up to the end of it (the closing). */
async function balances(q: Tx | typeof db, accountId: number, date: string) {
  const [row] = await q
    .select({
      before: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}) filter (where ${journalEntries.date} < ${date}), 0)`,
      upTo: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}) filter (where ${journalEntries.date} <= ${date}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalLines.accountId, accountId));
  return { opening: BigInt(row.before), closing: BigInt(row.upTo) };
}

/** A transfer line is a deposit when it moves money out of this account into a bank / UPI (its reversal: back in). */
function groupOf(line: { docType: string; debit: bigint; credit: bigint; reversal: boolean; counter: string | null }): CashBookGroup {
  if (line.docType === "receipts") return "received";
  if (line.docType === "expenses") return "expense";
  if (line.docType === "vendor_payments") return "purchase";
  const out = line.reversal ? line.debit > 0n : line.credit > 0n;
  if (line.docType === "transfers" && out && BANKS.includes(line.counter ?? "")) return "deposited";
  return "other";
}

/** One day of a cash account: opening, the groups (each with its entries, amount = Dr − Cr), closing, the latest count. */
export async function cashBook(accountId: number, date: string) {
  const { opening, closing } = await balances(db, accountId, date);
  const rows = await db.execute<{
    entry_id: string;
    number: string | null;
    doc_type: string;
    doc_id: string;
    narration: string | null;
    reverses_entry_id: string | null;
    debit: string;
    credit: string;
    counter: string | null;
  }>(sql`
    select e.id as entry_id, e.number, e.doc_type, e.doc_id, e.narration, e.reverses_entry_id,
      l.debit_paise as debit, l.credit_paise as credit,
      (select a.system_key from journal_lines o join accounts a on a.id = o.account_id
        where o.entry_id = e.id and o.id <> l.id order by o.id limit 1) as counter
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    where l.account_id = ${accountId} and e.date = ${date}
    order by e.id, l.id`);
  const groups = CASH_BOOK_GROUPS.map((key) => ({
    key,
    label: GROUP_LABEL[key],
    total: 0n,
    entries: [] as { entryId: number; number: string | null; docType: string; docId: number; narration: string | null; reversal: boolean; amount: bigint }[],
  }));
  for (const r of rows) {
    const line = {
      docType: r.doc_type,
      debit: BigInt(r.debit),
      credit: BigInt(r.credit),
      reversal: r.reverses_entry_id !== null,
      counter: r.counter,
    };
    const group = groups.find((g) => g.key === groupOf(line))!;
    const amount = line.debit - line.credit;
    group.total += amount;
    group.entries.push({
      entryId: Number(r.entry_id),
      number: r.number,
      docType: r.doc_type,
      docId: Number(r.doc_id),
      narration: r.narration,
      reversal: line.reversal,
      amount,
    });
  }
  const [latest] = await db
    .select({ count: cashCounts, by: users.name })
    .from(cashCounts)
    .innerJoin(users, eq(users.id, cashCounts.countedBy))
    .where(and(eq(cashCounts.accountId, accountId), eq(cashCounts.date, date)))
    .orderBy(desc(cashCounts.id))
    .limit(1);
  const count = latest && {
    ...latest.count,
    countedByName: latest.by,
    difference: latest.count.countedPaise - closing, // + excess / − short
    posted: !!(await liveEntry(db, "cash_counts", latest.count.id)),
  };
  return { opening, groups, closing, count };
}

export type CountInput = { accountId: string; date: string; counted: string };

/** Records a count (who and when come from the session). Posts nothing. */
export async function saveCashCount(actor: SessionUser, input: CountInput): Promise<{ message: string }> {
  if (!can(actor, "books", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  const counted = formMoney(input.counted, "counted");
  if (counted === null || counted < 0n) throw new UserError("Enter the cash counted (0 or more).", "counted");
  return writeTx(actor, async (tx) => {
    const account = await cashBookAccount(tx, Number(input.accountId));
    if (!account) throw new UserError("Pick Cash or Petty Cash.");
    await tx.insert(cashCounts).values({ date, accountId: account.id, countedPaise: counted, countedBy: actor.id });
    const { closing } = await balances(tx, account.id, date);
    const diff = counted - closing;
    const how = diff === 0n ? "it matches the book" : `${diff < 0n ? "short" : "excess"} ${formatMoney(diff < 0n ? -diff : diff)} against the book`;
    return { message: `Counted ${formatMoney(counted)}: ${how}.` };
  });
}

type PostPayload = { id: number; difference: string };

/** The count, locked, with its difference now; refuses a count that isn't the day's latest, is posted, or matches. */
async function planPost(tx: Tx, p: PostPayload) {
  const [count] = await tx.select().from(cashCounts).where(eq(cashCounts.id, p.id)).for("update");
  if (!count) throw new UserError("That count doesn't exist.");
  const [later] = await tx
    .select({ id: cashCounts.id })
    .from(cashCounts)
    .where(and(eq(cashCounts.accountId, count.accountId), eq(cashCounts.date, count.date), sql`${cashCounts.id} > ${count.id}`))
    .limit(1);
  if (later) throw new UserError("There is a later count of that day: post its difference instead.");
  if (await liveEntry(tx, "cash_counts", count.id)) throw new UserError("This count's difference is already posted.");
  const account = (await cashBookAccount(tx, count.accountId))!;
  const { closing } = await balances(tx, count.accountId, count.date);
  const difference = count.countedPaise - closing;
  if (difference === 0n) throw new UserError("The count matches the book: there is nothing to post.");
  if (String(difference) !== p.difference) {
    throw new UserError(`The book for ${formatDate(count.date)} changed since this was asked: count again and post the new difference.`);
  }
  const short = difference < 0n;
  const amount = short ? -difference : difference;
  const what = `${short ? "short" : "excess"} ${formatMoney(amount)}`;
  return { count, account, closing, amount, short, what };
}

type Planned = Awaited<ReturnType<typeof planPost>>;

/** A§3: short → Dr cash_short_excess / Cr the account; excess → Dr the account / Cr cash_short_excess. */
const postDifference = (tx: Tx, c: Planned) =>
  post(tx, {
    date: c.count.date,
    docType: "cash_counts",
    docId: c.count.id,
    narration: `Cash count ${formatDate(c.count.date)} (${c.account.name}): ${c.what}`,
    lines: c.short
      ? [
          { account: "cash_short_excess", debit: c.amount },
          { account: c.account.id, credit: c.amount },
        ]
      : [
          { account: c.account.id, debit: c.amount },
          { account: "cash_short_excess", credit: c.amount },
        ],
  });

registerExecutor<PostPayload>("cash_count.post", {
  async describe(tx, p) {
    const c = await planPost(tx, p);
    return {
      summary: `Post the cash count difference: ${c.what} (${c.account.name}, ${formatDate(c.count.date)})`,
      target: { type: "cash_counts", id: p.id },
      changes: [
        { label: "Book closing", old: null, new: formatMoney(c.closing) },
        { label: "Counted", old: null, new: formatMoney(c.count.countedPaise) },
        {
          label: "Entry",
          old: null,
          new: c.short
            ? `Dr Cash Short / Excess ${formatMoney(c.amount)}\nCr ${c.account.name} ${formatMoney(c.amount)}`
            : `Dr ${c.account.name} ${formatMoney(c.amount)}\nCr Cash Short / Excess ${formatMoney(c.amount)}`,
        },
      ],
    };
  },
  async run(tx, _owner, p) {
    await postDifference(tx, await planPost(tx, p));
  },
});

/** Posts the latest count's difference: the owner at once, anyone else through approval (D55). */
export async function postCountDifference(actor: SessionUser, countId: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "books", "create")) throw new Error("Not allowed");
  const [count] = await db.select().from(cashCounts).where(eq(cashCounts.id, countId));
  if (!count) throw new UserError("That count doesn't exist.");
  const { closing } = await balances(db, count.accountId, count.date);
  const difference = count.countedPaise - closing;
  const outcome = await runOrRequest(actor, "cash_count.post", { id: countId, difference: String(difference) } satisfies PostPayload, reason);
  return { message: outcome.done ? "Difference posted: the book now matches the count." : outcome.message };
}
