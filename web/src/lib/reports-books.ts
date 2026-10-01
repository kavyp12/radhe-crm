import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, expenseCategories, vendors } from "@/db/schema";
import { BANK_KEYS, CASH_KEYS, moneyDocHref } from "@/lib/cash-bank";
import { formatDate, todayIST } from "@/lib/dates";
import { ledger, moneyAccounts, systemAccountId } from "@/lib/ledger";
import { gstMode } from "@/lib/lines";
import { divRound, gstOn } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { taxableOf } from "@/lib/purchase-lines";
import { RECEIPT_MODE, type ReceiptMode } from "@/lib/receipt-modes";
import type { ReportColumn, ReportRow, ReportTable } from "@/lib/report";
import { inRange, moneyCol, party, pick, pickFilters, REPORT_PERIODS, reportRange, rollUp, type ReportQuery, type ReportResult } from "@/lib/reports";
import { companyState } from "@/lib/sales";
import { entryLabel, rangeText } from "@/lib/statements";

// Reports B (S20 #4, 5, 6, 7, 14, 15, 16; A§13): customer / vendor ledgers, purchase, expense, cash book, bank book and
// stock valuation — all read from the journal, the purchase / expense documents or the stock moves. Owner / accountant
// only (A§8); purchase and stock valuation are cost as a whole (purchase rates, stock values: can_view_cost, D51).

/** The page of the document behind a journal line, for owner / accountant (bills and GRNs need can_view_cost). */
export function docHref(docType: string, docId: number, cost: boolean): string | null {
  if (docType === "invoices") return `/invoices/${docId}`;
  if (docType === "credit_notes") return `/credit-debit-notes/cn/${docId}`;
  if (docType === "debit_notes") return `/credit-debit-notes/dn/${docId}`;
  if (docType === "purchase_bills") return cost ? `/purchase-bills/${docId}` : null;
  if (docType === "goods_receipts") return cost ? `/material-receive/${docId}` : null;
  if (docType === "customers") return `/customers/${docId}`;
  if (docType === "vendors") return `/vendors/${docId}`;
  if (docType === "accounts") return `/cash-bank/accounts/${docId}`;
  if (docType === "stock_issues") return `/issue-to-job/${docId}`;
  if (docType === "stock_items") return `/items/${docId}`;
  return moneyDocHref(docType, docId);
}

/** "Invoice RDS/26-27/0001", "Receipt (reversed) RC/26-27/0004", "Opening balance". */
const documentOf = (r: { docType: string; number: string | null; reverses: number | null }) => `${entryLabel(r)} ${r.number ?? ""}`.trim();
const orNull = (paise: bigint) => (paise === 0n ? null : paise);
const NO_JOB = "No job";
/** Groups in name order, "No job" last. */
const byLabel = (key: string) => (a: ReportRow, b: ReportRow) =>
  Number(a[key] === NO_JOB) - Number(b[key] === NO_JOB) || String(a[key]).localeCompare(String(b[key]));
/** The columns without a totals row (a one-row totals table). */
const plain = (columns: ReportColumn[]) => columns.map((c) => ({ ...c, total: false }));

// ---- Customer / vendor ledger (S15, A§13 #4, #5)

const PARTY = {
  customer: { account: "ar", title: "Customer ledger", label: "Customer", column: sql.raw("l.customer_id") },
  vendor: { account: "ap", title: "Vendor ledger", label: "Vendor", column: sql.raw("l.vendor_id") },
} as const;
type Party = keyof typeof PARTY;

/**
 * One party's AR / AP ledger (opening, every journal line with its running balance, closing — reversals included,
 * D50: the reversed-pair rule is only for the customer-facing statement), or every party's opening / Dr / Cr / closing.
 * Balance + = Dr (the customer owes us), − = Cr (we owe the vendor). Defaults to this FY, like the ledger tabs.
 */
async function partyLedger(kind: Party, user: SessionUser, q: ReportQuery, now: Date): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const p = PARTY[kind];
  const { period, range, error } = reportRange(q, "fy");
  const list =
    kind === "customer"
      ? (await db.select({ id: customers.id, name: customers.name, firm: customers.firmName }).from(customers).orderBy(asc(customers.name))).map((x) => ({ id: x.id, name: party(x.name, x.firm) }))
      : await db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name));
  const names = new Map(list.map((x) => [x.id, x.name]));
  const picks = [pick(kind, p.label, list.map((x): [string, string] => [String(x.id), x.name]), q)];
  const [id] = picks.map((x) => x.value);
  const cost = canViewCost(user);
  const money = [moneyCol("debit", "Debit"), moneyCol("credit", "Credit")];
  let tables: ReportTable[];

  if (id) {
    const filter = kind === "customer" ? { account: "ar" as const, customerId: Number(id) } : { account: "ap" as const, vendorId: Number(id) };
    const l = await ledger(filter, range.from ?? undefined, range.to ?? undefined);
    tables = [
      {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "document", label: "Document" },
          { key: "narration", label: "Narration" },
          ...money,
          { key: "balance", label: "Balance", type: "balance" },
        ],
        rows: [
          { date: range.from, document: "Opening balance", narration: null, debit: null, credit: null, balance: l.opening },
          ...l.rows.map((r) => ({
            href: docHref(r.docType, r.docId, cost),
            date: r.date,
            document: documentOf(r),
            narration: r.narration,
            debit: orNull(r.debit),
            credit: orNull(r.credit),
            balance: r.balance,
          })),
          { date: range.to ?? todayIST(now), document: "Closing balance", narration: null, debit: null, credit: null, balance: l.closing },
        ],
      },
    ];
  } else {
    const accountId = await systemAccountId(p.account);
    const rows = await db.execute<{ id: string; opening: string; debit: string; credit: string; closing: string }>(sql`
      select ${p.column} as id,
        coalesce(sum(l.debit_paise - l.credit_paise) filter (where ${range.from ? sql`e.date < ${range.from}` : sql`false`}), 0) as opening,
        coalesce(sum(l.debit_paise) filter (where ${inRange(sql.raw("e.date"), range)}), 0) as debit,
        coalesce(sum(l.credit_paise) filter (where ${inRange(sql.raw("e.date"), range)}), 0) as credit,
        coalesce(sum(l.debit_paise - l.credit_paise) filter (where ${range.to ? sql`e.date <= ${range.to}` : sql`true`}), 0) as closing
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_id = ${accountId}
      group by 1`);
    const parties = rows
      .map((r) => ({ id: Number(r.id), opening: BigInt(r.opening), debit: BigInt(r.debit), credit: BigInt(r.credit), closing: BigInt(r.closing) }))
      .filter((r) => r.opening || r.debit || r.credit || r.closing)
      .map((r) => ({ ...r, name: names.get(r.id) ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sum = (k: "opening" | "debit" | "credit" | "closing") => parties.reduce((s, r) => s + r[k], 0n);
    const balances: ReportColumn[] = [
      { key: "opening", label: "Opening", type: "balance" },
      ...money,
      { key: "closing", label: "Closing", type: "balance" },
    ];
    tables = [
      {
        columns: [{ key: "party", label: p.label }, ...balances],
        rows: parties.map((r) => ({
          href: `/reports/${kind}-ledger?${new URLSearchParams({ ...pickedPeriod(q), [kind]: String(r.id) })}`,
          party: r.name,
          opening: r.opening,
          debit: r.debit,
          credit: r.credit,
          closing: r.closing,
        })),
      },
      { title: "Totals", columns: plain(balances), rows: [{ opening: sum("opening"), debit: sum("debit"), credit: sum("credit"), closing: sum("closing") }] },
    ];
  }
  return {
    report: { title: p.title, filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks), "Balance: Dr = owed to us, Cr = owed by us"], generatedAt: now, tables },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

/** The query's period fields (to carry into a drill-down link). */
const pickedPeriod = (q: ReportQuery) =>
  Object.fromEntries(Object.entries(q).filter((e): e is [string, string] => ["period", "from", "to"].includes(e[0]) && !!e[1]));

/** S20 #4: a customer's AR ledger, or every customer's opening / Dr / Cr / closing (closing total = AR). */
export const customerLedgerReport = (user: SessionUser, q: ReportQuery, now = new Date()) => partyLedger("customer", user, q, now);
/** S20 #5: a vendor's AP ledger, or every vendor's (closing total = AP). */
export const vendorLedgerReport = (user: SessionUser, q: ReportQuery, now = new Date()) => partyLedger("vendor", user, q, now);

// ---- Purchase (S20 #6): purchase bill lines

const GST_MONEY: ReportColumn[] = [moneyCol("taxable", "Taxable"), moneyCol("cgst", "CGST"), moneyCol("sgst", "SGST"), moneyCol("igst", "IGST"), moneyCol("total", "Total")];
const PURCHASE_VIEWS: [string, string][] = [
  ["vendor", "By vendor"],
  ["item", "By item / category"],
  ["category", "By category"],
  ["job", "By job"],
];

/**
 * S20 #6: the active lines of active purchase bills dated in the period — qty × rate = taxable, GST per line in the
 * bill's mode (as billTotals; round-off left out) — or by vendor / item / category / job. can_view_cost only (D51).
 */
export async function purchaseReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !canViewCost(user)) return null;
  const { period, range, error } = reportRange(q);
  const [state, rows, vendorList, categories] = await Promise.all([
    companyState(db),
    db.execute<{
      bill_id: string; number: string; vendor_bill_no: string; date: string; vendor_state_code: string; vendor_id: string; vendor: string;
      item_id: string | null; item: string | null; unit: string | null; category_id: string; category: string; job_id: string | null; job: string | null;
      qty_milli: string; rate_paise: string; gst_bp: number;
    }>(sql`
      select b.id as bill_id, b.number, b.vendor_bill_no, b.date::text as date, b.vendor_state_code, v.id as vendor_id, v.name as vendor,
        si.id as item_id, si.name as item, si.unit, coalesce(si.category_id, l.expense_category_id) as category_id, ec.name as category,
        j.id as job_id, j.number as job, l.qty_milli, l.rate_paise, l.gst_bp
      from purchase_bill_lines l
      join purchase_bills b on b.id = l.bill_id
      join vendors v on v.id = b.vendor_id
      left join stock_items si on si.id = l.stock_item_id
      join expense_categories ec on ec.id = coalesce(si.category_id, l.expense_category_id)
      left join jobs j on j.id = l.job_id
      where b.status = 'active' and l.active and ${inRange(sql.raw("b.date"), range)}
      order by b.date, b.number, l.position`),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
    db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).orderBy(asc(expenseCategories.name)),
  ]);
  const picks = [
    pick("view", "View", PURCHASE_VIEWS, q, "Lines"),
    pick("vendor", "Vendor", vendorList.map((v): [string, string] => [String(v.id), v.name]), q),
    pick("category", "Category", categories.map((c): [string, string] => [String(c.id), c.name]), q),
  ];
  const [view, vendor, category] = picks.map((p) => p.value);
  const lines = rows
    .filter((r) => (!vendor || r.vendor_id === vendor) && (!category || r.category_id === category))
    .map((r) => {
      const qty = BigInt(r.qty_milli);
      const rate = BigInt(r.rate_paise);
      const taxable = taxableOf({ qtyMilli: qty, ratePaise: rate });
      const gst = gstOn(taxable, r.gst_bp, gstMode(r.vendor_state_code, state));
      return { ...r, qty, rate, taxable, ...gst, total: taxable + gst.cgst + gst.sgst + gst.igst, what: r.item ?? r.category };
    });
  const figures = (l: (typeof lines)[number]) => ({ taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total });
  const named = (key: string, label: string, keyOf: (l: (typeof lines)[number]) => string, labelOf: (l: (typeof lines)[number]) => ReportRow): ReportTable => ({
    columns: [{ key, label }, ...GST_MONEY],
    rows: rollUp(lines, keyOf, labelOf, figures).sort(byLabel(key)),
  });

  let main: ReportTable;
  if (view === "vendor") main = named("vendor", "Vendor", (l) => l.vendor_id, (l) => ({ vendor: l.vendor, href: `/vendors/${l.vendor_id}` }));
  else if (view === "category") main = named("category", "Category", (l) => l.category_id, (l) => ({ category: l.category }));
  else if (view === "job") main = named("job", "Job", (l) => l.job_id ?? "", (l) => ({ job: l.job ?? NO_JOB, href: l.job_id ? `/jobs/${l.job_id}` : null }));
  else if (view === "item") {
    // A stock item's lines share its unit; expense-category lines have none.
    main = {
      columns: [{ key: "what", label: "Item / category" }, { key: "qty", label: "Qty", type: "qty" }, { key: "unit", label: "Unit" }, ...GST_MONEY],
      rows: rollUp(lines, (l) => (l.item_id ? `i${l.item_id}` : `c${l.category_id}`), (l) => ({ what: l.what, unit: l.unit, href: l.item_id ? `/items/${l.item_id}` : null }), (l) => ({ qty: l.qty, ...figures(l) })).sort(
        (a, b) => String(a.what).localeCompare(String(b.what)),
      ),
    };
  } else {
    main = {
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "number", label: "Bill" },
        { key: "vendor", label: "Vendor" },
        { key: "what", label: "Item / category" },
        { key: "job", label: "Job" },
        { key: "qty", label: "Qty", type: "qty" },
        { key: "unit", label: "Unit" },
        moneyCol("rate", "Rate", false),
        moneyCol("taxable", "Taxable"),
        moneyCol("gst", "GST"),
        moneyCol("total", "Total"),
      ],
      rows: lines.map((l) => ({
        href: `/purchase-bills/${l.bill_id}`,
        date: l.date,
        number: `${l.number} (${l.vendor_bill_no})`,
        vendor: l.vendor,
        what: l.what,
        job: l.job,
        qty: l.qty,
        unit: l.unit,
        rate: l.rate,
        taxable: l.taxable,
        gst: l.cgst + l.sgst + l.igst,
        total: l.total,
      })),
    };
  }
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst" | "total") => lines.reduce((s, l) => s + l[k], 0n);
  return {
    report: {
      title: "Purchase report",
      filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks), "Bill round-off not included"],
      generatedAt: now,
      tables: [main, { title: "Totals", columns: plain(GST_MONEY), rows: [{ taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), total: sum("total") }] }],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

// ---- Expense (S20 #7)

const EXPENSE_VIEWS: [string, string][] = [
  ["category", "By category"],
  ["job", "By job"],
  ["account", "By money account"],
];

/** S20 #7: active expenses dated in the period — each, or by category / job / money account. */
export async function expenseReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const { period, range, error } = reportRange(q);
  const [rows, accountList, categories] = await Promise.all([
    db.execute<{ id: string; number: string; date: string; category_id: string; category: string; vendor: string | null; job_id: string | null; job: string | null; account_id: string; account: string; mode: ReceiptMode; amount: string }>(sql`
      select x.id, x.number, x.date::text as date, ec.id as category_id, ec.name as category, v.name as vendor, j.id as job_id, j.number as job,
        a.id as account_id, a.name as account, x.mode, x.amount_paise as amount
      from expenses x
      join expense_categories ec on ec.id = x.category_id
      left join vendors v on v.id = x.vendor_id
      left join jobs j on j.id = x.job_id
      join accounts a on a.id = x.money_account_id
      where x.status = 'active' and ${inRange(sql.raw("x.date"), range)}
      order by x.date, x.number`),
    moneyAccounts(),
    db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).orderBy(asc(expenseCategories.name)),
  ]);
  const picks = [
    pick("view", "View", EXPENSE_VIEWS, q, "Expenses"),
    pick("category", "Category", categories.map((c): [string, string] => [String(c.id), c.name]), q),
    pick("account", "Paid from", accountList.map((a): [string, string] => [String(a.id), a.name]), q),
  ];
  const [view, category, account] = picks.map((p) => p.value);
  const shown = rows.filter((r) => (!category || r.category_id === category) && (!account || r.account_id === account));
  const amount = moneyCol("amount", "Amount");
  const count = { key: "count", label: "Expenses", type: "number" } as const;
  const group = (key: string, label: string, keyOf: (r: (typeof shown)[number]) => string, labelOf: (r: (typeof shown)[number]) => ReportRow): ReportTable => ({
    columns: [{ key, label }, count, amount],
    rows: rollUp(shown, keyOf, labelOf, (r) => ({ count: 1n, amount: BigInt(r.amount) })).sort(byLabel(key)),
  });

  const main: ReportTable =
    view === "category"
      ? group("category", "Category", (r) => r.category_id, (r) => ({ category: r.category }))
      : view === "job"
        ? group("job", "Job", (r) => r.job_id ?? "", (r) => ({ job: r.job ?? NO_JOB, href: r.job_id ? `/jobs/${r.job_id}` : null }))
        : view === "account"
          ? group("account", "Paid from", (r) => r.account_id, (r) => ({ account: r.account }))
          : {
              columns: [
                { key: "date", label: "Date", type: "date" },
                { key: "number", label: "Number" },
                { key: "category", label: "Category" },
                { key: "vendor", label: "Vendor" },
                { key: "job", label: "Job" },
                { key: "account", label: "Paid from" },
                { key: "mode", label: "Mode" },
                amount,
              ],
              rows: shown.map((r) => ({
                href: `/expenses/${r.id}`,
                date: r.date,
                number: r.number,
                category: r.category,
                vendor: r.vendor,
                job: r.job,
                account: r.account,
                mode: RECEIPT_MODE[r.mode],
                amount: BigInt(r.amount),
              })),
            };
  return {
    report: { title: "Expense report", filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks)], generatedAt: now, tables: [main] },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

// ---- Cash book / bank book (S20 #14, #15): the journal of the money accounts

/**
 * The money accounts of the book (cash: Cash + Petty Cash; bank: Bank 1, Bank 2, UPI): opening / received / paid /
 * closing per account, then each account's journal lines with a running balance (reversals included — the journal).
 */
async function moneyBook(kind: "cash" | "bank", user: SessionUser, q: ReportQuery, now: Date): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const { period, range, error } = reportRange(q);
  const keys: readonly string[] = kind === "cash" ? CASH_KEYS : BANK_KEYS;
  const accountList = (await moneyAccounts()).filter((a) => keys.includes(a.systemKey ?? ""));
  const picks = [pick("account", "Account", accountList.map((a): [string, string] => [String(a.id), a.name]), q)];
  const [picked] = picks.map((p) => p.value);
  const shown = accountList.filter((a) => !picked || String(a.id) === picked);
  const books = await Promise.all(shown.map((a) => ledger({ account: a.id }, range.from ?? undefined, range.to ?? undefined)));
  const sumOf = (rows: { debit: bigint; credit: bigint }[], side: "debit" | "credit") => rows.reduce((s, r) => s + r[side], 0n);

  const summary: ReportTable = {
    columns: [{ key: "account", label: "Account" }, moneyCol("opening", "Opening"), moneyCol("received", "Received"), moneyCol("paid", "Paid"), moneyCol("closing", "Closing")],
    rows: shown.map((a, i) => ({
      account: a.name,
      opening: books[i].opening,
      received: sumOf(books[i].rows, "debit"),
      paid: sumOf(books[i].rows, "credit"),
      closing: books[i].closing,
    })),
  };
  const lines: ReportTable[] = shown.map((a, i) => ({
    title: a.name,
    columns: [
      { key: "date", label: "Date", type: "date" },
      { key: "document", label: "Document" },
      { key: "narration", label: "Narration" },
      moneyCol("received", "Received"),
      moneyCol("paid", "Paid"),
      moneyCol("balance", "Balance", false),
    ],
    rows: books[i].rows.map((r) => ({
      href: docHref(r.docType, r.docId, canViewCost(user)),
      date: r.date,
      document: documentOf(r),
      narration: r.narration,
      received: orNull(r.debit),
      paid: orNull(r.credit),
      balance: r.balance,
    })),
  }));
  return {
    report: {
      title: kind === "cash" ? "Cash book" : "Bank book",
      filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks)],
      generatedAt: now,
      tables: [summary, ...lines],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

/** S20 #14: Cash and Petty Cash from the journal, with running balances. */
export const cashBookReport = (user: SessionUser, q: ReportQuery, now = new Date()) => moneyBook("cash", user, q, now);
/** S20 #15: Bank 1, Bank 2 and UPI from the journal, with running balances. */
export const bankBookReport = (user: SessionUser, q: ReportQuery, now = new Date()) => moneyBook("bank", user, q, now);

// ---- Stock valuation (S20 #16, A§9)

/**
 * S20 #16: each item's qty and value from its stock moves up to the period's last day (as of that date), the average =
 * value ÷ qty (A§9), grouped by category; total = the stock account as of that day. can_view_cost only (D51).
 */
export async function stockValuationReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !canViewCost(user)) return null;
  const { period, range, error } = reportRange(q);
  const asOf = range.to ?? todayIST(now);
  const rows = await db.execute<{ id: string; name: string; unit: string; category_id: string; category: string; qty: string; value: string }>(sql`
    select si.id, si.name, si.unit, ec.id as category_id, ec.name as category,
      coalesce(sum(m.qty_milli), 0) as qty, coalesce(sum(m.value_paise), 0) as value
    from stock_items si
    join expense_categories ec on ec.id = si.category_id
    left join stock_moves m on m.item_id = si.id and m.date <= ${asOf}
    group by si.id, si.name, si.unit, ec.id, ec.name
    having coalesce(sum(m.qty_milli), 0) <> 0 or coalesce(sum(m.value_paise), 0) <> 0
    order by ec.name, si.name`);
  const categories = [...new Map(rows.map((r) => [r.category_id, r.category])).entries()];
  const picks = [pick("category", "Category", categories, q)];
  const [category] = picks.map((p) => p.value);
  const items = rows
    .filter((r) => !category || r.category_id === category)
    .map((r) => {
      const qty = BigInt(r.qty);
      const value = BigInt(r.value);
      return { ...r, qty, value, average: qty > 0n ? divRound(value * 1000n, qty) : null };
    });
  const value = moneyCol("value", "Value");
  return {
    report: {
      title: "Stock valuation",
      filters: [`As of ${formatDate(asOf)} (the period's last day)`, ...pickFilters(picks), "Weighted average cost (A§9)"],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "category", label: "Category" },
            { key: "item", label: "Item" },
            { key: "qty", label: "Qty", type: "qty" },
            { key: "unit", label: "Unit" },
            moneyCol("average", "Average cost", false),
            value,
          ],
          rows: items.map((r) => ({ href: `/items/${r.id}`, category: r.category, item: r.name, qty: r.qty, unit: r.unit, average: r.average, value: r.value })),
        },
        {
          title: "By category",
          columns: [{ key: "category", label: "Category" }, { key: "count", label: "Items", type: "number" }, value],
          rows: rollUp(items, (r) => r.category_id, (r) => ({ category: r.category }), (r) => ({ count: 1n, value: r.value })),
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}
