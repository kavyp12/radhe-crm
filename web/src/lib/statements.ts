import { eq } from "drizzle-orm";
import { db, writeTx } from "@/db";
import { statementLinks } from "@/db/schema";
import { formatDate, fyStart, parseDate, periodRange, todayIST } from "@/lib/dates";
import { ledger } from "@/lib/ledger";
import { formatMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";
import { newShareToken } from "@/lib/sales";

// Customer ledger and statement (S15, A§13 #4): the customer's AR lines from the journal (lib/ledger.ts ledger()) with
// the opening balance, a running balance (+ = Dr, they owe us) and the closing balance. Nothing is stored but the
// share-link rows (D49); the figures are read when asked.

export const LEDGER_PERIODS = {
  fy: "This financial year",
  month: "This month",
  week: "This week",
  today: "Today",
  yesterday: "Yesterday",
  all: "All entries",
  custom: "Custom…",
} as const;
export type LedgerPeriod = keyof typeof LEDGER_PERIODS;
/** 'YYYY-MM-DD' or null (open-ended). */
export type Range = { from: string | null; to: string | null };

/** A ledger view's range from the page's search params. Unreadable custom dates → an error and the whole ledger. */
export function readRange(period?: string, fromText?: string, toText?: string): { period: LedgerPeriod; range: Range; error: string | null } {
  const today = todayIST();
  const p: LedgerPeriod = period && period in LEDGER_PERIODS ? (period as LedgerPeriod) : "fy";
  if (p === "all") return { period: p, range: { from: null, to: null }, error: null };
  if (p === "fy") return { period: p, range: { from: fyStart(today), to: today }, error: null };
  if (p !== "custom") return { period: p, range: periodRange(p), error: null };
  try {
    const from = fromText?.trim() ? parseDate(fromText) : null;
    const to = toText?.trim() ? parseDate(toText) : null;
    if (from && to && from > to) return { period: p, range: { from: null, to: null }, error: "The From date is after the To date." };
    return { period: p, range: { from, to }, error: null };
  } catch {
    return { period: p, range: { from: null, to: null }, error: "Use DD/MM/YYYY for the dates, e.g. 01/04/2026." };
  }
}

/** "01/04/2026 – 29/09/2026", "Up to 29/09/2026", "All entries". */
export function rangeText({ from, to }: Range): string {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
  if (from) return `From ${formatDate(from)}`;
  if (to) return `Up to ${formatDate(to)}`;
  return "All entries";
}

const DOC_LABEL: Record<string, string> = {
  customers: "Opening balance",
  invoices: "Invoice",
  receipts: "Receipt",
  credit_notes: "Credit note",
  debit_notes: "Debit note",
};

/** What a ledger line is: "Invoice", "Estimate", "Receipt", "Receipt (cancelled)" … */
export function entryLabel(row: { docType: string; number: string | null; reverses: number | null }): string {
  const label = row.docType === "invoices" && row.number?.startsWith("EST/") ? "Estimate" : (DOC_LABEL[row.docType] ?? row.docType);
  return row.reverses === null ? label : `${label} (reversed)`;
}

/** "₹1,500.00 Dr" / "₹200.00 Cr" / "₹0.00" (+ = Dr). */
export const drCr = (paise: bigint) => (paise === 0n ? formatMoney(0n) : `${formatMoney(paise < 0n ? -paise : paise)} ${paise < 0n ? "Cr" : "Dr"}`);

/** The customer's AR ledger for the range, with Dr / Cr totals: what the Ledger tab and the statement PDF show. */
export async function customerLedger(customerId: number, range: Range) {
  const l = await ledger({ account: "ar", customerId }, range.from ?? undefined, range.to ?? undefined);
  const sum = (side: "debit" | "credit") => l.rows.reduce((s, r) => s + r[side], 0n);
  return { ...l, debit: sum("debit"), credit: sum("credit") };
}

type LedgerRow = { entryId: number; reverses: number | null; debit: bigint; credit: bigint };

/**
 * What the statement PDF / share link shows (D50): the ledger without entries that were reversed together with their
 * reversals (cancelled / edited documents — a pair nets to zero), running balance and totals recomputed. Only pairs
 * both inside the range are dropped, so the closing balance never changes. The in-app ledger shows everything.
 */
export function withoutReversed<R extends LedgerRow>(l: { opening: bigint; rows: R[] }) {
  const ids = new Set(l.rows.map((r) => r.entryId));
  const reversed = new Set(l.rows.filter((r) => r.reverses !== null && ids.has(r.reverses)).map((r) => r.reverses));
  let balance = l.opening;
  const rows = l.rows
    .filter((r) => !(r.reverses !== null && ids.has(r.reverses)) && !reversed.has(r.entryId))
    .map((r) => {
      balance += r.debit - r.credit;
      return { ...r, balance };
    });
  const sum = (side: "debit" | "credit") => rows.reduce((s, r) => s + r[side], 0n);
  return { opening: l.opening, rows, closing: balance, debit: sum("debit"), credit: sum("credit") };
}

/** A public link to this statement (D49): a new token row; the PDF is built from the journal each time it is opened. */
export async function createStatementLink(actor: SessionUser, customerId: number, range: Range): Promise<string> {
  if (!can(actor, "customers", "money")) throw new Error("Not allowed");
  const token = newShareToken();
  await writeTx(actor, (tx) =>
    tx.insert(statementLinks).values({ token, customerId, fromDate: range.from, toDate: range.to, createdBy: actor.id }),
  );
  return token;
}

export async function statementLink(token: string) {
  const [row] = await db.select().from(statementLinks).where(eq(statementLinks.token, token));
  return row;
}

/** The WhatsApp / email text for a statement. */
export function statementMessage(d: { name: string; range: Range; closing: bigint; link?: string; company: string | null }) {
  return [
    `Dear ${d.name},`,
    "",
    `Please find your statement of account (${rangeText(d.range)}). Closing balance: ${drCr(d.closing)}.`,
    ...(d.link ? [d.link] : []),
    "",
    "Regards,",
    d.company ?? "",
  ]
    .join("\n")
    .trim();
}
