import { eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { customers, debitNotes, invoices, journalLines, openingBills, users } from "@/db/schema";
import { openingBillLabel, paidByDebitNote, paidByInvoice, paidByOpeningBill } from "@/lib/allocations";
import { dateParts, todayIST } from "@/lib/dates";
import { systemAccountId } from "@/lib/ledger";

// Outstanding & aging (S7, D17, D57). A customer's total is their AR balance from the journal. Aging covers the open
// issued invoices (estimates included, D18), debit notes and opening bills (T43, by their bill date), by age in days;
// "due today" / "overdue" compare the due date (date + credit days) with today. What's left of the AR balance — an
// opening balance that isn't bill-wise, on-account money and job advances (negative), JVs not settling a document —
// is its own "Opening / on account" line, so every view adds up to AR. Nothing here is a cost field (sales may open it, A§8).

export const AGING = [
  { key: "d0_7", label: "0–7 days", upTo: 7 },
  { key: "d8_15", label: "8–15 days", upTo: 15 },
  { key: "d16_30", label: "16–30 days", upTo: 30 },
  { key: "d31_60", label: "31–60 days", upTo: 60 },
  { key: "d60", label: "60+ days", upTo: Infinity },
] as const;
export type AgingKey = (typeof AGING)[number]["key"];

/** D17: the bucket of a document `age` days old (a future-dated one counts as 0–7). */
export const agingBucket = (age: number): AgingKey => AGING.find((b) => age <= b.upTo)!.key;

const dayNumber = (date: string) => {
  const [y, m, d] = dateParts(date);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
/** Whole days from `from` to `to` ('YYYY-MM-DD'). */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

export type Totals = { total: bigint; dueToday: bigint; overdue: bigint; aging: Record<AgingKey, bigint>; onAccount: bigint };
export const emptyTotals = (): Totals => ({
  total: 0n,
  dueToday: 0n,
  overdue: 0n,
  aging: Object.fromEntries(AGING.map((b) => [b.key, 0n])) as Record<AgingKey, bigint>,
  onAccount: 0n,
});
export function addTotals(into: Totals, t: Totals) {
  into.total += t.total;
  into.dueToday += t.dueToday;
  into.overdue += t.overdue;
  into.onAccount += t.onAccount;
  for (const b of AGING) into.aging[b.key] += t.aging[b.key];
  return into;
}

export type OutstandingDoc = {
  target: "invoice" | "debit_note" | "opening_bill";
  id: number;
  number: string;
  customerId: number;
  date: string;
  dueDate: string;
  total: bigint;
  open: bigint;
  age: number;
  bucket: AgingKey;
  due: "today" | "overdue" | null;
};

/** What an outstanding document is, and where it opens (an opening bill has no page: the customer's). */
export const docKind = (d: OutstandingDoc) =>
  d.target === "opening_bill" ? "Opening bill" : d.target === "debit_note" ? "Debit note" : d.number.startsWith("EST/") ? "Estimate" : "Invoice";
export const docHref = (d: OutstandingDoc) =>
  d.target === "invoice" ? `/invoices/${d.id}` : d.target === "debit_note" ? `/credit-debit-notes/dn/${d.id}` : `/customers/${d.customerId}`;

const ORDER = { opening_bill: 0, invoice: 1, debit_note: 2 } as const;

/** Every customer with an AR balance or an open document, as of `today`: totals (= AR) and open documents (oldest first). */
export async function outstanding(today = todayIST()) {
  const ar = await systemAccountId("ar");
  const paid = paidByInvoice();
  const dnPaid = paidByDebitNote();
  const obPaid = paidByOpeningBill();
  const salesPerson = alias(users, "sales_person");
  const collectionPerson = alias(users, "collection_person");
  const [balances, invoiceRows, noteRows, openingRows, people] = await Promise.all([
    db
      .select({ customerId: journalLines.customerId, paise: sql<string>`sum(${journalLines.debitPaise} - ${journalLines.creditPaise})` })
      .from(journalLines)
      .where(eq(journalLines.accountId, ar))
      .groupBy(journalLines.customerId),
    db
      .select({ id: invoices.id, number: invoices.number, customerId: invoices.customerId, date: invoices.date, dueDate: invoices.dueDate, total: invoices.totalPaise, paid: paid.paise })
      .from(invoices)
      .leftJoin(paid, eq(paid.invoiceId, invoices.id))
      .where(eq(invoices.status, "issued")),
    db
      .select({ id: debitNotes.id, number: debitNotes.number, customerId: debitNotes.customerId, date: debitNotes.date, dueDate: debitNotes.dueDate, total: debitNotes.totalPaise, paid: dnPaid.paise })
      .from(debitNotes)
      .leftJoin(dnPaid, eq(dnPaid.debitNoteId, debitNotes.id))
      .where(eq(debitNotes.status, "issued")),
    db
      .select({ id: openingBills.id, billNo: openingBills.billNo, customerId: openingBills.customerId, date: openingBills.billDate, dueDate: openingBills.dueDate, total: openingBills.amountPaise, paid: obPaid.paise })
      .from(openingBills)
      .leftJoin(obPaid, eq(obPaid.openingBillId, openingBills.id))
      .where(isNotNull(openingBills.customerId)),
    db
      .select({
        id: customers.id,
        name: customers.name,
        firmName: customers.firmName,
        mobile: customers.mobile,
        salesPersonId: customers.salesPersonId,
        salesPerson: salesPerson.name,
        collectionPersonId: customers.collectionPersonId,
        collectionPerson: collectionPerson.name,
      })
      .from(customers)
      .leftJoin(salesPerson, eq(salesPerson.id, customers.salesPersonId))
      .leftJoin(collectionPerson, eq(collectionPerson.id, customers.collectionPersonId)),
  ]);

  const docs: OutstandingDoc[] = [
    ...invoiceRows.map((r) => ({ ...r, target: "invoice" as const })),
    ...noteRows.map((r) => ({ ...r, target: "debit_note" as const })),
    ...openingRows.map(({ billNo, customerId, ...r }) => ({ ...r, customerId: customerId!, number: openingBillLabel(billNo), target: "opening_bill" as const })),
  ]
    .map((r) => {
      const dueDate = r.dueDate ?? r.date;
      const age = daysBetween(r.date, today);
      return {
        target: r.target,
        id: r.id,
        number: r.number ?? "",
        customerId: r.customerId,
        date: r.date,
        dueDate,
        total: r.total,
        open: r.total - BigInt(r.paid ?? 0),
        age,
        bucket: agingBucket(age),
        due: dueDate === today ? ("today" as const) : dueDate < today ? ("overdue" as const) : null,
      };
    })
    .filter((d) => d.open > 0n)
    // Oldest first; same date: opening bills, invoices, then debit notes, then by number (as openInvoices).
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date ? -1 : 1
        : a.target !== b.target
          ? ORDER[a.target] - ORDER[b.target]
          : a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
    );

  const balanceOf = new Map(balances.map((b) => [b.customerId, BigInt(b.paise)]));
  const rows = people
    .map((c) => {
      const mine = docs.filter((d) => d.customerId === c.id);
      const totals = emptyTotals();
      totals.total = balanceOf.get(c.id) ?? 0n;
      let open = 0n;
      for (const d of mine) {
        open += d.open;
        totals.aging[d.bucket] += d.open;
        if (d.due === "today") totals.dueToday += d.open;
        if (d.due === "overdue") totals.overdue += d.open;
      }
      totals.onAccount = totals.total - open;
      return { ...c, totals, docs: mine };
    })
    .filter((c) => c.totals.total !== 0n || c.docs.length > 0)
    .sort((a, b) => (a.totals.total > b.totals.total ? -1 : a.totals.total < b.totals.total ? 1 : a.name.localeCompare(b.name)));

  return { today, customers: rows, totals: rows.reduce((t, c) => addTotals(t, c.totals), emptyTotals()) };
}

export type OutstandingCustomer = Awaited<ReturnType<typeof outstanding>>["customers"][number];
export type PersonKind = "sales" | "collection";

/** Customers grouped by their assigned sales / collection person (D57); "none" = not assigned. */
export function byPerson(rows: OutstandingCustomer[], kind: PersonKind) {
  const groups = new Map<string, { id: string; name: string; customers: OutstandingCustomer[]; totals: Totals }>();
  for (const c of rows) {
    const [id, name] = kind === "sales" ? [c.salesPersonId, c.salesPerson] : [c.collectionPersonId, c.collectionPerson];
    const key = id ?? "none";
    const g = groups.get(key) ?? { id: key, name: name ?? "Not assigned", customers: [], totals: emptyTotals() };
    g.customers.push(c);
    addTotals(g.totals, c.totals);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.id === "none" ? 1 : b.id === "none" ? -1 : a.name.localeCompare(b.name)));
}
