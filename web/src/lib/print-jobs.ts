import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Status } from "@/components/status-badge";
import { db, writeTx, type Tx } from "@/db";
import {
  allocations,
  attachments,
  customers,
  invoiceLines,
  invoices,
  jobs,
  machines,
  printingTypes,
  printJobs,
  productCategories,
  users,
} from "@/db/schema";
import { formMoney, formPhone, formText, UserError } from "@/lib/action";
import { advancesOn, deactivate, liveAllocation, paidTowards, paidTowardsPrintJobs, paymentStatus } from "@/lib/allocations";
import { needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, todayIST } from "@/lib/dates";
import { JOB_STATUS, PRODUCTION_STATUSES } from "@/lib/jobs";
import { checkBooksDate, systemAccountId } from "@/lib/ledger";
import { formatMoney, milliText, moneyText, parseQty, printAmount, printSqFt } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { MODE_ACCOUNT } from "@/lib/receipt-modes";
import { insertReceipt } from "@/lib/receipts";
import { customerFor, readDate } from "@/lib/sales";
import { moneyCol, OPEN_PERIODS, party, pick, pickFilters, reportRange, rollUp, type ReportQuery, type ReportResult } from "@/lib/reports";
import { getSettings } from "@/lib/settings";
import { rangeText } from "@/lib/statements";

// Print jobs (P1–P10, A§5, A§11, D19, D64). A new print (mode sale) is sold at the typed rate — the machine's sale rate
// by default — and posts nothing until it is billed on an invoice / estimate. A print on an existing job (mode
// job_cost) is costed at the machine's cost rate, applied here and never typed: it adds to the job's printing bucket
// (T27) and is never posted. Money taken at the print is a receipt (cash → Cash, UPI → UPI) allocated to it. The web
// form (owner / accountant) and the agent (T39) both create through insertPrintJob. Statuses are computed (A§5).

// ---- Masters: machines and printing types (owner / accountant; cost rates only with can_view_cost)

const RATE_MAX = 1_00_000_00n; // ₹1,00,000 per sq ft: a typo guard

function readRate(text: string, field: string): bigint | null {
  const rate = formMoney(text, field);
  if (rate !== null && (rate < 0n || rate > RATE_MAX)) throw new UserError("Enter a rate between 0 and 1,00,000 per sq ft.", field);
  return rate;
}

export type MachineInput = { name: string; printerNames: string; saleRate: string; costRate: string; active: boolean };

/** One per line, as Windows names them (a name may hold commas): the agent's printer → machine map (T40). */
function readPrinterNames(text: string): string[] {
  const names = [...new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  if (names.length > 20) throw new UserError("Up to 20 printer names.", "printerNames");
  if (names.some((n) => n.length > 200)) throw new UserError("Keep each printer name under 200 characters.", "printerNames");
  return names;
}

/** Adds (id null) or changes a machine. Without can_view_cost the cost rate is neither read nor changed (hard rule 5). */
export async function saveMachine(actor: SessionUser, id: number | null, input: MachineInput): Promise<number> {
  if (!can(actor, "printJobs", id === null ? "create" : "edit")) throw new Error("Not allowed");
  const name = formText(input.name, "name", 100);
  if (!name) throw new UserError("Enter the machine's name.", "name");
  const printerNames = readPrinterNames(input.printerNames);
  const values = {
    name,
    printerNames,
    saleRatePaise: readRate(input.saleRate, "saleRate"),
    ...(canViewCost(actor) ? { costRatePaise: readRate(input.costRate, "costRate") } : {}),
    active: input.active,
  };
  return writeTx(actor, async (tx) => {
    const others = await tx.select().from(machines).where(id === null ? undefined : ne(machines.id, id));
    if (others.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new UserError("Another machine has this name.", "name");
    // A Windows printer feeds one machine, or the agent couldn't tell which machine printed.
    for (const printer of input.active ? printerNames : []) {
      const taken = others.find((m) => m.active && m.printerNames.some((p) => p.toLowerCase() === printer.toLowerCase()));
      if (taken) throw new UserError(`Printer "${printer}" already feeds ${taken.name}.`, "printerNames");
    }
    if (id === null) {
      const [row] = await tx.insert(machines).values({ ...values, createdBy: actor.id }).returning({ id: machines.id });
      return row.id;
    }
    const [row] = await tx.update(machines).set(values).where(eq(machines.id, id)).returning({ id: machines.id });
    if (!row) throw new UserError("That machine doesn't exist.");
    return row.id;
  });
}

export type PrintingTypeInput = { name: string; categoryId: string; active: boolean };

/** Adds (id null) or changes a printing type; its optional category is what a billed print job's line takes (D64). */
export async function savePrintingType(actor: SessionUser, id: number | null, input: PrintingTypeInput): Promise<number> {
  if (!can(actor, "printJobs", id === null ? "create" : "edit")) throw new Error("Not allowed");
  const name = formText(input.name, "name", 100);
  if (!name) throw new UserError("Enter the printing type's name.", "name");
  return writeTx(actor, async (tx) => {
    let categoryId: number | null = null;
    if (input.categoryId) {
      const [c] = await tx.select().from(productCategories).where(eq(productCategories.id, Number(input.categoryId) || 0));
      if (!c) throw new UserError("Pick a category from the list.", "categoryId");
      categoryId = c.id;
    }
    const [taken] = await tx
      .select({ id: printingTypes.id })
      .from(printingTypes)
      .where(and(sql`lower(${printingTypes.name}) = lower(${name})`, id === null ? undefined : ne(printingTypes.id, id)));
    if (taken) throw new UserError("Another printing type has this name.", "name");
    const values = { name, categoryId, active: input.active };
    if (id === null) {
      const [row] = await tx.insert(printingTypes).values({ ...values, createdBy: actor.id }).returning({ id: printingTypes.id });
      return row.id;
    }
    const [row] = await tx.update(printingTypes).set(values).where(eq(printingTypes.id, id)).returning({ id: printingTypes.id });
    if (!row) throw new UserError("That printing type doesn't exist.");
    return row.id;
  });
}

/** Machines, oldest first; the cost rate only for can_view_cost users (stripped here, hard rule 5). */
export async function listMachines(user: SessionUser) {
  const rows = await db.select().from(machines).orderBy(asc(machines.id));
  return rows.map(({ costRatePaise, ...m }) => ({ ...m, costRatePaise: canViewCost(user) ? costRatePaise : undefined }));
}

export const listPrintingTypes = () =>
  db
    .select({ id: printingTypes.id, name: printingTypes.name, categoryId: printingTypes.categoryId, category: productCategories.name, active: printingTypes.active })
    .from(printingTypes)
    .leftJoin(productCategories, eq(productCategories.id, printingTypes.categoryId))
    .orderBy(asc(printingTypes.id));

// ---- Print jobs

/**
 * A print as typed (web form) or sent (agent): money, sizes and qty as decimal text, never JS numbers. customerId
 * blank = a quick-add customer (name + mobile). jobId blank = new (sale). rate: sale only (blank = the machine's sale
 * rate). payment: paid | unpaid | credit (sale only) with `received` (paid: blank or the full amount; unpaid: an
 * advance) by receiptMode cash | upi.
 */
export type PrintJobInput = {
  customerId: string;
  newCustomerName: string;
  newCustomerMobile: string;
  jobId: string;
  fileName: string;
  filePath: string;
  machineId: string;
  printingTypeId: string;
  width: string;
  height: string;
  qty: string;
  rate: string;
  payment: string;
  received: string;
  receiptMode: string;
  reprintOfId: string;
  notes: string;
};

export const PAYMENT_CHOICES = ["paid", "unpaid", "credit"] as const;

const MAX_FEET = 1000_000n; // 1,000 ft
const MAX_QTY = 1_00_000_000n; // 1,00,000 copies
/** A PC clock a little ahead of the server's is no future print (the agent's printed_at, T39). */
export const CLOCK_SKEW_MS = 10 * 60_000;

function readSize(input: Pick<PrintJobInput, "width" | "height" | "qty">) {
  const read = (text: string, field: string, label: string, max: bigint) => {
    let v: bigint;
    try {
      v = parseQty(text);
    } catch {
      throw new UserError(`Enter the ${label} like 6 or 2.5.`, field);
    }
    if (v <= 0n || v > max) throw new UserError(`Enter a ${label} more than 0 and up to ${milliText(max)}.`, field);
    return v;
  };
  const widthMilli = read(input.width, "width", "width (ft)", MAX_FEET);
  const heightMilli = read(input.height, "height", "height (ft)", MAX_FEET);
  const qtyMilli = read(input.qty, "qty", "quantity", MAX_QTY);
  const sqftMilli = printSqFt(widthMilli, heightMilli, qtyMilli);
  if (sqftMilli <= 0n) throw new UserError("The size is too small: it comes to 0 sq ft.", "width");
  return { widthMilli, heightMilli, qtyMilli, sqftMilli };
}

/** What is taken at the print (D64): Paid = the full amount, Unpaid = an advance (or nothing), Credit = nothing. */
function readPayment(
  input: Pick<PrintJobInput, "payment" | "received" | "receiptMode">,
  mode: "sale" | "job_cost",
  amount: bigint,
): { received: bigint; mode: "cash" | "upi" | null } {
  const received = formMoney(input.received, "received");
  if (mode === "job_cost") {
    if (input.payment || received) {
      throw new UserError("A print on an existing job takes no money here: record it as a receipt for the job.", "payment");
    }
    return { received: 0n, mode: null };
  }
  let got = 0n;
  if (input.payment === "paid") {
    if (received !== null && received !== amount) {
      throw new UserError(`Paid means the full ${formatMoney(amount)}: for less, pick Unpaid and enter the advance.`, "received");
    }
    got = amount;
  } else if (input.payment === "unpaid") {
    got = received ?? 0n;
    if (got < 0n || got > amount) throw new UserError(`Enter an advance between 0 and ${formatMoney(amount)}.`, "received");
  } else if (input.payment === "credit") {
    if (received) throw new UserError("Credit takes no money now: pick Unpaid for an advance.", "received");
  } else {
    throw new UserError("Pick Paid, Unpaid or Credit.", "payment");
  }
  if (got === 0n) return { received: 0n, mode: null };
  const receiptMode = (["cash", "upi"] as const).find((m) => m === input.receiptMode);
  if (!receiptMode) throw new UserError("Pick Cash or UPI for the money received.", "receiptMode");
  return { received: got, mode: receiptMode };
}

/**
 * The customer: an active one by id, or the quick-add (D64: name + mobile, unregistered, state 24) — an active customer
 * with that mobile (last 10 digits) is returned instead. `create` false (an approval's describe) only looks.
 */
async function customerOf(tx: Tx, input: PrintJobInput, by: { id: string }, create: boolean) {
  if (input.customerId) return customerFor(tx, input.customerId, true);
  const name = formText(input.newCustomerName, "newCustomerName", 200);
  if (!name) throw new UserError("Pick the customer, or type a new customer's name and mobile.", "customerId");
  const mobile = formPhone(input.newCustomerMobile, "newCustomerMobile");
  const digits = (mobile ?? "").replace(/\D/g, "");
  if (digits.length < 10) throw new UserError("Enter the new customer's 10-digit mobile.", "newCustomerMobile");
  const last10 = digits.slice(-10);
  // Two prints for the same new customer at once (two PCs) make one customer.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customer-mobile:${last10}`}))`);
  const digitsOf = sql`regexp_replace(${customers.mobile}, '[^0-9]', '', 'g')`;
  const [existing] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.active, true), sql`${digitsOf} like ${`%${last10}`}`, sql`right(${digitsOf}, 10) = ${last10}`))
    .orderBy(asc(customers.id))
    .limit(1);
  if (existing || !create) return existing ?? { id: 0, name, mobile, isCreditCustomer: false };
  const { defaultCreditDays } = await getSettings();
  const [row] = await tx
    .insert(customers)
    .values({ name, mobile, stateCode: "24", creditDays: defaultCreditDays, createdBy: by.id })
    .returning();
  return row;
}

/** A job of this customer still in production (not invoiced / cancelled). */
async function openJobOf(tx: Tx, jobId: string, customerId: number) {
  const id = Number(jobId);
  const [job] = Number.isSafeInteger(id) ? await tx.select().from(jobs).where(eq(jobs.id, id)) : [];
  if (!job) throw new UserError("Pick the job from the list.", "jobId");
  if (job.customerId !== customerId) throw new UserError(`Job ${job.number} is another customer's.`, "jobId");
  if (!(PRODUCTION_STATUSES as readonly string[]).includes(job.status)) {
    throw new UserError(`Job ${job.number} is ${JOB_STATUS[job.status].toLowerCase()}: print it as new.`, "jobId");
  }
  return job;
}

/** An active machine; `keep` = the one an edited print job already has, which may since have been deactivated. */
async function machineOf(tx: Tx, machineId: string, keep?: number) {
  const id = Number(machineId);
  const [m] = Number.isSafeInteger(id) ? await tx.select().from(machines).where(eq(machines.id, id)) : [];
  if (!m || (!m.active && m.id !== keep)) throw new UserError("Pick the machine from the list.", "machineId");
  return m;
}

async function printingTypeOf(tx: Tx, typeId: string, keep?: number) {
  const id = Number(typeId);
  const [t] = Number.isSafeInteger(id) ? await tx.select().from(printingTypes).where(eq(printingTypes.id, id)) : [];
  if (!t || (!t.active && t.id !== keep)) throw new UserError("Pick the printing type from the list.", "printingTypeId");
  return t;
}

/** Rate per sq ft: job_cost → the machine's cost rate (`keep`: the stored one, on an edit that keeps the machine). */
function rateFor(mode: "sale" | "job_cost", machine: typeof machines.$inferSelect, typed: string, keep?: bigint) {
  if (mode === "job_cost") {
    if (keep !== undefined) return keep;
    if (machine.costRatePaise === null) throw new UserError(`${machine.name} has no cost rate yet: the owner sets it under Machines.`, "machineId");
    return machine.costRatePaise;
  }
  const rate = readRate(typed, "rate") ?? machine.saleRatePaise;
  if (rate === null) throw new UserError(`${machine.name} has no sale rate yet: enter the rate per sq ft.`, "rate");
  return rate;
}

/** Who printed it and when; from the agent also which device, under its idempotency key (T39). */
export type PrintOrigin = { by: { id: string }; printedAt: Date; deviceId?: number; clientUuid?: string };

/** Checks everything; `create` false = look only (no quick-add customer is made). */
async function planPrintJob(tx: Tx, input: PrintJobInput, o: PrintOrigin, create: boolean) {
  const date = todayIST(o.printedAt);
  await checkBooksDate(tx, date);
  const customer = await customerOf(tx, input, o.by, create);
  if (input.jobId && !customer.id) throw new UserError("A new customer has no jobs yet: print it as new.", "jobId");
  const job = input.jobId ? await openJobOf(tx, input.jobId, customer.id) : null;
  const mode = job ? ("job_cost" as const) : ("sale" as const);
  const machine = await machineOf(tx, input.machineId);
  const type = await printingTypeOf(tx, input.printingTypeId);
  const size = readSize(input);
  if (job && input.rate.trim()) throw new UserError("A print on an existing job is costed at the machine's cost rate: leave the rate blank.", "rate");
  const ratePaise = rateFor(mode, machine, input.rate);
  const amountPaise = printAmount(size.sqftMilli, ratePaise);
  const pay = readPayment(input, mode, amountPaise);
  const fileName = formText(input.fileName, "fileName", 260);
  if (!fileName) throw new UserError("Enter the file name.", "fileName");
  let reprintOfId: number | null = null;
  if (input.reprintOfId) {
    const [r] = await tx.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.id, Number(input.reprintOfId) || 0));
    if (!r) throw new UserError("The print job this reprints wasn't found.", "reprintOfId");
    reprintOfId = r.id;
  }
  return {
    date,
    customer,
    job,
    machine,
    type,
    pay,
    values: {
      jobId: job?.id ?? null,
      mode,
      fileName,
      filePath: formText(input.filePath, "filePath", 1000),
      machineId: machine.id,
      printingTypeId: type.id,
      ...size,
      ratePaise,
      amountPaise,
      operatorUserId: o.by.id,
      printedAt: o.printedAt,
      reprintOfId,
      notes: formText(input.notes, "notes", 1000),
    },
  };
}

/**
 * Saves a print job (PJ/ numbered by its date) and, when money was taken, its receipt allocated to it — one
 * transaction. No permission or backdate check here: the web form and the agent do theirs.
 */
export async function insertPrintJob(tx: Tx, input: PrintJobInput, o: PrintOrigin) {
  const p = await planPrintJob(tx, input, o, true);
  const number = await nextNumber(tx, "print_job", p.date);
  const [row] = await tx
    .insert(printJobs)
    .values({ ...p.values, number, customerId: p.customer.id, deviceId: o.deviceId ?? null, clientUuid: o.clientUuid ?? null, createdBy: o.by.id })
    .returning({ id: printJobs.id });
  if (p.pay.received > 0n) {
    const amount = moneyText(p.pay.received);
    await insertReceipt(tx, o.by, {
      customerId: String(p.customer.id),
      date: formatDate(p.date),
      amount,
      mode: p.pay.mode!,
      moneyAccountId: String(await systemAccountId(MODE_ACCOUNT[p.pay.mode!], tx)),
      reference: "",
      chequeNo: "",
      chequeDate: "",
      receivedBy: o.by.id, // D64: the operator, whatever their role
      notes: `Taken at print ${number}`,
      allocations: JSON.stringify([{ target: "print_job", id: String(row.id), amount }]),
    });
  }
  return { id: row.id, number, customerId: p.customer.id };
}

/** The web form: the input + date (DD/MM/YYYY) and time (HH:MM, India). */
export type PrintJobForm = PrintJobInput & { date: string; time: string };

/** DD/MM/YYYY + HH:MM in India → the moment. */
export function readMoment(dateText: string, timeText: string): Date {
  const date = readDate(dateText);
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeText.trim());
  if (!m) throw new UserError("Enter the time like 14:30.", "time");
  return new Date(`${date}T${m[1]}:${m[2]}:00+05:30`);
}

type CreatePayload = { input: PrintJobForm; operatorId: string };

registerExecutor<CreatePayload>("print_job.create", {
  async describe(tx, p) {
    const at = readMoment(p.input.date, p.input.time);
    const plan = await planPrintJob(tx, p.input, { by: { id: p.operatorId }, printedAt: at }, false);
    const money = plan.values.mode === "sale";
    return {
      summary: `Print job for ${plan.customer.name}: ${plan.values.fileName}, dated ${formatDate(plan.date)}`,
      changes: [
        { label: "Machine", old: null, new: `${plan.machine.name} · ${plan.type.name}` },
        { label: "Size", old: null, new: `${milliText(plan.values.widthMilli)} × ${milliText(plan.values.heightMilli)} ft × ${milliText(plan.values.qtyMilli)} = ${milliText(plan.values.sqftMilli)} sq ft` },
        { label: "Mode", old: null, new: plan.job ? `On job ${plan.job.number} (cost)` : "New (sale)" },
        ...(money ? [{ label: "Amount", old: null, new: formatMoney(plan.values.amountPaise) }] : []),
        ...(plan.pay.received ? [{ label: "Received", old: null, new: formatMoney(plan.pay.received) }] : []),
      ],
    };
  },
  run: (tx, _owner, p) => insertPrintJob(tx, p.input, { by: { id: p.operatorId }, printedAt: readMoment(p.input.date, p.input.time) }),
});

/**
 * The manual "New Print Job" form (owner / accountant): the operator is the user. Dated before the backdate window by
 * anyone but the owner, it becomes an approval request (A§7) and nothing is saved.
 */
export async function createPrintJob(actor: SessionUser, input: PrintJobForm): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "printJobs", "create")) throw new Error("Not allowed");
  const printedAt = readMoment(input.date, input.time);
  if (printedAt.getTime() > Date.now() + CLOCK_SKEW_MS) throw new UserError("The date and time are in the future.", "time");
  const date = todayIST(printedAt);
  if (await needsBackdateApproval(date)) {
    const why = `Dated ${formatDate(date)}, before the backdate window`;
    const outcome = await runOrRequest(actor, "print_job.create", { input, operatorId: actor.id } satisfies CreatePayload, why);
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => insertPrintJob(tx, input, { by: actor, printedAt }));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lockPrintJob(tx: Tx, id: number) {
  const [pj] = Number.isSafeInteger(id) ? await tx.select().from(printJobs).where(eq(printJobs.id, id)).for("update") : [];
  if (!pj) throw new UserError("That print job doesn't exist.");
  if (pj.status !== "active") throw new UserError("This print job is cancelled.");
  return pj;
}

/** The live invoice (draft or issued) a print job is on, if any. */
async function billedOn(q: Tx | typeof db, printJobId: number) {
  const [row] = await q
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.printJobId, printJobId), ne(invoices.status, "cancelled")))
    .limit(1);
  return row;
}

async function checkNotBilled(tx: Tx, pj: { id: number; number: string }) {
  const inv = await billedOn(tx, pj.id);
  if (inv) throw new UserError(`${pj.number} is billed on ${inv.number ?? "a draft invoice"}: it can't change any more.`);
}

export type PrintJobEdit = Omit<PrintJobInput, "newCustomerName" | "newCustomerMobile" | "payment" | "received" | "receiptMode" | "reprintOfId">;

/**
 * Owner / accountant, audited, never once billed (D64). Money taken stays: then the customer and new / existing job
 * can't change and the amount can't drop below it. On a job the stored cost rate stays while the machine does.
 */
export async function updatePrintJob(actor: SessionUser, id: number, input: PrintJobEdit): Promise<{ message: string }> {
  if (!can(actor, "printJobs", "edit")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const pj = await lockPrintJob(tx, id);
    await checkNotBilled(tx, pj);
    const received = (await paidTowardsPrintJobs(tx, [id])).get(id) ?? 0n;
    const customer = await customerFor(tx, input.customerId, Number(input.customerId) !== pj.customerId);
    const job = input.jobId ? await openJobOf(tx, input.jobId, customer.id) : null;
    const mode = job ? ("job_cost" as const) : ("sale" as const);
    if (received > 0n && (customer.id !== pj.customerId || mode !== pj.mode)) {
      throw new UserError(`${formatMoney(received)} was taken for it: cancel it and enter it again instead.`, "customerId");
    }
    const machine = await machineOf(tx, input.machineId, pj.machineId);
    const type = await printingTypeOf(tx, input.printingTypeId, pj.printingTypeId);
    const size = readSize(input);
    const same = mode === "job_cost" && pj.mode === "job_cost" && machine.id === pj.machineId;
    const ratePaise = rateFor(mode, machine, mode === "sale" ? input.rate : "", same ? pj.ratePaise : undefined);
    const amountPaise = printAmount(size.sqftMilli, ratePaise);
    if (amountPaise < received) throw new UserError(`${formatMoney(received)} was taken for it: the amount can't go below that.`, "rate");
    const fileName = formText(input.fileName, "fileName", 260);
    if (!fileName) throw new UserError("Enter the file name.", "fileName");
    await tx
      .update(printJobs)
      .set({
        customerId: customer.id,
        jobId: job?.id ?? null,
        mode,
        fileName,
        filePath: formText(input.filePath, "filePath", 1000),
        machineId: machine.id,
        printingTypeId: type.id,
        ...size,
        ratePaise,
        amountPaise,
        notes: formText(input.notes, "notes", 1000),
      })
      .where(eq(printJobs.id, id));
    return { message: `Saved ${pj.number}.` };
  });
}

/** Owner / accountant, never once billed: status cancelled, its money goes on account (D64). Audited. */
export async function cancelPrintJob(actor: SessionUser, id: number): Promise<{ message: string }> {
  if (!can(actor, "printJobs", "cancel")) throw new Error("Not allowed");
  return writeTx(actor, async (tx) => {
    const pj = await lockPrintJob(tx, id);
    await checkNotBilled(tx, pj);
    const money = await tx
      .select({ id: allocations.id })
      .from(allocations)
      .where(and(eq(allocations.printJobId, id), eq(allocations.active, true)));
    await deactivate(tx, money.map((a) => a.id));
    await tx.update(printJobs).set({ status: "cancelled" }).where(eq(printJobs.id, id));
    return { message: `Cancelled ${pj.number}.${money.length ? " The money taken for it is on account." : ""}` };
  });
}

// ---- Payment status (A§5) and loaders

export type PrintPayment = Extract<Status, "Unpaid" | "Part Payment" | "Paid" | "Credit Customer" | "Overdue" | "Cancelled">;
export type PrintMoney = {
  /** live money for it: on it now, or moved onto the invoice that billed it */
  received: bigint;
  /** what is still to pay on it while unbilled (sale); null when it follows a job or an issued invoice */
  balance: bigint | null;
  payment: PrintPayment;
  /** the live invoice it is billed on (draft or issued) */
  invoice: { id: number; number: string | null; issued: boolean } | null;
};

type StatusRow = { id: number; mode: "sale" | "job_cost"; jobId: number | null; amountPaise: bigint; status: "active" | "cancelled"; creditCustomer: boolean };

/** Unpaid / Part Payment / Paid with the Credit Customer rule (A§5): nothing paid by a credit customer → Credit Customer. */
const byOpen = (total: bigint, open: bigint, credit: boolean): PrintPayment =>
  open <= 0n ? "Paid" : open < total ? "Part Payment" : credit ? "Credit Customer" : "Unpaid";

/**
 * A§5 for a list of print jobs: on a job → follows the job (its issued invoice, else its total less advances);
 * billed on an issued invoice → follows that invoice; otherwise open = amount − money on it. A few queries in all.
 */
export async function printJobMoney(rows: StatusRow[]): Promise<Map<number, PrintMoney>> {
  const out = new Map<number, PrintMoney>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const [received, links] = await Promise.all([
    db
      .select({ id: sql<number>`coalesce(${allocations.printJobId}, ${allocations.fromPrintJobId})`.mapWith(Number), paise: sql<string>`sum(${allocations.amountPaise})` })
      .from(allocations)
      .where(and(liveAllocation(), or(inArray(allocations.printJobId, ids), inArray(allocations.fromPrintJobId, ids))))
      .groupBy(sql`1`),
    db
      .selectDistinct({ printJobId: invoiceLines.printJobId, invoice: invoices })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(inArray(invoiceLines.printJobId, ids), ne(invoices.status, "cancelled"))),
  ]);
  // Jobs that job_cost prints follow: status, total, advances, and the issued invoice that billed each.
  const jobIds = [...new Set(rows.flatMap((r) => (r.jobId === null ? [] : [r.jobId])))];
  const jobRows = jobIds.length ? await db.select().from(jobs).where(inArray(jobs.id, jobIds)) : [];
  const jobInvoices = jobIds.length
    ? await db
        .selectDistinct({ jobId: invoiceLines.jobId, invoice: invoices })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(inArray(invoiceLines.jobId, jobIds), eq(invoices.status, "issued")))
    : [];
  const issuedIds = [...new Set([...links, ...jobInvoices].filter((l) => l.invoice.status === "issued").map((l) => l.invoice.id))];
  const [paid, advances] = await Promise.all([paidTowards(db, issuedIds), advancesOn(db, jobIds)]);
  const invoicePayment = (inv: typeof invoices.$inferSelect) => paymentStatus(inv, inv.totalPaise - (paid.get(inv.id) ?? 0n)) as PrintPayment;

  for (const r of rows) {
    const got = BigInt(received.find((x) => x.id === r.id)?.paise ?? 0);
    const link = links.find((l) => l.printJobId === r.id)?.invoice;
    const invoice = link ? { id: link.id, number: link.number, issued: link.status === "issued" } : null;
    let payment: PrintPayment;
    let balance: bigint | null = null;
    if (r.status === "cancelled") payment = "Cancelled";
    else if (r.mode === "job_cost") {
      const job = jobRows.find((j) => j.id === r.jobId)!;
      const billed = jobInvoices.find((l) => l.jobId === job.id)?.invoice;
      if (job.status === "cancelled") payment = "Cancelled";
      else if (billed) payment = invoicePayment(billed);
      else payment = byOpen(job.totalPaise, job.totalPaise - (advances.get(job.id) ?? 0n), r.creditCustomer);
    } else if (link?.status === "issued") payment = invoicePayment(link);
    else {
      balance = r.amountPaise - got;
      payment = byOpen(r.amountPaise, balance, r.creditCustomer);
    }
    out.set(r.id, { received: got, balance, payment, invoice });
  }
  return out;
}

const operator = alias(users, "operator");
const reprinted = alias(printJobs, "reprinted");

/** The print job rows with their names; `where` narrows them. */
function printJobRows(where?: SQL) {
  return db
    .select({
      pj: printJobs,
      customer: customers.name,
      firmName: customers.firmName,
      creditCustomer: customers.isCreditCustomer,
      job: jobs.number,
      machine: machines.name,
      type: printingTypes.name,
      operator: operator.name,
      reprintOf: reprinted.number,
    })
    .from(printJobs)
    .innerJoin(customers, eq(customers.id, printJobs.customerId))
    .innerJoin(machines, eq(machines.id, printJobs.machineId))
    .innerJoin(printingTypes, eq(printingTypes.id, printJobs.printingTypeId))
    .innerJoin(operator, eq(operator.id, printJobs.operatorUserId))
    .leftJoin(jobs, eq(jobs.id, printJobs.jobId))
    .leftJoin(reprinted, eq(reprinted.id, printJobs.reprintOfId))
    .where(where)
    .orderBy(desc(printJobs.printedAt), desc(printJobs.id));
}

/**
 * Print jobs as the user may see them (A§8): production gets no money at all (rate, amount, received, payment);
 * a job_cost print's rate and amount are cost — only for can_view_cost (hard rule 5). Stripped here, not in the UI.
 */
async function shape(user: SessionUser, rows: Awaited<ReturnType<typeof printJobRows>>) {
  const money = can(user, "printJobs", "money");
  const moneyOf = money
    ? await printJobMoney(rows.map((r) => ({ ...r.pj, creditCustomer: r.creditCustomer })))
    : new Map<number, PrintMoney>();
  return rows.map((r) => {
    const pj = r.pj;
    const priced = money && (pj.mode === "sale" || canViewCost(user));
    return {
      id: pj.id,
      number: pj.number,
      date: pj.date,
      printedAt: pj.printedAt,
      status: pj.status,
      mode: pj.mode,
      customerId: pj.customerId,
      customer: r.customer,
      firmName: r.firmName,
      jobId: pj.jobId,
      job: r.job,
      fileName: pj.fileName,
      filePath: pj.filePath,
      machineId: pj.machineId,
      machine: r.machine,
      printingTypeId: pj.printingTypeId,
      type: r.type,
      widthMilli: pj.widthMilli,
      heightMilli: pj.heightMilli,
      qtyMilli: pj.qtyMilli,
      sqftMilli: pj.sqftMilli,
      operator: r.operator,
      reprintOfId: pj.reprintOfId,
      reprintOf: r.reprintOf,
      notes: pj.notes,
      ratePaise: priced ? pj.ratePaise : null,
      amountPaise: priced ? pj.amountPaise : null,
      money: money ? (moneyOf.get(pj.id) ?? null) : null,
    };
  });
}

export type PrintJobRow = Awaited<ReturnType<typeof shape>>[number];

/** Every print job, newest first (the list filters in the browser, like other lists). */
export async function listPrintJobs(user: SessionUser) {
  if (!can(user, "printJobs", "view")) return [];
  return shape(user, await printJobRows());
}

/** P6: a customer's print history. */
export async function customerPrintJobs(user: SessionUser, customerId: number) {
  if (!can(user, "printJobs", "view")) return [];
  return shape(user, await printJobRows(eq(printJobs.customerId, customerId)));
}

/** P4: the prints on a job (its printing cost on the T27 card comes from these). */
export async function jobPrintJobs(user: SessionUser, jobId: number) {
  if (!can(user, "printJobs", "view")) return [];
  return shape(user, await printJobRows(eq(printJobs.jobId, jobId)));
}

/** One print job with its reprints, or undefined. */
export async function getPrintJob(user: SessionUser, id: number) {
  if (!can(user, "printJobs", "view") || !Number.isSafeInteger(id)) return undefined;
  const [row] = await shape(user, await printJobRows(eq(printJobs.id, id)));
  if (!row) return undefined;
  const reprints = await db
    .select({ id: printJobs.id, number: printJobs.number, date: printJobs.date, status: printJobs.status })
    .from(printJobs)
    .where(eq(printJobs.reprintOfId, id))
    .orderBy(asc(printJobs.id));
  return { ...row, reprints };
}

/** Pick lists for the form: active customers, their open jobs, active machines (cost rate only with cost access) and types. */
export async function printFormOptions(user: SessionUser, keep: { customerId?: number; jobId?: number | null; machineId?: number; printingTypeId?: number } = {}) {
  const [allCustomers, openJobs, allMachines, types, categories] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, firmName: customers.firmName, mobile: customers.mobile, active: customers.active })
      .from(customers)
      .orderBy(asc(customers.name)),
    db
      .select({ id: jobs.id, number: jobs.number, customerId: jobs.customerId })
      .from(jobs)
      .where(or(inArray(jobs.status, [...PRODUCTION_STATUSES]), keep.jobId ? eq(jobs.id, keep.jobId) : undefined))
      .orderBy(desc(jobs.id)),
    listMachines(user),
    listPrintingTypes(),
    db.select({ id: productCategories.id, name: productCategories.name }).from(productCategories).where(eq(productCategories.active, true)).orderBy(asc(productCategories.id)),
  ]);
  return {
    customers: allCustomers
      .filter((c) => c.active || c.id === keep.customerId)
      .map((c) => ({ id: c.id, name: c.name, firmName: c.firmName, mobile: c.mobile })),
    jobs: openJobs,
    machines: allMachines
      .filter((m) => m.active || m.id === keep.machineId)
      .map((m) => ({ id: m.id, name: m.name, saleRatePaise: m.saleRatePaise, costRatePaise: m.costRatePaise ?? null })),
    types: types.filter((t) => t.active || t.id === keep.printingTypeId).map((t) => ({ id: t.id, name: t.name, categoryId: t.categoryId })),
    categories,
  };
}

/** A print job as a list row (the /print-jobs list, a customer's print history, a job's prints). */
export function listRow(r: PrintJobRow) {
  const billed = r.money?.invoice;
  return {
    id: r.id,
    number: r.number,
    date: r.date,
    printedAt: r.printedAt,
    customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
    fileName: r.fileName,
    machine: r.machine,
    type: r.type,
    size: `${milliText(r.widthMilli)} × ${milliText(r.heightMilli)}`,
    qty: milliText(r.qtyMilli),
    sqft: milliText(r.sqftMilli),
    operator: r.operator,
    job: r.job ?? "",
    billing: r.status === "cancelled" ? "Cancelled" : r.mode === "job_cost" ? "On a job" : billed ? "Billed" : "Unbilled",
    invoice: billed ? (billed.number ?? "Draft") : "",
    amount: r.amountPaise,
    onJob: r.mode === "job_cost",
    received: r.money && r.mode === "sale" ? r.money.received : null,
    balance: r.money?.balance ?? null,
    status: r.money ? r.money.payment : r.status === "cancelled" ? ("Cancelled" as const) : ("Active" as const),
  };
}

// ---- Dashboard, report #20, thumbnail (T38: P6, P7, P9)

/** Not paid yet (A§5): what "Printed But Payment Pending" lists. Overdue = billed on an invoice that is past due. */
export const PENDING: PrintPayment[] = ["Unpaid", "Part Payment", "Credit Customer", "Overdue"];

/**
 * P9 "Printing today" (owner / accountant): today's print jobs and sq ft (cancelled left out); value = today's new
 * (sale) prints — a print on a job is that job's cost, never a print sale; pending = what is still open on them (the
 * A§5 pending statuses: amount − money taken for the print); received = value − pending.
 */
export async function printingToday(today = todayIST()) {
  const rows = await db
    .select({ pj: printJobs, creditCustomer: customers.isCreditCustomer })
    .from(printJobs)
    .innerJoin(customers, eq(customers.id, printJobs.customerId))
    .where(and(eq(printJobs.date, today), eq(printJobs.status, "active")));
  const sale = rows.filter((r) => r.pj.mode === "sale");
  const money = await printJobMoney(sale.map((r) => ({ ...r.pj, creditCustomer: r.creditCustomer })));
  const value = sale.reduce((s, r) => s + r.pj.amountPaise, 0n);
  const pending = sale.reduce((s, { pj }) => {
    const m = money.get(pj.id)!;
    return PENDING.includes(m.payment) && pj.amountPaise > m.received ? s + pj.amountPaise - m.received : s;
  }, 0n);
  return { jobs: rows.length, sqftMilli: rows.reduce((s, r) => s + r.pj.sqftMilli, 0n), value, received: value - pending, pending };
}

/**
 * S20 #20 / P9 "Printed But Payment Pending" (owner / accountant): new (sale) prints whose status is Unpaid, Part
 * Payment, Credit Customer — or Overdue once billed on an invoice past its due date — with amount, money taken for the
 * print (also when it moved to its invoice), balance, customer, machine, operator. As of now; the period only narrows
 * the prints by date. Prints on a job are left out: they are the job's cost and its money is collected on the job.
 */
export async function printPendingReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !can(user, "printJobs", "money")) return null;
  const { period, range, error } = reportRange(q, "all");
  const machineList = await db.select({ id: machines.id, name: machines.name }).from(machines).orderBy(asc(machines.name));
  const picks = [
    pick("machine", "Machine", machineList.map((m) => [String(m.id), m.name]), q),
    pick("status", "Status", PENDING.map((s) => [s, s]), q),
  ];
  const [machine, status] = picks.map((p) => p.value);
  const rows = await shape(
    user,
    await printJobRows(
      and(
        eq(printJobs.mode, "sale"),
        eq(printJobs.status, "active"),
        range.from ? gte(printJobs.date, range.from) : undefined,
        range.to ? lte(printJobs.date, range.to) : undefined,
        machine ? eq(printJobs.machineId, Number(machine)) : undefined,
      ),
    ),
  );
  const shown = rows
    .filter((r) => r.money && PENDING.includes(r.money.payment) && (!status || r.money.payment === status))
    .reverse(); // oldest first
  const money = (r: PrintJobRow) => ({ amount: r.amountPaise!, received: r.money!.received, balance: r.amountPaise! - r.money!.received });
  const amountCols = [moneyCol("amount", "Amount"), moneyCol("received", "Received"), moneyCol("balance", "Balance")];

  return {
    report: {
      title: "Printed but payment pending",
      filters: [`As of ${formatDate(todayIST(now))}`, ...(range.from || range.to ? [`Printed: ${rangeText(range)}`] : []), ...pickFilters(picks)],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "date", label: "Date", type: "date" },
            { key: "number", label: "Print job" },
            { key: "customer", label: "Customer" },
            { key: "file", label: "File" },
            { key: "machine", label: "Machine" },
            { key: "operator", label: "Operator" },
            { key: "status", label: "Status" },
            { key: "invoice", label: "Invoice" },
            ...amountCols,
          ],
          rows: shown.map((r) => ({
            href: `/print-jobs/${r.id}`,
            date: r.date,
            number: r.number,
            customer: party(r.customer, r.firmName),
            file: r.fileName,
            machine: r.machine,
            operator: r.operator,
            status: r.money!.payment,
            invoice: r.money!.invoice ? (r.money!.invoice.number ?? "Draft") : null,
            ...money(r),
          })),
          note: "A billed print follows its invoice; its balance is the amount less the money taken for the print. Prints on a job are collected with the job.",
        },
        {
          title: "Totals by status",
          columns: [{ key: "status", label: "Status" }, { key: "count", label: "Print jobs", type: "number" }, ...amountCols],
          rows: rollUp(shown, (r) => r.money!.payment, (r) => ({ status: r.money!.payment }), (r) => ({ count: 1n, ...money(r) })),
        },
      ],
    },
    period,
    error,
    periods: OPEN_PERIODS,
    picks,
  };
}

/** The print job's latest thumbnail (an attachment the agent sends, T39), or null. */
export async function printThumbnail(printJobId: number) {
  const [row] = await db
    .select({ id: attachments.id, fileName: attachments.fileName })
    .from(attachments)
    .where(and(eq(attachments.entityType, "print_job"), eq(attachments.entityId, printJobId), eq(attachments.kind, "print_thumbnail")))
    .orderBy(desc(attachments.id))
    .limit(1);
  return row ?? null;
}
