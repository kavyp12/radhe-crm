import { or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { formatDate } from "@/lib/dates";
import { formatMoney, parseMoney } from "@/lib/num";
import { can, canViewCost, type Area, type SessionUser } from "@/lib/permissions";

// Universal search (S26, D62, D63): one call, at most 5 hits per type, each type only if the user can view its area
// (A§8) — so production gets jobs, material requests and stock issues only, and without "money" on jobs no amount
// search. Names match fuzzily (pg_trgm word similarity), document numbers with or without zero padding (RDS-2026-125 =
// RDS-2026-00125), an amount ("25,000", "₹25,000.50") the documents whose total equals it. Every match runs on a
// migration 0050 / 0051 index. A hit is display text, a link and the total when the user may see it — never a cost
// field: a purchase bill's, PO's or GRN's total only with can_view_cost.

export type SearchHit = { title: string; detail: string; href: string; amount?: string };
export type SearchGroup = { label: string; hits: SearchHit[] };

const LIMIT = 5;
// pg_trgm's default word-similarity threshold (0.6) misses common spellings (Mahalakshmi ~ Mahalaxmi = 0.5).
const FUZZY = "0.4";

/** Drops the zero padding of a number's last group, like the 0050 indexes: QT/26-27/0014 → QT/26-27/14. */
export const unpadded = (number: string) => number.replace(/([/-])0+(\d+)$/, "$1$2");
const UNPADDED = (column: string) => sql.raw(`regexp_replace(${column}, '([/-])0+([0-9]+)$', '\\1\\2')`);
const contains = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

/** "25000" · "25,000" · "₹25,000.50" · "Rs. 25,000/-" → paise; anything else → null. */
export function searchAmount(q: string): bigint | null {
  const s = q.replace(/^(₹|rs\.?|inr)/i, "").replace(/\/-$/, "").replace(/\s/g, "");
  if (!/^\d/.test(s)) return null;
  try {
    const paise = parseMoney(s);
    return paise > 0n ? paise : null;
  } catch {
    return null;
  }
}

/** What one query can mean; LIKE patterns are '%…%'. null fields = not that kind of term. */
type Terms = {
  q: string;
  text: string;
  number: { exact: string; like: string } | null;
  mobile: string | null; // digits
  code: string | null; // letters + digits, upper case (GSTIN, vehicle no)
  amount: bigint | null;
};

function termsOf(input: string): Terms | null {
  const q = input.trim().slice(0, 100);
  if (q.length < 3) return null; // a trigram index needs 3 characters
  const number = unpadded(q.toUpperCase());
  const code = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = q.replace(/\D/g, "").slice(-10); // "+91 98250 12345" → 9825012345
  return {
    q,
    text: contains(q),
    number: /\d/.test(q) ? { exact: number, like: contains(number) } : null,
    mobile: /^[+\d\s()-]+$/.test(q) && digits.length >= 3 ? `%${digits}%` : null,
    code: code.length >= 3 ? `%${code}%` : null,
    amount: searchAmount(q),
  };
}

const statusText = (s: string) =>
  s === "active" || s === "issued" ? null : s.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const line = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(" · ");

type PartyRow = { id: string; name: string; firm_name?: string | null; mobile: string | null; gstin: string | null; active: boolean };

/** Customers (name or firm, fuzzy; mobile; GSTIN) or vendors (name, fuzzy; mobile; GSTIN), best name match first. */
async function partyHits(tx: Tx, t: Terms, table: "customers" | "vendors"): Promise<SearchHit[]> {
  const names = table === "customers" ? ["name", "firm_name"] : ["name"];
  const where = or(
    ...names.flatMap((n) => [sql`${sql.raw(n)} ilike ${t.text}`, sql`${t.q} <% ${sql.raw(n)}`]),
    t.mobile ? sql`regexp_replace(mobile, '[^0-9]', '', 'g') like ${t.mobile}` : undefined,
    t.code ? sql`gstin like ${t.code}` : undefined,
  );
  const similarity = sql.join(names.map((n) => sql`word_similarity(${t.q}, coalesce(${sql.raw(n)}, ''))`), sql`, `);
  const rows = await tx.execute<PartyRow>(sql`
    select id, ${sql.raw(names.join(", "))}, mobile, gstin, active from ${sql.raw(table)}
    where ${where}
    order by greatest(${similarity}) desc, id desc
    limit ${LIMIT}`);
  return rows.map((r) => ({
    title: r.firm_name ? `${r.name} · ${r.firm_name}` : r.name,
    detail: line(r.mobile, r.gstin, !r.active && "Inactive"),
    href: `/${table}/${r.id}`,
  }));
}

/** Jobs: number (with or without padding), site reference, vehicle no (separators ignored), total (with money only). */
async function jobHits(tx: Tx, t: Terms, money: boolean): Promise<SearchHit[]> {
  const where = or(
    t.number ? sql`${UNPADDED("j.number")} like ${t.number.like}` : undefined,
    sql`j.site_reference ilike ${t.text}`,
    t.code ? sql`regexp_replace(upper(j.vehicle_no), '[^A-Z0-9]', '', 'g') like ${t.code}` : undefined,
    money && t.amount ? sql`j.total_paise = ${t.amount}` : undefined,
  );
  const rows = await tx.execute<{
    id: string; number: string; date: string; status: string; total: string; site: string | null; vehicle: string | null; party: string;
  }>(sql`
    select j.id, j.number, j.date, j.status, j.total_paise as total, j.site_reference as site, j.vehicle_no as vehicle,
      c.name || coalesce(' · ' || c.firm_name, '') as party
    from jobs j join customers c on c.id = j.customer_id
    where ${where}
    order by (${UNPADDED("j.number")} = ${t.number?.exact ?? null}) is true desc, j.date desc, j.id desc
    limit ${LIMIT}`);
  return rows.map((r) => ({
    title: r.number,
    detail: line(r.party, r.site, r.vehicle, formatDate(r.date), statusText(r.status)),
    href: `/jobs/${r.id}`,
    ...(money ? { amount: formatMoney(BigInt(r.total)) } : {}),
  }));
}

type DocRow = { id: string; number: string | null; date: string; status: string; total: string; party: string; party_id: string; kind: string | null };
type Doc = {
  label: string;
  area: Area;
  /** any access to the area is enough (the page lists them for anyone with access); default: view */
  anyAccess?: true;
  /** "<table> d join <party> p on …" */
  from: string;
  /** none: no amount shown or searched (none, or a cost value) */
  total?: string;
  party: string;
  /** SQL giving a label for the document's kind, e.g. Estimate / Tax invoice */
  kind?: string;
  status?: string;
  /** may see (and search by) the total; default yes */
  money?: (user: SessionUser) => boolean;
  /** found by its total as well (needs an index on it); default yes */
  byAmount?: false;
  /** another match besides number and total */
  also?: (t: Terms) => SQL;
  href: (r: DocRow, user: SessionUser) => string;
};

const CUSTOMER = "p.name || coalesce(' · ' || p.firm_name, '')";
const ON_CUSTOMER = "join customers p on p.id = d.customer_id";
const DOCS: Doc[] = [
  { label: "Quotations", area: "quotations", from: `quotations d ${ON_CUSTOMER}`, total: "d.total_paise", party: CUSTOMER, href: (r) => `/quotations/${r.id}` },
  {
    label: "Invoices & estimates", area: "invoices", from: `invoices d ${ON_CUSTOMER}`, total: "d.total_paise", party: CUSTOMER,
    kind: "case d.kind when 'estimate' then 'Estimate' else 'Tax invoice' end",
    href: (r) => `/invoices/${r.id}`,
  },
  { label: "Credit notes", area: "invoices", from: `credit_notes d ${ON_CUSTOMER}`, total: "d.total_paise", party: CUSTOMER, href: (r) => `/credit-debit-notes/cn/${r.id}` },
  { label: "Debit notes", area: "invoices", from: `debit_notes d ${ON_CUSTOMER}`, total: "d.total_paise", party: CUSTOMER, href: (r) => `/credit-debit-notes/dn/${r.id}` },
  { label: "Receipts", area: "payments", from: `receipts d ${ON_CUSTOMER}`, total: "d.amount_paise", party: CUSTOMER, href: (r) => `/receipts/${r.id}` },
  {
    label: "Vendor payments", area: "payments", from: "vendor_payments d join vendors p on p.id = d.vendor_id", total: "d.amount_paise", party: "p.name",
    href: (r) => `/vendor-payments/${r.id}`,
  },
  // Purchase rates (D51): the total and the bill page need can_view_cost; without it the hit opens the vendor (as T32).
  {
    label: "Purchase bills", area: "books", from: "purchase_bills d join vendors p on p.id = d.vendor_id", total: "d.total_paise",
    party: "p.name || ' · bill ' || d.vendor_bill_no", money: canViewCost, also: (t) => sql`d.vendor_bill_no ilike ${t.text}`,
    href: (r, user) => (canViewCost(user) ? `/purchase-bills/${r.id}` : `/vendors/${r.party_id}`),
  },
  {
    label: "Expenses", area: "books", from: "expenses d join expense_categories p on p.id = d.category_id", total: "d.amount_paise", party: "p.name",
    href: (r) => `/expenses/${r.id}`,
  },
  // D63: these by number only. PO / GRN totals are purchase rates (their pages need can_view_cost, else the vendor);
  // stock issue and adjustment values are stock values, so never shown here.
  {
    label: "Material requests", area: "materialRequests", from: "material_requests d left join jobs p on p.id = d.job_id", party: "p.number",
    href: (r) => `/material-requests/${r.id}`,
  },
  {
    label: "Purchase orders", area: "purchaseOrders", from: "purchase_orders d join vendors p on p.id = d.vendor_id", total: "d.total_paise",
    party: "p.name", money: canViewCost, byAmount: false,
    href: (r, user) => (canViewCost(user) ? `/purchase-orders/${r.id}` : `/vendors/${r.party_id}`),
  },
  {
    label: "Material receive", area: "goodsReceipts",
    from: "goods_receipts d join purchase_orders o on o.id = d.order_id join vendors p on p.id = o.vendor_id",
    total: "(select sum(l.value_paise) from goods_receipt_lines l where l.receipt_id = d.id)", party: "p.name || ' · ' || o.number",
    money: canViewCost, byAmount: false,
    href: (r, user) => (canViewCost(user) ? `/material-receive/${r.id}` : `/vendors/${r.party_id}`),
  },
  {
    label: "Stock issues", area: "stockIssue", from: "stock_issues d join jobs p on p.id = d.job_id", party: "p.number",
    kind: "case d.kind when 'return' then 'Return' else 'Issue' end", href: (r) => `/issue-to-job/${r.id}`,
  },
  {
    label: "Stock adjustments", area: "stockAdjustment", anyAccess: true, from: "stock_adjustments d join stock_items p on p.id = d.item_id",
    party: "p.name", status: "'active'", href: () => "/stock-adjustments", // no page of its own
  },
  {
    label: "Transfers", area: "books", from: "transfers d join accounts p on p.id = d.from_account_id join accounts t on t.id = d.to_account_id",
    total: "d.amount_paise", party: "p.name || ' → ' || t.name", byAmount: false, href: (r) => `/cash-bank/transfers/${r.id}`,
  },
  {
    label: "Journal vouchers", area: "books", from: "adjustments d left join customers p on p.id = d.customer_id", total: "d.amount_paise",
    party: `coalesce(${CUSTOMER}, left(d.narration, 60))`, byAmount: false,
    kind: "case d.kind when 'write_off' then 'Write-off' when 'discount' then 'Settlement discount' when 'refund' then 'Refund' end",
    href: (r) => `/journal-vouchers/${r.id}`,
  },
];

/** A numbered document: its number (with or without padding), its total (when the user may see it), `also`. */
async function docHits(tx: Tx, doc: Doc, t: Terms, user: SessionUser): Promise<SearchHit[]> {
  const money = !!doc.total && (doc.money?.(user) ?? true);
  const where = or(
    t.number ? sql`${UNPADDED("d.number")} like ${t.number.like}` : undefined,
    doc.also?.(t),
    money && doc.byAmount !== false && t.amount ? sql`${sql.raw(doc.total!)} = ${t.amount}` : undefined,
  );
  if (!where) return [];
  const rows = await tx.execute<DocRow>(sql`
    select d.id, d.number, d.date, ${sql.raw(doc.status ?? "d.status")} as status, ${sql.raw(doc.total ?? "null")} as total,
      ${sql.raw(doc.party)} as party, p.id as party_id, ${sql.raw(doc.kind ?? "null")} as kind
    from ${sql.raw(doc.from)}
    where ${where}
    order by (${UNPADDED("d.number")} = ${t.number?.exact ?? null}) is true desc, d.date desc, d.id desc
    limit ${LIMIT}`);
  return rows.map((r) => ({
    title: r.number ?? "Draft", // invoices and notes are numbered at Issue
    detail: line(r.kind, r.party, formatDate(r.date), !!r.number && statusText(r.status)),
    href: doc.href(r, user),
    ...(money ? { amount: formatMoney(BigInt(r.total)) } : {}),
  }));
}

/** Every type the user may view that matches `input` (3+ characters), in a fixed order; empty groups left out. */
export async function search(user: SessionUser, input: string): Promise<SearchGroup[]> {
  const t = termsOf(input);
  if (!t) return [];
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${FUZZY}, true)`);
      const runs: [string, () => Promise<SearchHit[]>][] = [];
      if (can(user, "customers", "view")) runs.push(["Customers", () => partyHits(tx, t, "customers")]);
      if (can(user, "jobs", "view")) runs.push(["Jobs", () => jobHits(tx, t, can(user, "jobs", "money"))]);
      for (const doc of DOCS) if (can(user, doc.area, doc.anyAccess ? undefined : "view")) runs.push([doc.label, () => docHits(tx, doc, t, user)]);
      if (can(user, "vendors", "view")) runs.push(["Vendors", () => partyHits(tx, t, "vendors")]);
      const hits = await Promise.all(runs.map(([, run]) => run()));
      return runs.map(([label], i) => ({ label, hits: hits[i] })).filter((g) => g.hits.length > 0);
    },
    { accessMode: "read only" },
  );
}
