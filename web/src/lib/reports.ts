import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { accounts, customers, receipts, users } from "@/db/schema";
import { staffOptions } from "@/lib/customers";
import { moneyAccounts } from "@/lib/ledger";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import type { Report, ReportColumn, ReportRow } from "@/lib/report";
import { RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";
import { LEDGER_PERIODS, rangeText, readRange, type Range } from "@/lib/statements";

// S20 reports (A§13). Each loader checks the user's permission and returns a Report — the page, the Excel file and the
// PDF all come from it (D59). T31 built the Collection report as the framework's sample; reports-sales.ts (T32),
// reports-books.ts (T33) and reports-profit.ts (T34) hold the rest; lib/exports.ts lists them all by URL name.

/** Report date filters (S20): Today / Yesterday / Week / Month / This FY / Custom. */
export const REPORT_PERIODS = Object.entries(LEDGER_PERIODS).filter(([k]) => k !== "all") as [string, string][];
/** Reports of what is open now (outstanding, pending bills, advances): the period only narrows documents by date. */
export const OPEN_PERIODS: [string, string][] = [["all", "All dates"], ...REPORT_PERIODS];
export type ReportQuery = Record<string, string | undefined>;

/** The period from ?period= (custom: ?from= / ?to=, DD/MM/YYYY); `fallback` (this month) when not given. */
export const reportRange = (q: ReportQuery, fallback = "month") => readRange(q.period || fallback, q.from, q.to);

/** A pick-one report filter: its query key, label, choices and the picked value ("" = all, or `empty` when given). */
export type ReportPick = { name: string; label: string; options: [string, string][]; value: string; empty?: string };

/** What a report loader returns (null = not allowed): the report and its filter bar. */
export type ReportResult = { report: Report; period: string; error: string | null; periods: [string, string][]; picks: ReportPick[] };

/** A pick-one filter read from the query: only one of its own options counts, anything else is "" (all / `empty`). */
export const pick = (name: string, label: string, options: [string, string][], q: ReportQuery, empty?: string): ReportPick => ({
  name,
  label,
  options,
  value: options.find(([v]) => v === q[name])?.[0] ?? "",
  ...(empty ? { empty } : {}),
});

/** "Mode: Cash", "View: By customer" … for the picks that are set. */
export const pickFilters = (picks: ReportPick[]) =>
  picks.filter((p) => p.value).map((p) => `${p.label}: ${p.options.find(([v]) => v === p.value)![1]}`);

/** A money column, summed in the totals row unless `total` is false. */
export const moneyCol = (key: string, label: string, total = true): ReportColumn => ({ key, label, type: "money", ...(total ? { total } : {}) });

/** "Name · Firm" or "Name". */
export const party = (name: string, firm: string | null) => (firm ? `${name} · ${firm}` : name);

/** A link to a report with this one's period (and kind / category) plus `extra` — the drill-down from a total. */
export function drill(path: string, q: ReportQuery, extra: Record<string, string>) {
  const keep = Object.entries(q).filter((e): e is [string, string] => ["period", "from", "to", "kind", "category"].includes(e[0]) && !!e[1]);
  return `${path}?${new URLSearchParams([...keep, ...Object.entries(extra)])}`;
}

/** `col` within the range (either end open), for raw SQL. */
export const inRange = (col: SQL, { from, to }: Range) => sql`(${from ? sql`${col} >= ${from}` : sql`true`} and ${to ? sql`${col} <= ${to}` : sql`true`})`;

/** Rows grouped by `key` (first-seen order): the first row's labels, `figures` summed per group. */
export function rollUp<R>(rows: R[], key: (r: R) => string, label: (r: R) => ReportRow, figures: (r: R) => Record<string, bigint>): ReportRow[] {
  const groups = new Map<string, ReportRow>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k) ?? label(r);
    for (const [f, v] of Object.entries(figures(r))) g[f] = ((g[f] as bigint | undefined) ?? 0n) + v;
    groups.set(k, g);
  }
  return [...groups.values()];
}

/** S20 #2 Collection: receipts in the period (cancelled left out) with their mode, money account and receiver; totals by mode. */
export async function collectionReport(user: SessionUser, q: ReportQuery, now = new Date()) {
  if (!can(user, "reports", "view")) return null;
  const { period, range, error } = reportRange(q);
  const [accountList, staff] = await Promise.all([moneyAccounts(), staffOptions()]);
  const mode = RECEIPT_MODES.find((m) => m === q.mode) ?? "";
  const account = accountList.find((a) => String(a.id) === q.account);
  const receiver = staff.find((u) => u.id === q.receivedBy);

  const where: (SQL | undefined)[] = [eq(receipts.status, "active")];
  if (range.from) where.push(gte(receipts.date, range.from));
  if (range.to) where.push(lte(receipts.date, range.to));
  if (mode) where.push(eq(receipts.mode, mode));
  if (account) where.push(eq(receipts.moneyAccountId, account.id));
  if (receiver) where.push(eq(receipts.receivedBy, receiver.id));
  const rows = await db
    .select({
      id: receipts.id,
      date: receipts.date,
      number: receipts.number,
      customer: customers.name,
      firmName: customers.firmName,
      mode: receipts.mode,
      account: accounts.name,
      receivedBy: users.name,
      amount: receipts.amountPaise,
    })
    .from(receipts)
    .innerJoin(customers, eq(customers.id, receipts.customerId))
    .innerJoin(accounts, eq(accounts.id, receipts.moneyAccountId))
    .leftJoin(users, eq(users.id, receipts.receivedBy))
    .where(and(...where))
    .orderBy(asc(receipts.date), asc(receipts.number));

  const byMode = new Map<ReceiptMode, { count: number; amount: bigint }>();
  for (const r of rows) {
    const m = byMode.get(r.mode) ?? { count: 0, amount: 0n };
    byMode.set(r.mode, { count: m.count + 1, amount: m.amount + r.amount });
  }

  const report: Report = {
    title: "Collection report",
    filters: [
      `Period: ${rangeText(range)}`,
      ...(mode ? [`Mode: ${RECEIPT_MODE[mode]}`] : []),
      ...(account ? [`Account: ${account.name}`] : []),
      ...(receiver ? [`Received by: ${receiver.name}`] : []),
    ],
    generatedAt: now,
    tables: [
      {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "number", label: "Receipt no." },
          { key: "customer", label: "Customer" },
          { key: "mode", label: "Mode" },
          { key: "account", label: "Money account" },
          { key: "receivedBy", label: "Received by" },
          { key: "amount", label: "Amount", type: "money", total: true },
        ],
        rows: rows.map(
          (r): ReportRow => ({
            href: `/receipts/${r.id}`,
            date: r.date,
            number: r.number,
            customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
            mode: RECEIPT_MODE[r.mode],
            account: r.account,
            receivedBy: r.receivedBy,
            amount: r.amount,
          }),
        ),
      },
      {
        title: "Totals by mode",
        columns: [
          { key: "mode", label: "Mode" },
          { key: "count", label: "Receipts", type: "number" },
          { key: "amount", label: "Amount", type: "money", total: true },
        ],
        rows: RECEIPT_MODES.filter((m) => byMode.has(m)).map((m) => ({
          mode: RECEIPT_MODE[m],
          count: BigInt(byMode.get(m)!.count),
          amount: byMode.get(m)!.amount,
        })),
      },
    ],
  };
  const picks: ReportPick[] = [
    { name: "mode", label: "Mode", options: RECEIPT_MODES.map((m) => [m, RECEIPT_MODE[m]]), value: mode },
    { name: "account", label: "Money account", options: accountList.map((a) => [String(a.id), a.name]), value: account ? String(account.id) : "" },
    { name: "receivedBy", label: "Received by", options: staff.map((u) => [u.id, u.name]), value: receiver?.id ?? "" },
  ];
  return { report, period, error, periods: REPORT_PERIODS, picks } satisfies ReportResult;
}

/**
 * The S20 list for /reports: each opens /reports/<name> and needs its area (A§8: sales users get sales, outstanding
 * and the two person-wise reports); `cost` ones are cost as a whole and need can_view_cost too (hard rule 5).
 */
export const REPORT_INDEX: { n: number; name: string; title: string; area: "reports" | "salesReports"; cost?: true }[] = [
  { n: 1, name: "sales", title: "Sales", area: "salesReports" },
  { n: 2, name: "collection", title: "Collection", area: "reports" },
  { n: 3, name: "outstanding", title: "Outstanding", area: "salesReports" },
  { n: 4, name: "customer-ledger", title: "Customer ledger", area: "reports" },
  { n: 5, name: "vendor-ledger", title: "Vendor ledger", area: "reports" },
  { n: 6, name: "purchase", title: "Purchase", area: "reports", cost: true },
  { n: 7, name: "expense", title: "Expense", area: "reports" },
  { n: 8, name: "profit", title: "Profit & loss", area: "reports", cost: true },
  { n: 9, name: "job-profit", title: "Job-wise profit", area: "reports", cost: true },
  { n: 10, name: "product-sales", title: "Product-wise sales & profit", area: "reports" },
  { n: 11, name: "sales-person", title: "Sales-person-wise sales", area: "salesReports" },
  { n: 12, name: "collection-person", title: "Collection-person-wise collection", area: "salesReports" },
  { n: 13, name: "gst-summary", title: "GST summary", area: "reports" },
  { n: 14, name: "cash-book", title: "Cash book", area: "reports" },
  { n: 15, name: "bank-book", title: "Bank book", area: "reports" },
  { n: 16, name: "stock-valuation", title: "Stock valuation", area: "reports", cost: true },
  { n: 17, name: "pending-payment", title: "Pending payment (vendor bills)", area: "reports" },
  { n: 18, name: "advances", title: "Advance received", area: "reports" },
];

/** May this user open the report? (Its loader checks the same and returns null otherwise.) */
export const canOpenReport = (user: SessionUser, r: (typeof REPORT_INDEX)[number]) => can(user, r.area, "view") && (!r.cost || canViewCost(user));
