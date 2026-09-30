import { and, eq, isNull, sql } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db } from "@/db";
import {
  allocations,
  creditNotes,
  debitNotes,
  invoiceLines,
  invoices,
  jobs,
  quotationLines,
  quotations,
  receipts,
} from "@/db/schema";
import { paidTowards, paidTowardsDebitNotes, paymentStatus } from "@/lib/allocations";
import { JOB_STATUS } from "@/lib/jobs";
import { QUOTATION_STATUS } from "@/lib/quotations";

// A customer's history (S1, A§5): quotation → job → invoice → payment → pending. Documents joined by their links
// (a job's quotation, an invoice line's job or quotation line) form one chain; each chain gets the pipeline label:
// the invoice's payment status once issued, else the job's status, else the quotation's.

type Doc = { id: number; number: string; date: string; status: Status };
export type Chain = {
  key: string;
  date: string; // the newest document date, for sorting
  label: Status;
  quotations: Doc[];
  jobs: Doc[];
  invoices: (Doc & { total: bigint; open: bigint; payment: Status | null })[];
  /** Credit / debit notes against its invoices (T16). */
  notes: (Doc & { kind: "credit" | "debit"; total: bigint; payment: Status | null })[];
  payments: { receiptId: number; number: string; date: string; amount: bigint }[];
  pending: bigint; // Σ open of its issued invoices and debit notes
};

/** Worst first: the label a chain with several issued invoices shows. */
const PAYMENT_ORDER: Status[] = ["Overdue", "Unpaid", "Part Payment", "Paid"];

export async function customerHistory(customerId: number): Promise<Chain[]> {
  const noteRows = (t: typeof creditNotes) =>
    db
      .select({ id: t.id, number: t.number, date: t.date, dueDate: t.dueDate, status: t.status, totalPaise: t.totalPaise, invoiceId: t.invoiceId })
      .from(t)
      .where(eq(t.customerId, customerId));
  const [qs, js, invs, links, pays, cns, dns] = await Promise.all([
    db
      .select({ id: quotations.id, number: quotations.number, date: quotations.date, status: quotations.status })
      .from(quotations)
      .where(eq(quotations.customerId, customerId)),
    db
      .select({ id: jobs.id, number: jobs.number, date: jobs.date, status: jobs.status, quotationId: jobs.quotationId })
      .from(jobs)
      .where(eq(jobs.customerId, customerId)),
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        dueDate: invoices.dueDate,
        status: invoices.status,
        totalPaise: invoices.totalPaise,
      })
      .from(invoices)
      .where(eq(invoices.customerId, customerId)),
    db
      .selectDistinct({ invoiceId: invoiceLines.invoiceId, jobId: invoiceLines.jobId, quotationId: quotationLines.quotationId })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .leftJoin(quotationLines, eq(quotationLines.id, invoiceLines.quotationLineId))
      .where(eq(invoices.customerId, customerId)),
    db
      .select({
        receiptId: receipts.id,
        number: receipts.number,
        date: receipts.date,
        amount: allocations.amountPaise,
        invoiceId: allocations.invoiceId,
        jobId: allocations.jobId,
        noteInvoiceId: debitNotes.invoiceId, // a debit note's payment belongs to its invoice's chain
      })
      .from(allocations)
      .innerJoin(receipts, eq(receipts.id, allocations.receiptId))
      .leftJoin(debitNotes, eq(debitNotes.id, allocations.debitNoteId))
      // Money paid back by a refund JV (D55) pays nothing in a chain.
      .where(
        and(eq(receipts.customerId, customerId), eq(receipts.status, "active"), eq(allocations.active, true), isNull(allocations.refundAdjustmentId)),
      ),
    noteRows(creditNotes),
    noteRows(debitNotes as unknown as typeof creditNotes), // same columns (lib/notes.ts)
  ]);

  // Union-find over "q12" / "j5" / "i7".
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  for (const j of js) if (j.quotationId !== null) join(`j${j.id}`, `q${j.quotationId}`);
  for (const l of links) {
    if (l.jobId !== null) join(`i${l.invoiceId}`, `j${l.jobId}`);
    if (l.quotationId !== null) join(`i${l.invoiceId}`, `q${l.quotationId}`);
  }

  const paid = await paidTowards(db, invs.filter((i) => i.status === "issued").map((i) => i.id));
  const dnPaid = await paidTowardsDebitNotes(db, dns.filter((n) => n.status === "issued").map((n) => n.id));
  const chains = new Map<string, Chain>();
  const chain = (k: string) => {
    const root = find(k);
    let c = chains.get(root);
    if (!c) {
      c = { key: root, date: "", label: "Draft", quotations: [], jobs: [], invoices: [], notes: [], payments: [], pending: 0n };
      chains.set(root, c);
    }
    return c;
  };
  const seen = (c: Chain, date: string) => {
    if (date > c.date) c.date = date;
  };
  for (const q of qs) {
    const c = chain(`q${q.id}`);
    c.quotations.push({ id: q.id, number: q.number, date: q.date, status: QUOTATION_STATUS[q.status] });
    seen(c, q.date);
  }
  for (const j of js) {
    const c = chain(`j${j.id}`);
    c.jobs.push({ id: j.id, number: j.number, date: j.date, status: JOB_STATUS[j.status] });
    seen(c, j.date);
  }
  for (const i of invs) {
    const c = chain(`i${i.id}`);
    const open = i.status === "issued" ? i.totalPaise - (paid.get(i.id) ?? 0n) : 0n;
    const payment = paymentStatus(i, open);
    const status: Status = i.status === "draft" ? "Draft" : i.status === "cancelled" ? "Cancelled" : "Issued";
    c.invoices.push({ id: i.id, number: i.number ?? "Draft", date: i.date, status, total: i.totalPaise, open, payment });
    c.pending += open;
    seen(c, i.date);
  }
  for (const [kind, list] of [["credit", cns], ["debit", dns]] as const) {
    for (const n of list) {
      const c = chain(`i${n.invoiceId}`);
      const open = kind === "debit" && n.status === "issued" ? n.totalPaise - (dnPaid.get(n.id) ?? 0n) : 0n;
      const payment = kind === "debit" ? paymentStatus({ ...n, dueDate: n.dueDate ?? n.date }, open) : null;
      const status: Status = n.status === "draft" ? "Draft" : n.status === "cancelled" ? "Cancelled" : "Issued";
      c.notes.push({ id: n.id, kind, number: n.number ?? "Draft", date: n.date, status, total: n.totalPaise, payment });
      c.pending += open;
      seen(c, n.date);
    }
  }
  for (const p of pays) {
    // A receipt only pays its own customer's invoices, debit notes and jobs (checkAllocations), so the node is here.
    const invoiceId = p.invoiceId ?? p.noteInvoiceId;
    const c = chain(invoiceId !== null ? `i${invoiceId}` : `j${p.jobId}`);
    const same = c.payments.find((x) => x.receiptId === p.receiptId);
    if (same) same.amount += p.amount;
    else c.payments.push({ receiptId: p.receiptId, number: p.number, date: p.date, amount: p.amount });
    seen(c, p.date);
  }

  for (const c of chains.values()) {
    // Issued invoices and debit notes (receivables of their own) set the label.
    const issued = [...c.invoices, ...c.notes].filter((i) => i.status === "Issued" && i.payment);
    const liveJob = c.jobs.filter((j) => j.status !== "Cancelled").at(-1);
    const liveQuote = c.quotations.filter((q) => q.status !== "Cancelled").at(-1);
    if (issued.length) c.label = PAYMENT_ORDER.find((s) => issued.some((i) => i.payment === s)) ?? "Paid";
    else if (liveJob) c.label = liveJob.status;
    else if (liveQuote) c.label = liveQuote.status;
    else if (c.invoices.some((i) => i.status === "Draft")) c.label = "Draft";
    else c.label = "Cancelled";
    c.payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.receiptId - b.receiptId));
  }
  return [...chains.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.key < b.key ? 1 : -1));
}

/**
 * S1 "advance / on account": money received and not yet on an invoice — advances on the customer's open jobs (from
 * receipts, or credit applied to them, D50), and the unallocated rest of live receipts and issued credit notes (a
 * note's excess stays as customer credit, D49).
 */
export async function customerAdvance(customerId: number) {
  const [row] = await db.execute<{ on_jobs: string; on_account: string; credit: string }>(sql`
    select
      coalesce((select sum(a.amount_paise) from allocations a join jobs j on j.id = a.job_id
        where j.customer_id = ${customerId} and a.active
          and not exists (select 1 from receipts r where r.id = a.receipt_id and r.status = 'cancelled')
          and not exists (select 1 from credit_notes c where c.id = a.credit_note_id and c.status = 'cancelled')), 0) as on_jobs,
      coalesce((select sum(r.amount_paise - coalesce((select sum(a.amount_paise) from allocations a
        where a.receipt_id = r.id and a.active), 0)) from receipts r
        where r.customer_id = ${customerId} and r.status = 'active'), 0) as on_account,
      coalesce((select sum(c.total_paise - coalesce((select sum(a.amount_paise) from allocations a
        where a.credit_note_id = c.id and a.active), 0)) from credit_notes c
        where c.customer_id = ${customerId} and c.status = 'issued'), 0) as credit`);
  return { onJobs: BigInt(row.on_jobs), onAccount: BigInt(row.on_account) + BigInt(row.credit) };
}
