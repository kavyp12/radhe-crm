import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Range } from "@/lib/statements";

// Cash & bank (S13, A§12): each money account over a period, read from the journal — opening (before `from`) +
// received (debits) − paid (credits) = closing (up to `to`). Received / paid leave out a document and its reversal
// when both fall in the period (a cancelled or edited document nets to zero there), so they show real money
// movement; the identity still holds because such a pair adds nothing to the closing either.

/** A§12 totals: Cash = Cash + Petty Cash; Bank = Bank 1 + Bank 2 + UPI. */
export const CASH_KEYS = ["cash", "petty_cash"] as const;
export const BANK_KEYS = ["bank_1", "bank_2", "upi"] as const;

export type MoneyRow = { id: number; code: string; name: string; key: string | null; opening: bigint; received: bigint; paid: bigint; closing: bigint };

export async function moneySummary({ from, to }: Range): Promise<MoneyRow[]> {
  const within = (alias: "e" | "o" | "r") => {
    const date = sql.raw(`${alias}.date`);
    return sql`(${from ? sql`${date} >= ${from}` : sql`true`} and ${to ? sql`${date} <= ${to}` : sql`true`})`;
  };
  // An entry whose reversal (or whose original) is also in the period.
  const paired = sql`((e.reverses_entry_id is not null and exists (select 1 from journal_entries o where o.id = e.reverses_entry_id and ${within("o")}))
    or exists (select 1 from journal_entries r where r.reverses_entry_id = e.id and ${within("r")}))`;
  const rows = await db.execute<{ id: string; code: string; name: string; key: string | null; opening: string; received: string; paid: string; closing: string }>(sql`
    select a.id, a.code, a.name, a.system_key as key,
      coalesce(sum(l.debit_paise - l.credit_paise) filter (where ${from ? sql`e.date < ${from}` : sql`false`}), 0) as opening,
      coalesce(sum(l.debit_paise) filter (where ${within("e")} and not ${paired}), 0) as received,
      coalesce(sum(l.credit_paise) filter (where ${within("e")} and not ${paired}), 0) as paid,
      coalesce(sum(l.debit_paise - l.credit_paise) filter (where ${to ? sql`e.date <= ${to}` : sql`true`}), 0) as closing
    from accounts a
    left join journal_lines l on l.account_id = a.id
    left join journal_entries e on e.id = l.entry_id
    where a.is_money
    group by a.id, a.code, a.name, a.system_key
    order by a.code`);
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    key: r.key,
    opening: BigInt(r.opening),
    received: BigInt(r.received),
    paid: BigInt(r.paid),
    closing: BigInt(r.closing),
  }));
}

/** The document behind a money account's journal line, for the owner / accountant (who may open all of these). */
export function moneyDocHref(docType: string, docId: number): string | null {
  if (docType === "receipts") return `/receipts/${docId}`;
  if (docType === "vendor_payments") return `/vendor-payments/${docId}`;
  if (docType === "expenses") return `/expenses/${docId}`;
  if (docType === "transfers") return `/cash-bank/transfers/${docId}`;
  if (docType === "adjustments") return `/journal-vouchers/${docId}`;
  return null;
}

/** Adds up rows (a group's total line). */
export function totalOf(rows: MoneyRow[]) {
  const sum = (k: "opening" | "received" | "paid" | "closing") => rows.reduce((s, r) => s + r[k], 0n);
  return { opening: sum("opening"), received: sum("received"), paid: sum("paid"), closing: sum("closing") };
}
