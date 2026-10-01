import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { accounts, customers, receipts, users } from "@/db/schema";
import { staffOptions } from "@/lib/customers";
import { moneyAccounts } from "@/lib/ledger";
import { can, type SessionUser } from "@/lib/permissions";
import type { Report, ReportRow } from "@/lib/report";
import { RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";
import { LEDGER_PERIODS, rangeText, readRange } from "@/lib/statements";

// S20 reports (A§13). Each loader checks the user's permission and returns a Report — the page, the Excel file and the
// PDF all come from it (D59). T31 builds the Collection report as the framework's sample; T32–T34 add the rest.

/** Report date filters (S20): Today / Yesterday / Week / Month / This FY / Custom. */
export const REPORT_PERIODS = Object.entries(LEDGER_PERIODS).filter(([k]) => k !== "all") as [string, string][];
export type ReportQuery = Record<string, string | undefined>;

/** The period from ?period= (custom: ?from= / ?to=, DD/MM/YYYY); this month when not given. */
export const reportRange = (q: ReportQuery) => readRange(q.period || "month", q.from, q.to);

/** A pick-one report filter: its query key, label, choices and the picked value ("" = all). */
export type ReportPick = { name: string; label: string; options: [string, string][]; value: string };

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
  return { report, period, error, picks };
}

/** The S20 list for /reports: built ones link to their page (T32–T34 fill in the rest); each needs its area. */
export const REPORT_INDEX: { n: number; title: string; href?: string; area: "reports" | "salesReports" }[] = [
  { n: 1, title: "Sales", area: "salesReports" },
  { n: 2, title: "Collection", href: "/reports/collection", area: "reports" },
  { n: 3, title: "Outstanding", area: "salesReports" },
  { n: 4, title: "Customer ledger", area: "reports" },
  { n: 5, title: "Vendor ledger", area: "reports" },
  { n: 6, title: "Purchase", area: "reports" },
  { n: 7, title: "Expense", area: "reports" },
  { n: 8, title: "Profit", area: "reports" },
  { n: 9, title: "Job-wise profit", area: "reports" },
  { n: 10, title: "Product-wise sales", area: "reports" },
  { n: 11, title: "Sales-person-wise sales", area: "salesReports" },
  { n: 12, title: "Collection-person-wise collection", area: "reports" },
  { n: 13, title: "GST summary", area: "reports" },
  { n: 14, title: "Cash book", area: "reports" },
  { n: 15, title: "Bank book", area: "reports" },
  { n: 16, title: "Stock valuation", area: "reports" },
  { n: 17, title: "Pending payment (vendor bills)", area: "reports" },
  { n: 18, title: "Advance received", area: "reports" },
];
