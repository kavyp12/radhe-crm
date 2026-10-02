import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { db, writeTx } from "@/db";
import { allocations, invoiceLines, invoices, jobCostEntries, jobLines, jobs, users } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { liveAllocation, paidTowards } from "@/lib/allocations";
import { BUCKET_LABEL, JOB_COST_BUCKETS, type JobCostBucket } from "@/lib/cost-buckets";
import { lineTotals } from "@/lib/lines";
import { divRound, formatMoney } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { jobsOnInvoices, readDate } from "@/lib/sales";

// Job costing (S3, S11, A§10, D57). Figures come from the journal, so cancels and edits net out: sale = the sales /
// sales_returns lines tagged with the job (Cr − Dr); costs = job-tagged lines on materials_consumed (material) and on
// expense-category accounts (their D41 bucket; a "none" category counts as other), plus the manual job_cost_entries
// (never posted, deactivated instead of deleted) and the print jobs on the job at the machine's cost rate (printing,
// T37, D64; never posted either). Everything here is cost: only for can_view_cost users who may see the job's money
// (hard rule 5) — the loader returns nothing otherwise.

/** May see a job's P&L card: the job's money (never production) and can_view_cost. */
export const canSeeJobCost = (user: SessionUser) => can(user, "jobs", "money") && canViewCost(user);
/** May add / deactivate manual costs: owner / accountant with can_view_cost. */
export const canEnterJobCost = (user: SessionUser) => can(user, "jobCosts", "create") && canViewCost(user);

/** The job P&L card, or undefined for users without cost access (or no such job). */
export async function jobCosting(user: SessionUser, jobId: number) {
  if (!canSeeJobCost(user)) return undefined;
  const [job] = await db.select({ totalPaise: jobs.totalPaise, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
  if (!job) return undefined;

  const rows = await db.execute<{ key: string | null; bucket: string | null; net: string }>(sql`
    select a.system_key as key, ec.cost_bucket as bucket, sum(l.debit_paise - l.credit_paise) as net
    from journal_lines l
    join accounts a on a.id = l.account_id
    left join expense_categories ec on ec.account_id = a.id
    where l.job_id = ${jobId} and (a.system_key in ('sales', 'sales_returns', 'materials_consumed') or ec.id is not null)
    group by 1, 2`);
  let sale = 0n;
  const cost = Object.fromEntries(JOB_COST_BUCKETS.map((b) => [b, 0n])) as Record<JobCostBucket, bigint>;
  for (const r of rows) {
    const net = BigInt(r.net);
    if (r.key === "sales" || r.key === "sales_returns") sale -= net;
    else if (r.key === "materials_consumed") cost.material += net;
    else cost[r.bucket === "none" ? "other" : (r.bucket as JobCostBucket)] += net;
  }

  const entries = await db
    .select({
      id: jobCostEntries.id,
      bucket: jobCostEntries.bucket,
      date: jobCostEntries.date,
      amount: jobCostEntries.amountPaise,
      note: jobCostEntries.note,
      active: jobCostEntries.active,
      by: users.name,
    })
    .from(jobCostEntries)
    .leftJoin(users, eq(users.id, jobCostEntries.createdBy))
    .where(eq(jobCostEntries.jobId, jobId))
    .orderBy(asc(jobCostEntries.date), asc(jobCostEntries.id));
  for (const e of entries) if (e.active) cost[e.bucket] += e.amount;
  // Prints whose machine has no cost rate yet count nothing until it is set (D66): the card flags them.
  const [printed] = await db.execute<{ paise: string; pending: number }>(sql`
    select coalesce(sum(amount_paise), 0) as paise, count(*) filter (where rate_paise is null)::int as pending
    from print_jobs where job_id = ${jobId} and mode = 'job_cost' and status = 'active'`);
  cost.printing += BigInt(printed.paise);
  const printsCostPending = Number(printed.pending);

  const totalCost = JOB_COST_BUCKETS.reduce((s, b) => s + cost[b], 0n);
  const profit = sale - totalCost;

  // Advance = live advances on the job, plus those moved onto its invoice at Issue (T14).
  const [adv] = await db
    .select({ paise: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(and(liveAllocation(), or(eq(allocations.jobId, jobId), eq(allocations.fromJobId, jobId))));
  const advance = BigInt(adv.paise);

  // Balance due: before an issued invoice, the job total less the advance; after, that invoice's open amount (which
  // also covers any other jobs billed on it — `shared`).
  let balance = { amount: job.totalPaise - advance, invoice: null as null | { id: number; number: string; shared: boolean } };
  const [link] = await jobsOnInvoices(db, [jobId]);
  if (link) {
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, link.invoiceId), eq(invoices.status, "issued")));
    if (inv) {
      const paid = (await paidTowards(db, [inv.id])).get(inv.id) ?? 0n;
      const [other] = await db
        .select({ id: invoiceLines.id })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.invoiceId, inv.id), or(sql`${invoiceLines.jobId} is null`, ne(invoiceLines.jobId, jobId))))
        .limit(1);
      balance = { amount: inv.totalPaise - paid, invoice: { id: inv.id, number: inv.number!, shared: !!other } };
    }
  }

  // D58: until the job is invoiced, an estimate from the job's own lines (taxable, excl. GST) next to the books' figures.
  let expected: { sale: bigint; profit: bigint } | null = null;
  if (job.status !== "invoiced" && job.status !== "cancelled") {
    const lines = await db.select().from(jobLines).where(eq(jobLines.jobId, jobId));
    const { taxable } = lineTotals(lines, "estimate");
    expected = { sale: taxable, profit: taxable - totalCost };
  }

  return {
    sale,
    expected,
    cost,
    totalCost,
    profit,
    // Basis points, half-up (3800 = 38%); none without a sale.
    marginBp: sale > 0n ? Number(divRound(profit * 10000n, sale)) : null,
    advance,
    balance,
    entries,
    printsCostPending,
  };
}

export type JobCostInput = { bucket: string; date: string; amount: string; note: string };

/** Adds a manual cost (never posted). */
export async function addJobCost(actor: SessionUser, jobId: number, input: JobCostInput): Promise<{ message: string }> {
  if (!canEnterJobCost(actor)) throw new Error("Not allowed");
  const bucket = JOB_COST_BUCKETS.find((b) => b === input.bucket);
  if (!bucket) throw new UserError("Pick the cost type.", "bucket");
  const date = readDate(input.date);
  const amount = formMoney(input.amount, "amount");
  if (amount === null || amount <= 0n) throw new UserError("Enter the amount (more than 0).", "amount");
  const note = formText(input.note, "note", 200);
  return writeTx(actor, async (tx) => {
    const [job] = Number.isSafeInteger(jobId) ? await tx.select().from(jobs).where(eq(jobs.id, jobId)) : [];
    if (!job) throw new UserError("That job doesn't exist.");
    if (job.status === "cancelled") throw new UserError(`Job ${job.number} is cancelled.`);
    await tx.insert(jobCostEntries).values({ jobId, bucket, date, amountPaise: amount, note, createdBy: actor.id });
    return { message: `Added ${BUCKET_LABEL[bucket]} ${formatMoney(amount)} to ${job.number}.` };
  });
}

/** Deactivates a manual cost (hard rule 3: never deleted; the audit log keeps who and when). */
export async function deactivateJobCost(actor: SessionUser, entryId: number): Promise<{ message: string }> {
  if (!canEnterJobCost(actor)) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const [e] = Number.isSafeInteger(entryId) ? await tx.select().from(jobCostEntries).where(eq(jobCostEntries.id, entryId)).for("update") : [];
    if (!e) throw new UserError("That cost entry doesn't exist.");
    if (!e.active) throw new UserError("This cost entry is already removed.");
    await tx.update(jobCostEntries).set({ active: false }).where(eq(jobCostEntries.id, entryId));
    return { message: `Removed ${BUCKET_LABEL[e.bucket]} ${formatMoney(e.amountPaise)} from the job's costs.` };
  });
}
