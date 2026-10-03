import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { productCategories, vendors } from "@/db/schema";
import { openingBillLabel } from "@/lib/allocations";
import { staffOptions } from "@/lib/customers";
import { formatDate, todayIST } from "@/lib/dates";
import { gstMode } from "@/lib/lines";
import { gstOn, lineCalc } from "@/lib/num";
import { AGING, agingBucket, daysBetween, docHref, docKind, emptyTotals, outstanding, type OutstandingDoc, type Totals } from "@/lib/outstanding";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { listPurchaseBills } from "@/lib/purchase-bills";
import { RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";
import type { ReportColumn, ReportRow, ReportTable } from "@/lib/report";
import {
  drill,
  inRange,
  moneyCol,
  OPEN_PERIODS,
  party,
  pick,
  pickFilters,
  REPORT_PERIODS,
  reportRange,
  rollUp,
  type ReportQuery,
  type ReportResult,
} from "@/lib/reports";
import { companyState } from "@/lib/sales";
import { rangeText, type Range } from "@/lib/statements";
import { vendorOpeningBills } from "@/lib/vendor-payments";

// Reports A (S20 #1, 3, 11, 12, 17, 18; A§13): sales, outstanding, sales-person-wise, collection-person-wise, pending
// vendor bills (D25) and advances received. Each loader checks the user's area and returns one ReportResult that the
// page, the Excel file and the PDF all read (D59). Sales users may open sales, outstanding and the two person-wise
// reports (A§8) — none of them carries a cost figure.

const NOT_ASSIGNED = "Not assigned";
const byName = (a: ReportRow, b: ReportRow, key: string) => String(a[key]).localeCompare(String(b[key]));
/** Name order with "Not assigned" last. */
const personOrder = (key: string) => (a: ReportRow, b: ReportRow) =>
  a[key] === NOT_ASSIGNED ? 1 : b[key] === NOT_ASSIGNED ? -1 : byName(a, b, key);
const peopleOptions = async (): Promise<[string, string][]> => [...(await staffOptions()).map((u): [string, string] => [u.id, u.name]), ["none", NOT_ASSIGNED]];
/** "Bills dated: 01/05/2026 – 31/05/2026" when the period narrows the documents (balance reports); nothing for all dates. */
const dated = (what: string, range: Range) => (range.from || range.to ? [`${what}: ${rangeText(range)}`] : []);

// ---- Sales rows (D60): issued invoice / estimate lines + debit-note lines − credit-note lines, excl. GST

export type SalesKind = "invoice" | "estimate" | "debit" | "credit";
export const SALES_KIND: Record<SalesKind, string> = { invoice: "Invoice", estimate: "Estimate", debit: "Debit note", credit: "Credit note" };

/** One sales line in the period, signed (a credit note's lines are negative), with the GST the document charged. */
export type SalesRow = {
  kind: SalesKind;
  estimate: boolean; // the invoice (or the note's invoice) is an estimate: no GST, not in the GST summary (D18)
  docId: number;
  number: string;
  date: string;
  customerId: number;
  customer: string;
  b2b: boolean; // the customer has a GSTIN
  salesPersonId: string | null; // the customer's assigned sales person (D57)
  salesPerson: string | null;
  categoryId: number;
  category: string;
  hsnSac: string | null;
  jobId: number | null;
  gstBp: number;
  taxable: bigint;
  cgst: bigint;
  sgst: bigint;
  igst: bigint;
};

/**
 * Every sales line dated in the range — the Sales report's rows and the source of the product-wise and GST reports.
 * Invoice lines are figured as the invoice did (A§4, lineCalc: taxable = round(qty × rate) − discount, GST per line);
 * note lines carry their taxable value and take GST in their invoice's mode (noteTotals). Oldest first.
 */
export async function salesRows(range: Range): Promise<SalesRow[]> {
  const state = await companyState(db);
  const rows = await db.execute<{
    src: "invoice" | "debit" | "credit";
    inv_kind: "tax" | "estimate";
    doc_id: string;
    number: string;
    date: string;
    customer_id: string;
    customer: string;
    firm_name: string | null;
    gstin: string | null;
    sales_person_id: string | null;
    sales_person: string | null;
    category_id: string;
    category: string;
    hsn_sac: string | null;
    job_id: string | null;
    gst_bp: number;
    place_of_supply: string;
    qty_milli: string | null;
    rate_paise: string | null;
    discount_paise: string | null;
    taxable: string | null;
  }>(sql`
    select s.src, s.inv_kind, s.doc_id, s.number, s.date::text as date, s.customer_id, c.name as customer, c.firm_name,
      c.gstin, c.sales_person_id, u.name as sales_person, s.category_id, pc.name as category, s.hsn_sac, s.job_id,
      s.gst_bp, s.place_of_supply, s.qty_milli, s.rate_paise, s.discount_paise, s.taxable
    from (
      select 'invoice' as src, i.kind as inv_kind, i.id as doc_id, i.number, i.date, i.customer_id, i.place_of_supply,
        l.category_id, l.hsn_sac, l.job_id, l.gst_bp, l.qty_milli, l.rate_paise, l.discount_paise,
        null::bigint as taxable, l.position
      from invoice_lines l join invoices i on i.id = l.invoice_id
      where i.status = 'issued' and ${inRange(sql.raw("i.date"), range)}
      union all
      select 'debit', i.kind, n.id, n.number, n.date, n.customer_id, i.place_of_supply,
        il.category_id, il.hsn_sac, il.job_id, nl.gst_bp, null, null, null, nl.taxable_paise, nl.position
      from debit_note_lines nl join debit_notes n on n.id = nl.note_id join invoices i on i.id = n.invoice_id
        join invoice_lines il on il.id = nl.invoice_line_id
      where n.status = 'issued' and ${inRange(sql.raw("n.date"), range)}
      union all
      select 'credit', i.kind, n.id, n.number, n.date, n.customer_id, i.place_of_supply,
        il.category_id, il.hsn_sac, il.job_id, nl.gst_bp, null, null, null, nl.taxable_paise, nl.position
      from credit_note_lines nl join credit_notes n on n.id = nl.note_id join invoices i on i.id = n.invoice_id
        join invoice_lines il on il.id = nl.invoice_line_id
      where n.status = 'issued' and ${inRange(sql.raw("n.date"), range)}
    ) s
    join customers c on c.id = s.customer_id
    left join users u on u.id = c.sales_person_id
    join product_categories pc on pc.id = s.category_id
    order by s.date, s.src desc, s.number, s.position`);

  return rows.map((r) => {
    const estimate = r.inv_kind === "estimate";
    const mode = gstMode(r.place_of_supply, state, estimate);
    const f =
      r.src === "invoice"
        ? lineCalc({ qty: BigInt(r.qty_milli!), rate: BigInt(r.rate_paise!), discount: BigInt(r.discount_paise!), gstBp: r.gst_bp }, mode)
        : { taxable: BigInt(r.taxable!), ...gstOn(BigInt(r.taxable!), r.gst_bp, mode) };
    const sign = r.src === "credit" ? -1n : 1n;
    return {
      kind: r.src === "invoice" ? (estimate ? "estimate" : "invoice") : r.src,
      estimate,
      docId: Number(r.doc_id),
      number: r.number,
      date: r.date,
      customerId: Number(r.customer_id),
      customer: party(r.customer, r.firm_name),
      b2b: !!r.gstin?.trim(),
      salesPersonId: r.sales_person_id,
      salesPerson: r.sales_person,
      categoryId: Number(r.category_id),
      category: r.category,
      hsnSac: r.hsn_sac?.trim() || null,
      jobId: r.job_id === null ? null : Number(r.job_id),
      gstBp: r.gst_bp,
      taxable: sign * f.taxable,
      cgst: sign * f.cgst,
      sgst: sign * f.sgst,
      igst: sign * f.igst,
    };
  });
}

/** The invoice / note page of a sales row. */
export const salesDocHref = (r: Pick<SalesRow, "kind" | "docId">) =>
  r.kind === "debit" ? `/credit-debit-notes/dn/${r.docId}` : r.kind === "credit" ? `/credit-debit-notes/cn/${r.docId}` : `/invoices/${r.docId}`;

export const categoryOptions = async (): Promise<[string, string][]> =>
  (await db.select({ id: productCategories.id, name: productCategories.name }).from(productCategories).orderBy(asc(productCategories.name))).map(
    (c): [string, string] => [String(c.id), c.name],
  );

const salesFigures = (r: SalesRow) => {
  const gst = r.cgst + r.sgst + r.igst;
  return { taxable: r.taxable, gst, total: r.taxable + gst };
};
const SALES_MONEY: ReportColumn[] = [moneyCol("taxable", "Taxable"), moneyCol("gst", "GST"), moneyCol("total", "Total")];
const SALES_VIEWS: [string, string][] = [
  ["date", "By date"],
  ["customer", "By customer"],
  ["category", "By category"],
  ["salesPerson", "By sales person"],
];

async function sales(user: SessionUser, q: ReportQuery, now: Date, title: string, view?: string): Promise<ReportResult | null> {
  if (!can(user, "salesReports", "view")) return null;
  const { period, range, error } = reportRange(q);
  const [all, categories, people] = await Promise.all([salesRows(range), categoryOptions(), peopleOptions()]);
  const picks = [
    ...(view === undefined ? [pick("view", "View", SALES_VIEWS, q, "Lines")] : []),
    pick("kind", "Kind", [["tax", "Tax invoices"], ["estimate", "Estimates"]], q),
    pick("category", "Category", categories, q),
    pick("salesPerson", "Sales person", people, q),
  ];
  const [kind, category, person] = ["kind", "category", "salesPerson"].map((n) => picks.find((p) => p.name === n)!.value);
  const shown = view ?? picks[0].value;
  const rows = all.filter(
    (r) =>
      (!kind || r.estimate === (kind === "estimate")) &&
      (!category || String(r.categoryId) === category) &&
      (!person || (r.salesPersonId ?? "none") === person),
  );
  const open = can(user, "invoices", "view");

  let main: ReportTable;
  if (shown === "date") {
    main = { columns: [{ key: "date", label: "Date", type: "date" }, ...SALES_MONEY], rows: rollUp(rows, (r) => r.date, (r) => ({ date: r.date }), salesFigures) };
  } else if (shown === "customer") {
    main = {
      columns: [{ key: "customer", label: "Customer" }, ...SALES_MONEY],
      rows: rollUp(rows, (r) => String(r.customerId), (r) => ({ customer: r.customer, href: `/customers/${r.customerId}` }), salesFigures).sort((a, b) =>
        byName(a, b, "customer"),
      ),
    };
  } else if (shown === "category") {
    main = {
      columns: [{ key: "category", label: "Category" }, ...SALES_MONEY],
      rows: rollUp(rows, (r) => String(r.categoryId), (r) => ({ category: r.category }), salesFigures).sort((a, b) => byName(a, b, "category")),
    };
  } else if (shown === "salesPerson") {
    main = {
      columns: [{ key: "salesPerson", label: "Sales person" }, ...SALES_MONEY],
      rows: rollUp(
        rows,
        (r) => r.salesPersonId ?? "none",
        (r) => ({ salesPerson: r.salesPerson ?? NOT_ASSIGNED, href: drill("/reports/sales", q, { salesPerson: r.salesPersonId ?? "none" }) }),
        salesFigures,
      ).sort(personOrder("salesPerson")),
    };
  } else {
    main = {
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "number", label: "Document" },
        { key: "kind", label: "Kind" },
        { key: "customer", label: "Customer" },
        { key: "category", label: "Category" },
        { key: "salesPerson", label: "Sales person" },
        ...SALES_MONEY,
      ],
      rows: rows.map((r) => ({
        href: open ? salesDocHref(r) : null,
        date: r.date,
        number: r.number,
        kind: SALES_KIND[r.kind],
        customer: r.customer,
        category: r.category,
        salesPerson: r.salesPerson ?? NOT_ASSIGNED,
        ...salesFigures(r),
      })),
    };
  }
  const byKind = rollUp(rows, (r) => r.kind, (r) => ({ kind: SALES_KIND[r.kind] }), salesFigures);

  return {
    report: {
      title,
      filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks), "Taxable excl. GST · invoice round-off not included"],
      generatedAt: now,
      tables: [main, { title: "Totals by kind", columns: [{ key: "kind", label: "Kind" }, ...SALES_MONEY], rows: byKind }],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

/** S20 #1: sales lines (invoices + estimates + debit notes − credit notes, D60) — lines, or by date / customer / category / sales person. */
export const salesReport = (user: SessionUser, q: ReportQuery, now = new Date()) => sales(user, q, now, "Sales report");

/** S20 #11: sales by the customer's sales person (D57); each person opens their lines in the Sales report. */
export const salesPersonReport = (user: SessionUser, q: ReportQuery, now = new Date()) =>
  sales(user, q, now, "Sales-person-wise sales", "salesPerson");

// ---- Outstanding (S7, D17, D57): the /outstanding figures as a report

const AGING_COLUMNS: ReportColumn[] = AGING.map((b) => moneyCol(b.key, b.label));
const agingOf = (t: Totals) => Object.fromEntries(AGING.map((b) => [b.key, t.aging[b.key]]));

function totalsOf(docs: OutstandingDoc[]): Totals {
  const t = emptyTotals();
  for (const d of docs) {
    t.total += d.open;
    t.aging[d.bucket] += d.open;
    if (d.due === "today") t.dueToday += d.open;
    if (d.due === "overdue") t.overdue += d.open;
  }
  return t;
}

/**
 * S20 #3: who owes what as of today, customer-wise (aging, opening / on account, overdue, total = AR) or invoice-wise.
 * The period picks documents by date; "All dates" (the default) shows each customer's whole AR balance (D57).
 */
export async function outstandingReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "salesReports", "view")) return null;
  const { period, range, error } = reportRange(q, "all");
  const today = todayIST(now);
  const [data, people] = await Promise.all([outstanding(today), peopleOptions()]);
  const picks = [
    pick("view", "View", [["invoice", "Invoice-wise"]], q, "Customer-wise"),
    pick("salesPerson", "Sales person", people, q),
    pick("collectionPerson", "Collection person", people, q),
    pick("aging", "Aging", AGING.map((b): [string, string] => [b.key, b.label]), q),
  ];
  const [view, sp, cp, aging] = picks.map((p) => p.value);
  // The whole balance (with its opening / on-account line) unless documents are narrowed by date or aging.
  const whole = !range.from && !range.to && !aging;
  const shown = data.customers
    .filter((c) => (!sp || (c.salesPersonId ?? "none") === sp) && (!cp || (c.collectionPersonId ?? "none") === cp))
    .map((c) => {
      const docs = c.docs.filter((d) => (!range.from || d.date >= range.from) && (!range.to || d.date <= range.to) && (!aging || d.bucket === aging));
      return { c, docs, totals: whole ? c.totals : totalsOf(docs) };
    })
    .filter((x) => x.totals.total !== 0n || x.docs.length > 0);

  let main: ReportTable;
  if (view === "invoice") {
    const docs = shown.flatMap((x) => x.docs.map((d) => ({ d, customer: party(x.c.name, x.c.firmName) })));
    docs.sort((a, b) => (a.d.date < b.d.date ? -1 : a.d.date > b.d.date ? 1 : a.d.number.localeCompare(b.d.number)));
    main = {
      columns: [
        { key: "number", label: "Document" },
        { key: "kind", label: "Kind" },
        { key: "date", label: "Date", type: "date" },
        { key: "dueDate", label: "Due", type: "date" },
        { key: "customer", label: "Customer" },
        { key: "age", label: "Age (days)", type: "number" },
        { key: "aging", label: "Aging" },
        { key: "status", label: "Status" },
        moneyCol("total", "Total"),
        moneyCol("open", "Open"),
      ],
      rows: docs.map(({ d, customer }) => ({
        href: docHref(d),
        number: d.number,
        kind: docKind(d),
        date: d.date,
        dueDate: d.dueDate,
        customer,
        age: BigInt(d.age),
        aging: AGING.find((b) => b.key === d.bucket)!.label,
        status: d.due === "today" ? "Due today" : d.due === "overdue" ? "Overdue" : "Not due",
        total: d.total,
        open: d.open,
      })),
    };
  } else {
    main = {
      columns: [
        { key: "customer", label: "Customer" },
        ...AGING_COLUMNS,
        ...(whole ? [moneyCol("onAccount", "Opening / on account")] : []),
        moneyCol("overdue", "Overdue"),
        moneyCol("total", "Total"),
      ],
      rows: shown.map(({ c, totals }) => ({
        href: `/outstanding?customer=${c.id}`,
        customer: party(c.name, c.firmName),
        ...agingOf(totals),
        ...(whole ? { onAccount: totals.onAccount } : {}),
        overdue: totals.overdue,
        total: totals.total,
      })),
    };
  }

  const sum = shown.reduce((t, x) => {
    for (const b of AGING) t.aging[b.key] += x.totals.aging[b.key];
    t.onAccount += x.totals.onAccount;
    t.dueToday += x.totals.dueToday;
    t.overdue += x.totals.overdue;
    return t;
  }, emptyTotals());
  return {
    report: {
      title: "Outstanding report",
      filters: [`As of ${formatDate(today)} · aging by document date`, ...dated("Documents dated", range), ...pickFilters(picks)],
      generatedAt: now,
      tables: [
        main,
        {
          title: "Aging",
          columns: [{ key: "label", label: "Bucket" }, moneyCol("amount", "Amount")],
          rows: [
            ...AGING.map((b) => ({ label: b.label, amount: sum.aging[b.key] })),
            ...(whole ? [{ label: "Opening / on account", amount: sum.onAccount }] : []),
          ],
        },
        {
          title: "Due",
          columns: [{ key: "label", label: "" }, moneyCol("amount", "Amount", false)],
          rows: [
            { label: "Due today", amount: sum.dueToday },
            { label: "Overdue", amount: sum.overdue },
          ],
        },
      ],
    },
    period,
    error,
    periods: OPEN_PERIODS,
    picks,
  };
}

// ---- Collection-person-wise (S20 #12): receipts by the customer's collection person, received_by as a column

/** S20 #12: active receipts in the period by the customer's collection person (D57) — per person, or the receipts. */
export async function collectionPersonReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "salesReports", "view")) return null;
  const { period, range, error } = reportRange(q);
  const [rows, people] = await Promise.all([
    db.execute<{ id: string; number: string; date: string; customer: string; firm_name: string | null; person_id: string | null; person: string | null; received_by_id: string | null; received_by: string | null; mode: ReceiptMode; amount: string }>(sql`
      select r.id, r.number, r.date::text as date, c.name as customer, c.firm_name, c.collection_person_id as person_id,
        cp.name as person, r.received_by as received_by_id, rb.name as received_by, r.mode, r.amount_paise as amount
      from receipts r
      join customers c on c.id = r.customer_id
      left join users cp on cp.id = c.collection_person_id
      left join users rb on rb.id = r.received_by
      where r.status = 'active' and ${inRange(sql.raw("r.date"), range)}
      order by r.date, r.number`),
    peopleOptions(),
  ]);
  const picks = [
    pick("view", "View", [["lines", "Receipts"]], q, "By person"),
    pick("person", "Collection person", people, q),
    pick("receivedBy", "Received by", people.slice(0, -1), q),
    pick("mode", "Mode", RECEIPT_MODES.map((m): [string, string] => [m, RECEIPT_MODE[m]]), q),
  ];
  const [view, person, receivedBy, mode] = picks.map((p) => p.value);
  const shown = rows.filter(
    (r) => (!person || (r.person_id ?? "none") === person) && (!receivedBy || r.received_by_id === receivedBy) && (!mode || r.mode === mode),
  );
  const open = can(user, "payments", "view");
  const amount = moneyCol("amount", "Amount");

  const main: ReportTable =
    view === "lines"
      ? {
          columns: [
            { key: "date", label: "Date", type: "date" },
            { key: "number", label: "Receipt no." },
            { key: "customer", label: "Customer" },
            { key: "person", label: "Collection person" },
            { key: "receivedBy", label: "Received by" },
            { key: "mode", label: "Mode" },
            amount,
          ],
          rows: shown.map((r) => ({
            href: open ? `/receipts/${r.id}` : null,
            date: r.date,
            number: r.number,
            customer: party(r.customer, r.firm_name),
            person: r.person ?? NOT_ASSIGNED,
            receivedBy: r.received_by,
            mode: RECEIPT_MODE[r.mode],
            amount: BigInt(r.amount),
          })),
        }
      : {
          columns: [{ key: "person", label: "Collection person" }, { key: "count", label: "Receipts", type: "number" }, amount],
          rows: rollUp(
            shown,
            (r) => r.person_id ?? "none",
            (r) => ({ person: r.person ?? NOT_ASSIGNED, href: drill("/reports/collection-person", q, { view: "lines", person: r.person_id ?? "none" }) }),
            (r) => ({ count: 1n, amount: BigInt(r.amount) }),
          ).sort(personOrder("person")),
        };
  return {
    report: { title: "Collection-person-wise collection", filters: [`Period: ${rangeText(range)}`, ...pickFilters(picks)], generatedAt: now, tables: [main] },
    period,
    error,
    periods: REPORT_PERIODS,
    picks,
  };
}

// ---- Pending payment (S20 #17, D25): vendor bills still open

/**
 * S20 #17: active purchase bills with an open amount (total − live vendor allocations, A§5), oldest first, with due
 * date, computed status and aging by bill date (D17). Bill totals only — no rates — so no can_view_cost needed (as
 * the vendor pages); the bill page itself needs it, so others drill to the vendor.
 */
export async function pendingPaymentReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const { period, range, error } = reportRange(q, "all");
  const today = todayIST(now);
  const [purchaseBills, openingBills, vendorList] = await Promise.all([
    listPurchaseBills(),
    vendorOpeningBills(),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
  ]);
  // Opening bills (T43) are pending payments too, aged by their bill date; they have no page (→ the vendor).
  const bills = [
    ...purchaseBills.map((b) => ({ ...b, href: `/purchase-bills/${b.id}` })),
    ...openingBills.map((b) => ({
      id: b.id, number: openingBillLabel(b.billNo), vendorBillNo: b.billNo, date: b.billDate, dueDate: b.dueDate, vendorId: b.vendorId, vendor: b.vendor,
      status: b.status, total: b.amountPaise, open: b.open, payment: b.payment, href: `/vendors/${b.vendorId}`,
    })),
  ];
  const picks = [
    pick("vendor", "Vendor", vendorList.map((v): [string, string] => [String(v.id), v.name]), q),
    pick("aging", "Aging", AGING.map((b): [string, string] => [b.key, b.label]), q),
  ];
  const [vendor, aging] = picks.map((p) => p.value);
  const cost = canViewCost(user);
  const rows = bills
    .filter((b) => b.status === "active" && b.open > 0n)
    .map((b) => ({ ...b, age: daysBetween(b.date, today) }))
    .filter(
      (b) =>
        (!range.from || b.date >= range.from) &&
        (!range.to || b.date <= range.to) &&
        (!vendor || String(b.vendorId) === vendor) &&
        (!aging || agingBucket(b.age) === aging),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number.localeCompare(b.number)));
  const buckets = Object.fromEntries(AGING.map((b) => [b.key, 0n]));
  for (const b of rows) buckets[agingBucket(b.age)] += b.open;

  return {
    report: {
      title: "Pending payment report",
      filters: [`As of ${formatDate(today)} · aging by bill date`, ...dated("Bills dated", range), ...pickFilters(picks)],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "number", label: "Bill" },
            { key: "vendorBillNo", label: "Vendor bill no" },
            { key: "date", label: "Bill date", type: "date" },
            { key: "dueDate", label: "Due", type: "date" },
            { key: "vendor", label: "Vendor" },
            { key: "age", label: "Age (days)", type: "number" },
            { key: "aging", label: "Aging" },
            { key: "status", label: "Status" },
            moneyCol("total", "Total"),
            moneyCol("open", "Open"),
          ],
          rows: rows.map((b) => ({
            href: cost ? b.href : `/vendors/${b.vendorId}`,
            number: b.number,
            vendorBillNo: b.vendorBillNo,
            date: b.date,
            dueDate: b.dueDate,
            vendor: b.vendor,
            age: BigInt(b.age),
            aging: AGING.find((x) => x.key === agingBucket(b.age))!.label,
            status: b.payment,
            total: b.total,
            open: b.open,
          })),
        },
        {
          title: "Aging",
          columns: [{ key: "label", label: "Bucket" }, moneyCol("amount", "Open")],
          rows: AGING.map((b) => ({ label: b.label, amount: buckets[b.key] })),
        },
      ],
    },
    period,
    error,
    periods: OPEN_PERIODS,
    picks,
  };
}

// ---- Advance received (S20 #18, A§13)

const ADVANCE_TYPE = {
  receipt: "On account (receipt)",
  credit_note: "Credit note (unused)",
  job: "Job advance",
  print_job: "Print job (not billed)",
} as const;
type AdvanceType = keyof typeof ADVANCE_TYPE;

/**
 * S20 #18: customer money not yet set against a bill — receipts' unallocated rest and issued credit notes' leftover
 * credit (on account, D49) + live advances on jobs not yet invoiced and money on print jobs not yet billed (they move
 * to the invoice at Issue, T14, D64). As of now; the period picks the receipts / credit notes by date.
 */
export async function advanceReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view")) return null;
  const { period, range, error } = reportRange(q, "all");
  const rows = await db.execute<{ type: AdvanceType; doc_id: string; number: string; date: string; customer_id: string; customer: string; firm_name: string | null; job_id: string | null; job: string | null; amount: string }>(sql`
    select a.type, a.doc_id, a.number, a.date::text as date, a.customer_id, a.job_id, a.job, a.amount, c.name as customer, c.firm_name from (
      select 'receipt' as type, r.id as doc_id, r.number, r.date, r.customer_id, null::bigint as job_id, null as job,
        r.amount_paise - coalesce((select sum(x.amount_paise) from allocations x where x.receipt_id = r.id and x.active), 0) as amount
      from receipts r where r.status = 'active'
      union all
      select 'credit_note', n.id, n.number, n.date, n.customer_id, null, null,
        n.total_paise - coalesce((select sum(x.amount_paise) from allocations x where x.credit_note_id = n.id and x.active), 0)
      from credit_notes n where n.status = 'issued'
      union all
      select 'job', coalesce(r.id, n.id), coalesce(r.number, n.number), coalesce(r.date, n.date), j.customer_id, j.id, j.number, x.amount_paise
      from allocations x join jobs j on j.id = x.job_id
        left join receipts r on r.id = x.receipt_id
        left join credit_notes n on n.id = x.credit_note_id
      where x.active and (r.id is null or r.status <> 'cancelled') and (n.id is null or n.status <> 'cancelled')
      union all
      select 'print_job', coalesce(r.id, n.id), coalesce(r.number, n.number), coalesce(r.date, n.date), p.customer_id, p.id, p.number, x.amount_paise
      from allocations x join print_jobs p on p.id = x.print_job_id
        left join receipts r on r.id = x.receipt_id
        left join credit_notes n on n.id = x.credit_note_id
      where x.active and (r.id is null or r.status <> 'cancelled') and (n.id is null or n.status <> 'cancelled')
    ) a join customers c on c.id = a.customer_id
    where a.amount > 0 and ${inRange(sql.raw("a.date"), range)}
    order by a.date, a.number, a.job`);
  const picks = [pick("type", "Type", Object.entries(ADVANCE_TYPE) as [string, string][], q)];
  const [type] = picks.map((p) => p.value);
  const shown = rows.filter((r) => !type || r.type === type);
  // job_id / job: the job, or for a print job the print job (its number shows in the Job column).
  const href = (r: (typeof rows)[number]) =>
    r.type === "job"
      ? `/jobs/${r.job_id}`
      : r.type === "print_job"
        ? `/print-jobs/${r.job_id}`
        : r.type === "receipt"
          ? `/receipts/${r.doc_id}`
          : `/credit-debit-notes/cn/${r.doc_id}`;
  const amount = moneyCol("amount", "Advance");

  return {
    report: {
      title: "Advance received report",
      filters: [`As of ${formatDate(todayIST(now))}`, ...dated("Received", range), ...pickFilters(picks)],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "date", label: "Date", type: "date" },
            { key: "number", label: "Document" },
            { key: "customer", label: "Customer" },
            { key: "type", label: "Type" },
            { key: "job", label: "Job / print job" },
            amount,
          ],
          rows: shown.map((r) => ({
            href: href(r),
            date: r.date,
            number: r.number,
            customer: party(r.customer, r.firm_name),
            type: ADVANCE_TYPE[r.type],
            job: r.job,
            amount: BigInt(r.amount),
          })),
        },
        {
          title: "Totals by type",
          columns: [{ key: "type", label: "Type" }, amount],
          rows: rollUp(shown, (r) => r.type, (r) => ({ type: ADVANCE_TYPE[r.type] }), (r) => ({ amount: BigInt(r.amount) })),
        },
      ],
    },
    period,
    error,
    periods: OPEN_PERIODS,
    picks,
  };
}
