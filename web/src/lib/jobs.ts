import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import {
  customers,
  jobLines,
  jobs,
  jobStatusHistory,
  productCategories,
  quotationLines,
  quotations,
  users,
  type JOB_STATUSES,
} from "@/db/schema";
import { formText, UserError } from "@/lib/action";
import { parseDate } from "@/lib/dates";
import { checkBooksDate } from "@/lib/ledger";
import { gstMode, lineTotals } from "@/lib/lines";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { companyState, customerFor, jobsOnInvoices, lineRow, quotationInvoice, readDate, readLines } from "@/lib/sales";
import { dateIn, type Range } from "@/lib/statements";

// Jobs / work orders (S2, S3, A§2, A§8). Sales and the owner create them (from an approved quotation, lines copied —
// R0 — or blank); production and the owner move them In Production → Ready → Delivered; issuing an invoice sets
// Invoiced (T12); the owner edits lines and cancels until then. Production never receives money: the loaders below
// leave rate / discount / GST / amounts / totals out of what they return (hard rule 5).

export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS: Record<JobStatus, Status> = {
  in_production: "In Production",
  ready: "Ready",
  delivered: "Delivered",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
};
/** The statuses people set by hand (the production board's columns). */
export const PRODUCTION_STATUSES = ["in_production", "ready", "delivered"] as const satisfies JobStatus[];

/** The job's own fields as typed. */
export type JobHeaderInput = {
  date: string;
  siteAddress: string;
  siteReference: string;
  vehicleNo: string;
  salesPersonId: string;
  targetDate: string;
  notes: string;
};
/** A blank job or an edit: + customer and lines (JSON of lib/lines.ts LineText[]). */
export type JobInput = JobHeaderInput & { customerId: string; lines: string };

async function header(tx: Tx, input: JobHeaderInput, customer: { siteAddress: string | null }) {
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  let targetDate: string | null = null;
  if (input.targetDate.trim()) {
    try {
      targetDate = parseDate(input.targetDate);
    } catch {
      throw new UserError("Use DD/MM/YYYY, e.g. 15/10/2026.", "targetDate");
    }
  }
  let salesPersonId: string | null = null;
  if (input.salesPersonId) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.salesPersonId));
    if (!u) throw new UserError("Pick someone from the list.", "salesPersonId");
    salesPersonId = u.id;
  }
  return {
    date,
    siteAddress: formText(input.siteAddress, "siteAddress", 1000) ?? customer.siteAddress,
    siteReference: formText(input.siteReference, "siteReference"),
    vehicleNo: formText(input.vehicleNo, "vehicleNo", 30),
    salesPersonId,
    targetDate,
    notes: formText(input.notes, "notes", 2000),
  };
}

const addHistory = (tx: Tx, jobId: number, fromStatus: JobStatus | null, toStatus: JobStatus) =>
  tx.insert(jobStatusHistory).values({ jobId, fromStatus, toStatus });

async function lock(tx: Tx, id: number) {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for("update");
  if (!job) throw new UserError("That job doesn't exist.");
  return job;
}

/** The quotation's job, unless cancelled (one per quotation, D46). */
export async function liveJobFor(q: Tx | typeof db, quotationId: number) {
  const [job] = await q
    .select({ id: jobs.id, number: jobs.number })
    .from(jobs)
    .where(and(eq(jobs.quotationId, quotationId), ne(jobs.status, "cancelled")));
  return job;
}

/** An approved quotation → a job with every line copied (R0), nothing retyped. */
export async function createJobFromQuotation(actor: SessionUser, quotationId: number, input: JobHeaderInput) {
  if (!can(actor, "jobs", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const [q] = await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update");
    if (!q) throw new UserError("That quotation doesn't exist.");
    if (q.status !== "approved") throw new UserError("Only an approved quotation becomes a job.");
    const existing = await liveJobFor(tx, quotationId);
    if (existing) throw new UserError(`Job ${existing.number} was already made from this quotation.`);
    const invoice = await quotationInvoice(tx, quotationId);
    if (invoice) throw new UserError(`This quotation is already on invoice ${invoice.number ?? "(draft)"}.`);
    const customer = await customerFor(tx, String(q.customerId), false);
    const h = await header(tx, input, customer);
    const lines = await tx
      .select()
      .from(quotationLines)
      .where(eq(quotationLines.quotationId, quotationId))
      .orderBy(asc(quotationLines.position));
    const { total } = lineTotals(lines, gstMode(q.placeOfSupply, await companyState(tx)));
    const [job] = await tx
      .insert(jobs)
      .values({
        ...h,
        number: await nextNumber(tx, "job", h.date),
        customerId: q.customerId,
        quotationId,
        placeOfSupply: q.placeOfSupply,
        totalPaise: total,
        createdBy: actor.id,
      })
      .returning({ id: jobs.id });
    await tx.insert(jobLines).values(lines.map((l, i) => ({ jobId: job.id, ...lineRow(l, i), quotationLineId: l.id })));
    await addHistory(tx, job.id, null, "in_production");
    return job.id;
  });
}

/** A job with no quotation behind it. */
export async function createJob(actor: SessionUser, input: JobInput): Promise<number> {
  if (!can(actor, "jobs", "create")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const customer = await customerFor(tx, input.customerId, true);
    const h = await header(tx, input, customer);
    const lines = await readLines(tx, input.lines);
    const { total } = lineTotals(lines, gstMode(customer.stateCode, await companyState(tx)));
    const [job] = await tx
      .insert(jobs)
      .values({
        ...h,
        number: await nextNumber(tx, "job", h.date),
        customerId: customer.id,
        placeOfSupply: customer.stateCode,
        totalPaise: total,
        createdBy: actor.id,
      })
      .returning({ id: jobs.id });
    await tx.insert(jobLines).values(lines.map((l, i) => ({ jobId: job.id, ...lineRow(l, i) })));
    await addHistory(tx, job.id, null, "in_production");
    return job.id;
  });
}

/** Owner: the job's fields and lines, until it is invoiced (A§8). The customer stays; lines keep their quotation link. */
export async function updateJob(actor: SessionUser, id: number, input: JobInput): Promise<void> {
  if (!can(actor, "jobs", "edit")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const job = await lock(tx, id);
    if (job.status === "invoiced" || job.status === "cancelled") {
      throw new UserError(`An ${JOB_STATUS[job.status].toLowerCase()} job can't be edited.`);
    }
    const customer = await customerFor(tx, String(job.customerId), false);
    const h = await header(tx, input, customer);
    const lines = await readLines(tx, input.lines);
    const old = await tx.select().from(jobLines).where(eq(jobLines.jobId, id));
    const { total } = lineTotals(lines, gstMode(job.placeOfSupply, await companyState(tx)));
    await tx.update(jobs).set({ ...h, totalPaise: total }).where(eq(jobs.id, id));
    // ponytail: lines are replaced on save (the audit log keeps the old rows).
    await tx.delete(jobLines).where(eq(jobLines.jobId, id));
    await tx.insert(jobLines).values(
      lines.map((l, i) => ({
        jobId: id,
        ...lineRow(l, i),
        quotationLineId: old.find((o) => o.id === l.lineId)?.quotationLineId ?? null,
      })),
    );
  });
}

/** In Production / Ready / Delivered, recorded with who and when. Production and the owner (A§8). */
export async function setJobStatus(actor: SessionUser, id: number, to: string): Promise<void> {
  if (!can(actor, "jobs", "status")) throw new Error("Not allowed");
  const status = PRODUCTION_STATUSES.find((s) => s === to);
  if (!status) throw new UserError("Pick In Production, Ready or Delivered.");
  await writeTx(actor, async (tx) => {
    const job = await lock(tx, id);
    if (job.status === "invoiced" || job.status === "cancelled") {
      throw new UserError(`An ${JOB_STATUS[job.status].toLowerCase()} job's status can't change.`);
    }
    if (job.status === status) throw new UserError(`It is already ${JOB_STATUS[status]}.`);
    await tx.update(jobs).set({ status }).where(eq(jobs.id, id));
    await addHistory(tx, id, job.status, status);
  });
}

/** Owner, while not invoiced. */
export async function cancelJob(actor: SessionUser, id: number): Promise<void> {
  if (!can(actor, "jobs", "cancel")) throw new Error("Not allowed");
  await writeTx(actor, async (tx) => {
    const job = await lock(tx, id);
    if (job.status === "cancelled") throw new UserError("This job is already cancelled.");
    if (job.status === "invoiced") throw new UserError("An invoiced job can't be cancelled: cancel the invoice first.");
    const [draft] = await jobsOnInvoices(tx, [id]);
    if (draft) throw new UserError(`This job is on draft invoice #${draft.invoiceId}: take it off that invoice first.`);
    await tx.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, id));
    await addHistory(tx, id, job.status, "cancelled");
  });
}

// ---- Loaders. `money` = the user may see amounts in jobs (never production); without it, no money column is read.

const money = (user: SessionUser) => can(user, "jobs", "money");

const listColumns = {
  id: jobs.id,
  number: jobs.number,
  date: jobs.date,
  status: jobs.status,
  targetDate: jobs.targetDate,
  customer: customers.name,
  firmName: customers.firmName,
};

/** The jobs list; `range` (D68) = those dated in it, else all. */
export async function listJobs(user: SessionUser, range?: Range) {
  return db
    .select(money(user) ? { ...listColumns, total: jobs.totalPaise } : listColumns)
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(dateIn(jobs.date, range))
    .orderBy(desc(jobs.id));
}

/** The production board (T11): jobs not yet invoiced or cancelled, earliest target date first. */
export async function jobBoard(user: SessionUser) {
  const rows = await db
    .select(money(user) ? { ...listColumns, total: jobs.totalPaise } : listColumns)
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(inArray(jobs.status, [...PRODUCTION_STATUSES]))
    .orderBy(asc(jobs.targetDate), asc(jobs.id));
  const lines = rows.length
    ? await db
        .select({ jobId: jobLines.jobId, description: jobLines.description, category: productCategories.name })
        .from(jobLines)
        .innerJoin(productCategories, eq(productCategories.id, jobLines.categoryId))
        .where(inArray(jobLines.jobId, rows.map((r) => r.id)))
        .orderBy(asc(jobLines.jobId), asc(jobLines.position))
    : [];
  return rows.map((r) => ({
    ...r,
    items: lines.filter((l) => l.jobId === r.id).map((l) => l.description ?? l.category),
  }));
}

const jobColumns = {
  id: jobs.id,
  number: jobs.number,
  date: jobs.date,
  customerId: jobs.customerId,
  quotationId: jobs.quotationId,
  placeOfSupply: jobs.placeOfSupply,
  status: jobs.status,
  siteAddress: jobs.siteAddress,
  siteReference: jobs.siteReference,
  vehicleNo: jobs.vehicleNo,
  salesPersonId: jobs.salesPersonId,
  targetDate: jobs.targetDate,
  notes: jobs.notes,
  customer: customers.name,
  firmName: customers.firmName,
  mobile: customers.mobile,
  quotation: quotations.number,
  salesPerson: users.name,
};

const lineColumns = {
  id: jobLines.id,
  categoryId: jobLines.categoryId,
  category: productCategories.name,
  description: jobLines.description,
  hsnSac: jobLines.hsnSac,
  widthMilli: jobLines.widthMilli,
  heightMilli: jobLines.heightMilli,
  qtyMilli: jobLines.qtyMilli,
  unit: jobLines.unit,
};
const pricedLineColumns = {
  ...lineColumns,
  ratePaise: jobLines.ratePaise,
  discountPaise: jobLines.discountPaise,
  gstBp: jobLines.gstBp,
};

/** A job for this user: with prices and totals only when they may see money. */
export async function getJob(user: SessionUser, id: number) {
  const [job] = await db
    .select(jobColumns)
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .leftJoin(quotations, eq(quotations.id, jobs.quotationId))
    .leftJoin(users, eq(users.id, jobs.salesPersonId))
    .where(eq(jobs.id, id));
  if (!job) return undefined;
  const history = await db
    .select({ from: jobStatusHistory.fromStatus, to: jobStatusHistory.toStatus, by: users.name, at: jobStatusHistory.changedAt })
    .from(jobStatusHistory)
    .innerJoin(users, eq(users.id, jobStatusHistory.changedBy))
    .where(eq(jobStatusHistory.jobId, id))
    .orderBy(asc(jobStatusHistory.id));
  const where = eq(jobLines.jobId, id);
  const category = eq(productCategories.id, jobLines.categoryId);
  if (!money(user)) {
    const lines = await db
      .select(lineColumns)
      .from(jobLines)
      .innerJoin(productCategories, category)
      .where(where)
      .orderBy(asc(jobLines.position));
    return { ...job, history, lines, money: false as const };
  }
  const lines = await db
    .select(pricedLineColumns)
    .from(jobLines)
    .innerJoin(productCategories, category)
    .where(where)
    .orderBy(asc(jobLines.position));
  const mode = gstMode(job.placeOfSupply, await companyState(db));
  return { ...job, history, lines, money: true as const, mode, totals: lineTotals(lines, mode) };
}
