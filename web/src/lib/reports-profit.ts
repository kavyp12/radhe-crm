import { sql } from "drizzle-orm";
import { db } from "@/db";
import { BUCKET_LABEL, JOB_COST_BUCKETS, type JobCostBucket } from "@/lib/cost-buckets";
import { JOB_STATUS } from "@/lib/jobs";
import { bpText, divRound } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import type { ReportColumn, ReportTable } from "@/lib/report";
import { inRange, moneyCol, party, pick, pickFilters, REPORT_PERIODS, reportRange, rollUp, type ReportQuery, type ReportResult } from "@/lib/reports";
import { purchaseLines } from "@/lib/reports-books";
import { salesRows, type SalesRow } from "@/lib/reports-sales";
import { rangeText } from "@/lib/statements";

// Reports C (S20 #8, 9, 10, 13; A§10, A§12, A§13): profit & loss, job-wise profit, product-wise sales & profit and the
// GST summary. Profit, cost and margin figures only for can_view_cost users (hard rule 5): the P&L and job-wise profit
// are cost as a whole; product-wise drops its profit columns; the GST summary drops the purchases' taxable value.

/** Profit as a share of the sale, "38%" (half-up to 0.01 %); none without a sale. */
const margin = (profit: bigint, sale: bigint) => (sale > 0n ? `${bpText(Number(divRound(profit * 10000n, sale)))}%` : null);

// ---- Profit & loss (S20 #8, A§12, D59)

const PNL_GROUP: Record<string, string> = {
  sales: "Sales",
  sales_returns: "Returns",
  round_off: "Round off",
  materials_consumed: "Materials consumed",
  price_variance: "Variances",
  cash_short_excess: "Variances",
  bad_debts: "Write-offs",
  discount_allowed: "Discounts",
};
const PNL_ORDER = ["Sales", "Returns", "Round off", "Other income", "Materials consumed", "Expense categories", "Variances", "Write-offs", "Discounts", "Other expenses"];

/**
 * S20 #8: the income and expense accounts' movement in the period from the journal (A§12), grouped; net profit =
 * income − expense (= the dashboard's Profit). Below it the D59 gross profit: Sales (D60, excl. GST) − job costs dated
 * in the period (job-tagged journal costs + manual job cost entries). can_view_cost only.
 */
export async function profitReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !canViewCost(user)) return null;
  const { period, range, error } = reportRange(q);
  const [accountRows, [manual], sales] = await Promise.all([
    db.execute<{ name: string; type: "income" | "expense"; key: string | null; category: string | null; net: string; job_cost: string }>(sql`
      select a.name, a.type, a.system_key as key, ec.id as category, sum(l.credit_paise - l.debit_paise) as net,
        coalesce(sum(l.debit_paise - l.credit_paise) filter (where l.job_id is not null), 0) as job_cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      left join expense_categories ec on ec.account_id = a.id
      where a.type in ('income', 'expense') and ${inRange(sql.raw("e.date"), range)}
      group by a.id, a.name, a.type, a.system_key, ec.id`),
    db.execute<{ paise: string }>(sql`select coalesce(sum(amount_paise), 0) as paise from job_cost_entries where active and ${inRange(sql.raw("date"), range)}`),
    salesRows(range),
  ]);

  const lines = accountRows
    .map((r) => {
      const net = BigInt(r.net); // Cr − Dr
      const group = (r.key && PNL_GROUP[r.key]) || (r.category ? "Expense categories" : r.type === "income" ? "Other income" : "Other expenses");
      return { group, account: r.name, income: r.type === "income" ? net : null, expense: r.type === "expense" ? -net : null };
    })
    .filter((r) => (r.income ?? r.expense) !== 0n)
    .sort((a, b) => PNL_ORDER.indexOf(a.group) - PNL_ORDER.indexOf(b.group) || a.account.localeCompare(b.account));
  const income = lines.reduce((s, r) => s + (r.income ?? 0n), 0n);
  const expense = lines.reduce((s, r) => s + (r.expense ?? 0n), 0n);

  // D59: job costs = job-tagged lines on materials consumed and the expense categories' accounts, + manual entries.
  const jobCosts = accountRows
    .filter((r) => r.key === "materials_consumed" || r.category)
    .reduce((s, r) => s + BigInt(r.job_cost), 0n);
  const manualCosts = BigInt(manual.paise);
  const sale = sales.reduce((s, r) => s + r.taxable, 0n);
  const amount = moneyCol("amount", "Amount", false);

  return {
    report: {
      title: "Profit & loss",
      filters: [`Period: ${rangeText(range)}`, "From the books: stock counts as a cost when it is issued (materials consumed), not when it is bought"],
      generatedAt: now,
      tables: [
        {
          columns: [{ key: "group", label: "Group" }, { key: "account", label: "Account" }, moneyCol("income", "Income"), moneyCol("expense", "Expense")],
          rows: lines,
        },
        {
          title: "Profit",
          columns: [{ key: "label", label: "" }, amount],
          rows: [
            { label: "Income", amount: income },
            { label: "Expense", amount: expense },
            { label: "Net profit (income − expense)", amount: income - expense },
          ],
        },
        {
          title: "Gross profit",
          columns: [{ key: "label", label: "" }, amount],
          rows: [
            { label: "Sales (excl. GST)", amount: sale },
            { label: "Job costs in the books", amount: jobCosts },
            { label: "Manual job costs", amount: manualCosts },
            { label: "Gross profit (sales − job costs)", amount: sale - jobCosts - manualCosts },
          ],
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks: [],
  };
}

// ---- Job figures (A§10, D57): T27's jobCosting() for many jobs in two queries

export type JobFigures = { sale: bigint; cost: Record<JobCostBucket, bigint>; totalCost: bigint; profit: bigint };

/**
 * Each job's sale and costs as the job P&L card has them (jobCosting): from the journal, all dates — sale = Cr − Dr on
 * the job's sales / sales_returns lines; costs = its materials_consumed lines (material) and expense-category lines (the
 * category's bucket, "none" → other) — plus its active manual job cost entries.
 */
export async function jobFigures(jobIds: number[]): Promise<Map<number, JobFigures>> {
  const ids = [...new Set(jobIds)];
  const out = new Map<number, JobFigures>();
  if (!ids.length) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const [journal, manual] = await Promise.all([
    db.execute<{ job_id: string; key: string | null; bucket: string | null; net: string }>(sql`
      select l.job_id, a.system_key as key, ec.cost_bucket as bucket, sum(l.debit_paise - l.credit_paise) as net
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join expense_categories ec on ec.account_id = a.id
      where l.job_id in (${list}) and (a.system_key in ('sales', 'sales_returns', 'materials_consumed') or ec.id is not null)
      group by 1, 2, 3`),
    db.execute<{ job_id: string; bucket: JobCostBucket; paise: string }>(sql`
      select job_id, bucket, sum(amount_paise) as paise from job_cost_entries where active and job_id in (${list}) group by 1, 2`),
  ]);
  const of = (id: number) => {
    let f = out.get(id);
    if (!f) out.set(id, (f = { sale: 0n, cost: Object.fromEntries(JOB_COST_BUCKETS.map((b) => [b, 0n])) as Record<JobCostBucket, bigint>, totalCost: 0n, profit: 0n }));
    return f;
  };
  for (const id of ids) of(id);
  for (const r of journal) {
    const f = of(Number(r.job_id));
    const net = BigInt(r.net);
    if (r.key === "sales" || r.key === "sales_returns") f.sale -= net;
    else if (r.key === "materials_consumed") f.cost.material += net;
    else f.cost[r.bucket === "none" ? "other" : (r.bucket as JobCostBucket)] += net;
  }
  for (const r of manual) of(Number(r.job_id)).cost[r.bucket] += BigInt(r.paise);
  for (const f of out.values()) {
    f.totalCost = JOB_COST_BUCKETS.reduce((s, b) => s + f.cost[b], 0n);
    f.profit = f.sale - f.totalCost;
  }
  return out;
}

// ---- Job-wise profit (S20 #9, S11)

/** S20 #9: the job P&L (T27 figures) of every job dated in the period. can_view_cost only. */
export async function jobProfitReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !canViewCost(user)) return null;
  const { period, range, error } = reportRange(q);
  const jobs = await db.execute<{ id: string; number: string; date: string; status: keyof typeof JOB_STATUS; customer: string; firm_name: string | null }>(sql`
    select j.id, j.number, j.date::text as date, j.status, c.name as customer, c.firm_name
    from jobs j join customers c on c.id = j.customer_id
    where ${inRange(sql.raw("j.date"), range)}
    order by j.date, j.number`);
  const picks = [pick("status", "Status", Object.entries(JOB_STATUS) as [string, string][], q)];
  const [status] = picks.map((p) => p.value);
  const shown = jobs.filter((j) => !status || j.status === status);
  const figures = await jobFigures(shown.map((j) => Number(j.id)));

  return {
    report: {
      title: "Job-wise profit",
      filters: [`Jobs dated: ${rangeText(range)}`, ...pickFilters(picks), "Sale and costs from the books, all dates; a job not yet invoiced has no sale"],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "job", label: "Job" },
            { key: "customer", label: "Customer" },
            { key: "status", label: "Status" },
            moneyCol("sale", "Sale"),
            ...JOB_COST_BUCKETS.map((b) => moneyCol(b, BUCKET_LABEL[b])),
            moneyCol("cost", "Total cost"),
            moneyCol("profit", "Profit"),
            { key: "margin", label: "Margin" },
          ],
          rows: shown.map((j) => {
            const f = figures.get(Number(j.id))!;
            return {
              href: `/jobs/${j.id}`,
              job: j.number,
              customer: party(j.customer, j.firm_name),
              status: JOB_STATUS[j.status],
              sale: f.sale,
              ...f.cost,
              cost: f.totalCost,
              profit: f.profit,
              margin: margin(f.profit, f.sale),
            };
          }),
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

// ---- Product-wise sales & profit (S4, S20 #10, A§10)

/**
 * S20 #10: the Sales report's rows by product category; profit (can_view_cost) = each job's profit (T27) split over its
 * sales lines pro-rata to their taxable value (A§10) — lines without a job have no costs to compare, so they count in
 * Sales but not in "Job sales" / profit.
 */
export async function productReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const cost = canViewCost(user);
  const { period, range, error } = reportRange(q);
  const rows = await salesRows(range);
  const profitOf = new Map<SalesRow, bigint>();
  if (cost) {
    const jobs = await jobFigures(rows.flatMap((r) => (r.jobId === null ? [] : [r.jobId])));
    // Cumulative rounding per job, so its lines' shares add up exactly to profit × (their taxable ÷ the job's sale).
    for (const [jobId, f] of jobs) {
      if (f.sale === 0n) continue;
      let taxable = 0n;
      let given = 0n;
      for (const r of rows.filter((x) => x.jobId === jobId)) {
        taxable += r.taxable;
        const upTo = divRound(f.profit * taxable, f.sale);
        profitOf.set(r, upTo - given);
        given = upTo;
      }
    }
  }
  const table = rollUp(
    rows,
    (r) => String(r.categoryId),
    (r) => ({ category: r.category }),
    (r) => ({ sales: r.taxable, ...(cost ? { jobSales: r.jobId === null ? 0n : r.taxable, profit: profitOf.get(r) ?? 0n } : {}) }),
  ).sort((a, b) => String(a.category).localeCompare(String(b.category)));
  if (cost) for (const t of table) t.margin = margin(t.profit as bigint, t.jobSales as bigint);

  return {
    report: {
      title: "Product-wise sales & profit",
      filters: [`Period: ${rangeText(range)}`, "Sales excl. GST (invoices + estimates + debit notes − credit notes)", ...(cost ? ["Profit: each job's profit shared over its lines by taxable value"] : [])],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "category", label: "Category" },
            moneyCol("sales", "Sales"),
            ...(cost ? [moneyCol("jobSales", "Of which job sales"), moneyCol("profit", "Profit"), { key: "margin", label: "Margin" }] : []),
          ],
          rows: table,
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks: [],
  };
}

// ---- GST summary (S20 #13, A§4, D18, D26)

const HEADS = ["cgst", "sgst", "igst"] as const;
type Head = (typeof HEADS)[number];
const TAX_COLUMNS: ReportColumn[] = [moneyCol("cgst", "CGST"), moneyCol("sgst", "SGST"), moneyCol("igst", "IGST"), moneyCol("tax", "Total tax")];
const taxOf = (r: Record<Head, bigint>) => ({ cgst: r.cgst, sgst: r.sgst, igst: r.igst, tax: r.cgst + r.sgst + r.igst });
const sumHead = (rows: Record<Head, bigint>[], head: Head) => rows.reduce((s, r) => s + r[head], 0n);

/**
 * S20 #13: a summary for the CA (no GSTR file, D26) — output tax of tax invoices by B2B (the customer has a GSTIN) /
 * B2C, HSN/SAC and rate (estimates excluded, D18), debit- and credit-note adjustments, input tax from purchase bills
 * by rate, and the net payable per head. The purchases' taxable value only with can_view_cost.
 */
export async function gstReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const cost = canViewCost(user);
  const { period, range, error } = reportRange(q);
  const [sales, purchases] = await Promise.all([salesRows(range), purchaseLines(range)]);
  const tax = sales.filter((r) => !r.estimate);
  const byKind = (kind: SalesRow["kind"]) => tax.filter((r) => r.kind === kind);
  const outward = (kind: SalesRow["kind"], title: string): ReportTable => ({
    title,
    columns: [{ key: "type", label: "Type" }, { key: "hsn", label: "HSN/SAC" }, { key: "rate", label: "Rate" }, moneyCol("taxable", "Taxable"), ...TAX_COLUMNS],
    rows: rollUp(
      byKind(kind),
      (r) => `${r.b2b ? "B2B" : "B2C"}|${r.hsnSac ?? ""}|${r.gstBp}`,
      (r) => ({ type: r.b2b ? "B2B" : "B2C", hsn: r.hsnSac ?? "Not set", rate: `${bpText(r.gstBp)}%`, bp: BigInt(r.gstBp) }),
      (r) => ({ taxable: r.taxable, ...taxOf(r) }),
    ).sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.hsn).localeCompare(String(b.hsn)) || Number((a.bp as bigint) - (b.bp as bigint))),
  });
  const input = rollUp(
    purchases,
    (l) => String(l.gst_bp),
    (l) => ({ rate: `${bpText(l.gst_bp)}%`, bp: BigInt(l.gst_bp) }),
    (l) => ({ ...(cost ? { taxable: l.taxable } : {}), ...taxOf(l) }),
  ).sort((a, b) => Number((a.bp as bigint) - (b.bp as bigint)));

  const [invoices, debits, credits] = (["invoice", "debit", "credit"] as const).map(byKind);
  const net = HEADS.map((h) => {
    const row = { output: sumHead(invoices, h), debit: sumHead(debits, h), credit: sumHead(credits, h), input: sumHead(purchases, h) };
    return { head: h.toUpperCase(), ...row, net: row.output + row.debit + row.credit - row.input };
  });

  return {
    report: {
      title: "GST summary",
      filters: [`Period: ${rangeText(range)}`, "Tax invoices only (estimates have no GST); credit notes reduce output tax", "For the CA — not a GSTR filing"],
      generatedAt: now,
      tables: [
        outward("invoice", "Output tax — tax invoices"),
        outward("debit", "Debit notes (add)"),
        outward("credit", "Credit notes (less)"),
        {
          title: "Input tax — purchase bills",
          columns: [{ key: "rate", label: "Rate" }, ...(cost ? [moneyCol("taxable", "Taxable")] : []), ...TAX_COLUMNS],
          rows: input,
        },
        {
          title: "Net payable",
          columns: [
            { key: "head", label: "Head" },
            moneyCol("output", "Output (invoices)"),
            moneyCol("debit", "Debit notes"),
            moneyCol("credit", "Credit notes"),
            moneyCol("input", "Input"),
            moneyCol("net", "Net payable"),
          ],
          rows: net,
          note: "Per head, before IGST credit is set off against CGST / SGST — the CA does the set-off.",
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks: [],
  };
}
