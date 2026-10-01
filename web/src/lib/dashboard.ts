import { sql } from "drizzle-orm";
import { db } from "@/db";
import { BANK_KEYS, CASH_KEYS } from "@/lib/cash-bank";
import { dateParts, fyStart, todayIST } from "@/lib/dates";
import { myFollowUpsDue } from "@/lib/follow-ups";
import { outstanding } from "@/lib/outstanding";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";

// Owner dashboard (R1, S19, A§12, D24, D59), read when the page loads (it refreshes itself every 60 s, D22):
// - Sales = taxable value of issued invoices + estimates + debit notes − credit notes (excl. GST, D60) · Collection =
//   active receipts · Purchase = active purchase bills' taxable · Expense = active expenses — each by document date.
// - Outstanding = open invoices + debit notes + each customer's positive opening / unallocated remainder; Advances =
//   the negative remainders, so Outstanding − Advances = AR (D59). Payable = AP balance. Cash = cash + petty cash;
//   Bank = bank 1 + bank 2 + UPI (journal balances).
// - Profit = income − expense accounts in the journal for the period; Gross profit = Sales − job costs dated in the
//   period (job-tagged journal costs + manual job cost entries).
// The 8 R1 numbers are this month (balances as of now); the chart covers this FY by month; top 5 customers / services
// this FY. Who sees what is decided here, on the server: owner / accountant everything (profit only with
// can_view_cost), sales only sales / outstanding / follow-ups, production nothing (the page sends them to /jobs).

export type Stat = { key: string; label: string; paise: bigint; href?: string };
export type MonthPoint = { month: string; sales: bigint; collection?: bigint; expense?: bigint };
export type Ranked = { name: string; paise: bigint };
export type FollowUp = { id: number; customerId: number; customer: string; invoice: string | null; due: string; paise: bigint | null; note: string };

export type Dashboard = {
  kpis: Stat[]; // R1, this month / balances now
  today: Stat[]; // S19 Today
  current: Stat[]; // S19 Current
  performance: Stat[]; // S19 Performance (this month)
  months: MonthPoint[]; // monthly chart, FY so far
  topCustomers: Ranked[]; // this FY
  topServices: Ranked[]; // this FY, by product category
  followUps: FollowUp[] | null; // null = no follow-ups access
};

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Flow = "sales" | "collection" | "purchase" | "expense";

// One row per sales line in [from, to]: issued invoice / estimate lines at their taxable value (A§4: round(qty × rate)
// half away from zero − discount; numeric, never float), plus issued debit-note lines, less issued credit-note lines
// (both stored taxable, D60).
const salesLines = (from: string, to: string) => sql`
  select i.date, i.customer_id, l.category_id, round(l.qty_milli::numeric * l.rate_paise / 1000) - l.discount_paise as paise
  from invoice_lines l join invoices i on i.id = l.invoice_id
  where i.status = 'issued' and i.date between ${from} and ${to}
  union all
  select n.date, n.customer_id, il.category_id, nl.taxable_paise
  from debit_note_lines nl join debit_notes n on n.id = nl.note_id join invoice_lines il on il.id = nl.invoice_line_id
  where n.status = 'issued' and n.date between ${from} and ${to}
  union all
  select n.date, n.customer_id, il.category_id, -nl.taxable_paise
  from credit_note_lines nl join credit_notes n on n.id = nl.note_id join invoice_lines il on il.id = nl.invoice_line_id
  where n.status = 'issued' and n.date between ${from} and ${to}`;

/** The four document flows by day for [from, to] — one query. */
async function flowsByDay(from: string, to: string) {
  const rows = await db.execute<{ kind: Flow; date: string; paise: string }>(sql`
    select kind, date::text as date, sum(paise)::text as paise from (
      select 'sales' as kind, date, paise from (${salesLines(from, to)}) s
      union all
      select 'collection', date, amount_paise from receipts where status = 'active' and date between ${from} and ${to}
      union all
      select 'purchase', b.date, round(l.qty_milli::numeric * l.rate_paise / 1000)
      from purchase_bill_lines l join purchase_bills b on b.id = l.bill_id
      where b.status = 'active' and l.active and b.date between ${from} and ${to}
      union all
      select 'expense', date, amount_paise from expenses where status = 'active' and date between ${from} and ${to}
    ) f group by kind, date`);
  return rows.map((r) => ({ kind: r.kind, date: r.date, paise: BigInt(r.paise) }));
}

/** Top 5 customers and product categories by sales in [from, to] — one query each. */
async function topSales(from: string, to: string): Promise<{ customers: Ranked[]; services: Ranked[] }> {
  const top = (key: "customer_id" | "category_id", table: "customers" | "product_categories") =>
    db.execute<{ name: string; paise: string }>(sql`
      select t.name, sum(s.paise)::text as paise from (${salesLines(from, to)}) s join ${sql.identifier(table)} t on t.id = s.${sql.identifier(key)}
      group by t.id, t.name having sum(s.paise) > 0 order by sum(s.paise) desc, t.name limit 5`);
  const [customers, services] = await Promise.all([top("customer_id", "customers"), top("category_id", "product_categories")]);
  const ranked = (rows: { name: string; paise: string }[]) => rows.map((r) => ({ name: r.name, paise: BigInt(r.paise) }));
  return { customers: ranked(customers), services: ranked(services) };
}

/** Profit and job costs for [from, to] from the journal, plus manual job cost entries — one query. */
async function profitFigures(from: string, to: string) {
  const [row] = await db.execute<{ profit: string; jobCosts: string }>(sql`
    select
      coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type in ('income', 'expense')), 0)::text as profit,
      (coalesce(sum(l.debit_paise - l.credit_paise) filter (
         where l.job_id is not null and (a.system_key = 'materials_consumed' or ec.id is not null)), 0)
       + (select coalesce(sum(amount_paise), 0) from job_cost_entries where active and date between ${from} and ${to}))::text as "jobCosts"
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    left join expense_categories ec on ec.account_id = a.id
    where e.date between ${from} and ${to}`);
  return { profit: BigInt(row.profit), jobCosts: BigInt(row.jobCosts) };
}

/** Cash, bank and payable balances from the journal (all entries) — one query. */
async function balances() {
  const keys = [...CASH_KEYS, ...BANK_KEYS, "ap"];
  const rows = await db.execute<{ key: string; paise: string }>(sql`
    select a.system_key as key, sum(l.debit_paise - l.credit_paise)::text as paise
    from journal_lines l join accounts a on a.id = l.account_id
    where a.system_key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
    group by a.system_key`);
  const of = (ks: readonly string[]) => rows.filter((r) => ks.includes(r.key)).reduce((s, r) => s + BigInt(r.paise), 0n);
  return { cash: of(CASH_KEYS), bank: of(BANK_KEYS), payable: -of(["ap"]) };
}

/** Outstanding and advances (D59) from the outstanding report: open documents + positive remainders / negative ones. */
async function receivables(today: string) {
  const { customers } = await outstanding(today);
  let receivable = 0n;
  let advances = 0n;
  for (const c of customers) {
    const { total, onAccount } = c.totals;
    receivable += total - onAccount + (onAccount > 0n ? onAccount : 0n);
    if (onAccount < 0n) advances -= onAccount;
  }
  return { receivable, advances };
}

export async function loadDashboard(user: SessionUser, today = todayIST()): Promise<Dashboard> {
  const all = can(user, "reports", "view");
  if (!all && !can(user, "salesReports", "view")) throw new Error("Not allowed");
  const cost = all && canViewCost(user);
  const fy = fyStart(today);
  const month = `${today.slice(0, 8)}01`; // D30: month = 1st → today

  const [flows, top, money, ar, pnl, followUps] = await Promise.all([
    flowsByDay(fy, today),
    topSales(fy, today),
    all ? balances() : null,
    receivables(today),
    cost ? profitFigures(month, today) : null,
    can(user, "followUps", "view") ? myFollowUpsDue(user, today) : null,
  ]);

  const sum = (kind: Flow, from: string) => flows.filter((f) => f.kind === kind && f.date >= from).reduce((s, f) => s + f.paise, 0n);
  const [m, t] = [(k: Flow) => sum(k, month), (k: Flow) => sum(k, today)];
  const go = (href: string, area: Parameters<typeof can>[1]) => (can(user, area, "view") ? href : undefined);
  const links = {
    sales: (period: string) => go(`/reports/sales?period=${period}`, "salesReports"), // the same total (D60)
    collection: (period: string) => go(`/reports/collection?period=${period}`, "reports"),
    outstanding: go("/outstanding", "salesReports"),
    purchase: cost ? go("/purchase-bills", "books") : undefined,
    expense: go("/expenses", "books"),
    cashBank: go("/cash-bank", "books"),
    payable: go("/vendors", "vendors"),
    profit: cost ? "/reports/profit?period=month" : undefined, // the P&L report has both figures
  };

  // Each figure with who may see it: "sales" = everyone here, "all" = owner / accountant, "cost" = + can_view_cost.
  type Seen = "sales" | "all" | "cost";
  const stat = (seen: Seen, key: string, label: string, paise: () => bigint, href?: string) => ({ seen, key, label, paise, href });
  const pick = (stats: ReturnType<typeof stat>[]): Stat[] =>
    stats
      .filter((s) => s.seen === "sales" || (s.seen === "all" && all) || (s.seen === "cost" && cost))
      .map(({ key, label, paise, href }) => ({ key, label, paise: paise(), ...(href ? { href } : {}) }));

  // Months of this FY so far: Apr … this month.
  const [fyYear] = dateParts(fy);
  const [y, mo] = dateParts(today);
  const months: MonthPoint[] = [];
  for (let i = 0; i <= (y - fyYear) * 12 + mo - 4; i++) {
    const key = `${fyYear + Math.floor((3 + i) / 12)}-${String(((3 + i) % 12) + 1).padStart(2, "0")}`;
    const of = (kind: Flow) => flows.filter((f) => f.kind === kind && f.date.startsWith(key)).reduce((s, f) => s + f.paise, 0n);
    months.push(all ? { month: MONTH[(3 + i) % 12], sales: of("sales"), collection: of("collection"), expense: of("expense") } : { month: MONTH[(3 + i) % 12], sales: of("sales") });
  }

  return {
    kpis: pick([
      stat("sales", "sales", "Sales", () => m("sales"), links.sales("month")),
      stat("all", "collection", "Collection", () => m("collection"), links.collection("month")),
      stat("sales", "outstanding", "Outstanding", () => ar.receivable, links.outstanding),
      stat("all", "purchase", "Purchase", () => m("purchase"), links.purchase),
      stat("all", "expense", "Expense", () => m("expense"), links.expense),
      stat("cost", "profit", "Profit", () => pnl!.profit, links.profit),
      stat("all", "cash", "Cash", () => money!.cash, links.cashBank),
      stat("all", "bank", "Bank", () => money!.bank, links.cashBank),
    ]),
    today: pick([
      stat("sales", "todaySales", "Sales", () => t("sales"), links.sales("today")),
      stat("all", "todayCollection", "Collection", () => t("collection"), links.collection("today")),
      stat("all", "todayPurchase", "Purchase", () => t("purchase"), links.purchase),
      stat("all", "todayExpense", "Expense", () => t("expense"), links.expense),
    ]),
    current: pick([
      stat("sales", "receivable", "Total receivable", () => ar.receivable, links.outstanding),
      stat("all", "payable", "Total payable", () => money!.payable, links.payable),
      stat("all", "cashBalance", "Cash balance", () => money!.cash, links.cashBank),
      stat("all", "bankBalance", "Bank balance", () => money!.bank, links.cashBank),
    ]),
    performance: pick([
      stat("sales", "monthlySales", "Monthly sales", () => m("sales"), links.sales("month")),
      stat("all", "monthlyCollection", "Monthly collection", () => m("collection"), links.collection("month")),
      stat("all", "monthlyExpense", "Monthly expense", () => m("expense"), links.expense),
      stat("cost", "grossProfit", "Gross profit", () => m("sales") - pnl!.jobCosts, links.profit),
      stat("sales", "performanceOutstanding", "Outstanding", () => ar.receivable, links.outstanding),
      stat("sales", "advances", "Advances received", () => ar.advances, links.outstanding),
    ]),
    months,
    topCustomers: top.customers,
    topServices: top.services,
    followUps:
      followUps?.slice(0, 5).map((f) => ({
        id: f.id,
        customerId: f.customerId,
        customer: f.customer,
        invoice: f.invoice,
        due: f.nextReminderDate!,
        paise: f.promise && f.promise !== "Kept" ? f.expected! - f.received : null,
        note: f.response ?? "",
      })) ?? null,
  };
}
