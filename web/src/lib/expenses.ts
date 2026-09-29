import { and, asc, desc, eq } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { accounts, customers, expenseCategories, expenses, jobs, vendors } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { type Change, needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, fyKey } from "@/lib/dates";
import { checkBooksDate, liveEntry, moneyAccounts, post, reverse } from "@/lib/ledger";
import { formatMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { RECEIPT_MODE, RECEIPT_MODES } from "@/lib/receipt-modes";
import { checkVersion, readDate } from "@/lib/sales";

// Expenses (S10, S24, A§2, A§3, D51): paid straight from a money account; numbered EX/ and posted on save:
//   Dr the category's expense account (with the job, if tagged — A§10 job costing reads it) / Cr the money account.
// No GST split (S10). Edit = reverse + repost (audited), cancel = reverse on its own date (D45). The backdate gate
// (A§7) applies whenever one is saved: a non-owner's save, edit or cancel with a date before the window → a request.

type Expense = typeof expenses.$inferSelect;

/** The form as typed; vendorId / jobId blank = none. */
export type ExpenseInput = {
  date: string;
  categoryId: string;
  vendorId: string;
  jobId: string;
  amount: string;
  mode: string;
  moneyAccountId: string;
  notes: string;
};

const pick = (text: string) => (text ? Number(text) : null);

async function readExpense(tx: Tx, input: ExpenseInput, current?: Expense) {
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const categoryId = Number(input.categoryId);
  const [category] = Number.isSafeInteger(categoryId)
    ? await tx.select().from(expenseCategories).where(eq(expenseCategories.id, categoryId))
    : [];
  if (!category || (!category.active && category.id !== current?.categoryId)) throw new UserError("Pick the category.", "categoryId");

  const vendorId = pick(input.vendorId);
  let vendor: { id: number; name: string } | null = null;
  if (vendorId !== null) {
    const [v] = Number.isSafeInteger(vendorId) ? await tx.select().from(vendors).where(eq(vendors.id, vendorId)) : [];
    if (!v || (!v.active && v.id !== current?.vendorId)) throw new UserError("Pick the vendor again (or leave it blank).", "vendorId");
    vendor = v;
  }
  const jobId = pick(input.jobId);
  let job: { id: number; number: string } | null = null;
  if (jobId !== null) {
    const [j] = Number.isSafeInteger(jobId) ? await tx.select().from(jobs).where(eq(jobs.id, jobId)) : [];
    if (!j) throw new UserError("Pick the job again (or leave it blank).", "jobId");
    if (j.status === "cancelled" && j.id !== current?.jobId) throw new UserError(`Job ${j.number} is cancelled.`, "jobId");
    job = j;
  }

  const amountPaise = formMoney(input.amount, "amount");
  if (amountPaise === null || amountPaise <= 0n) throw new UserError("Enter the amount paid.", "amount");
  const mode = RECEIPT_MODES.find((m) => m === input.mode);
  if (!mode) throw new UserError("Pick how it was paid.", "mode");
  const accountId = Number(input.moneyAccountId);
  const [account] = Number.isSafeInteger(accountId)
    ? await tx.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isMoney, true)))
    : [];
  if (!account) throw new UserError("Pick the account it was paid from.", "moneyAccountId");
  return {
    category,
    vendor,
    job,
    account,
    values: {
      date,
      categoryId: category.id,
      vendorId: vendor?.id ?? null,
      jobId: job?.id ?? null,
      amountPaise,
      mode,
      moneyAccountId: account.id,
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

type Read = Awaited<ReturnType<typeof readExpense>>;

/** A§3: Dr the category's expense account (job_id) / Cr the money account. */
const postExpense = (tx: Tx, id: number, number: string, r: Read) =>
  post(tx, {
    date: r.values.date,
    docType: "expenses",
    docId: id,
    number,
    narration: `Expense ${number} · ${r.category.name}${r.job ? ` · job ${r.job.number}` : ""}${r.vendor ? ` · ${r.vendor.name}` : ""}`,
    lines: [
      { account: r.category.accountId, jobId: r.values.jobId ?? undefined, debit: r.values.amountPaise },
      { account: r.values.moneyAccountId, credit: r.values.amountPaise },
    ],
  });

async function doCreate(tx: Tx, actor: SessionUser, input: ExpenseInput) {
  const r = await readExpense(tx, input);
  const number = await nextNumber(tx, "expense", r.values.date);
  const [row] = await tx.insert(expenses).values({ ...r.values, number, createdBy: actor.id }).returning({ id: expenses.id });
  await postExpense(tx, row.id, number, r);
  return { id: row.id, number };
}

type CreatePayload = { input: ExpenseInput };

registerExecutor<CreatePayload>("expense.create", {
  async describe(tx, p) {
    const r = await readExpense(tx, p.input);
    return {
      summary: `Expense ${formatMoney(r.values.amountPaise)} · ${r.category.name}, dated ${formatDate(r.values.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(r.values.date) },
        { label: "Amount", old: null, new: formatMoney(r.values.amountPaise) },
        { label: "Paid from", old: null, new: `${r.account.name} (${RECEIPT_MODE[r.values.mode]})` },
        { label: "Job", old: null, new: r.job?.number ?? null },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

const backdated = (date: string) => `Dated ${formatDate(date)}, before the backdate window`;

/** Save a new expense: numbered and posted in one transaction; a non-owner's backdated one → a request (A§7). */
export async function createExpense(actor: SessionUser, input: ExpenseInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "books", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "expense.create", { input } satisfies CreatePayload, backdated(date));
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lock(tx: Tx, id: number) {
  const [e] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
  if (!e) throw new UserError("That expense doesn't exist.");
  return e;
}

type EditPayload = { id: number; version: string; input: ExpenseInput };

async function planEdit(tx: Tx, p: EditPayload) {
  const current = await lock(tx, p.id);
  if (current.status !== "active") throw new UserError("A cancelled expense can't be changed.");
  checkVersion(current, p.version, "expense");
  const r = await readExpense(tx, p.input, current);
  if (fyKey(r.values.date) !== fyKey(current.date)) {
    throw new UserError("An expense can't move to another financial year: cancel it and enter a new one.", "date");
  }
  const [old] = await tx
    .select({ category: expenseCategories.name, vendor: vendors.name, job: jobs.number, account: accounts.name })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(accounts, eq(accounts.id, expenses.moneyAccountId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .leftJoin(jobs, eq(jobs.id, expenses.jobId))
    .where(eq(expenses.id, current.id));
  const changes: Change[] = [];
  const diff = (label: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ label, old: before, new: after });
  };
  const v = r.values;
  diff("Date", formatDate(current.date), formatDate(v.date));
  diff("Category", old.category, r.category.name);
  diff("Amount", formatMoney(current.amountPaise), formatMoney(v.amountPaise));
  diff("Mode", RECEIPT_MODE[current.mode], RECEIPT_MODE[v.mode]);
  diff("Paid from", old.account, r.account.name);
  diff("Vendor", old.vendor, r.vendor?.name ?? null);
  diff("Job", old.job, r.job?.number ?? null);
  diff("Notes", current.notes, v.notes);
  const reposts =
    v.date !== current.date ||
    v.categoryId !== current.categoryId ||
    v.jobId !== current.jobId ||
    v.amountPaise !== current.amountPaise ||
    v.moneyAccountId !== current.moneyAccountId;
  return { current, r, changes, reposts };
}

/** Edit = reverse (on the old date) + repost when a posted figure changed; the row's old values stay in the audit log. */
async function doEdit(tx: Tx, p: EditPayload) {
  const { current, r, changes, reposts } = await planEdit(tx, p);
  if (!changes.length) return current.number;
  await tx.update(expenses).set(r.values).where(eq(expenses.id, current.id));
  if (reposts) {
    const entry = await liveEntry(tx, "expenses", current.id);
    if (!entry) throw new Error(`Expense ${current.id} has no journal entry in force`);
    await reverse(tx, entry.id, current.date);
    await postExpense(tx, current.id, current.number, r);
  }
  return current.number;
}

registerExecutor<EditPayload>("expense.edit", {
  async describe(tx, p) {
    const { current, changes } = await planEdit(tx, p);
    if (!changes.length) throw new UserError("Nothing was changed.");
    return { summary: `Change expense ${current.number}`, target: { type: "expenses", id: p.id }, changes };
  },
  run: (tx, _owner, p) => doEdit(tx, p),
});

/** Owner / accountant edit at once; a non-owner's edit of a backdated expense (old or new date) → a request (A§7). */
export async function updateExpense(actor: SessionUser, id: number, input: ExpenseInput, reason: string) {
  if (!can(actor, "books", "edit")) throw new Error("Not allowed");
  const [e] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!e) throw new UserError("That expense doesn't exist.");
  if (e.status !== "active") throw new UserError("A cancelled expense can't be changed.");
  const payload: EditPayload = { id, version: e.updatedAt.toISOString(), input };
  const date = readDate(input.date);
  const old = (await needsBackdateApproval(e.date)) ? e.date : (await needsBackdateApproval(date)) ? date : null;
  if (old) {
    const outcome = await runOrRequest(actor, "expense.edit", payload, reason.trim() || backdated(old));
    return { message: outcome.done ? `Saved ${e.number}.` : outcome.message };
  }
  await writeTx(actor, (tx) => doEdit(tx, payload));
  return { message: `Saved ${e.number}.` };
}

type CancelPayload = { id: number };

async function doCancel(tx: Tx, p: CancelPayload) {
  const e = await lock(tx, p.id);
  if (e.status !== "active") throw new UserError("This expense is already cancelled.");
  const entry = await liveEntry(tx, "expenses", e.id);
  if (!entry) throw new Error(`Expense ${e.id} has no journal entry in force`);
  await reverse(tx, entry.id, e.date);
  await tx.update(expenses).set({ status: "cancelled" }).where(eq(expenses.id, e.id));
}

registerExecutor<CancelPayload>("expense.cancel", {
  async describe(tx, p) {
    const [e] = await tx.select().from(expenses).where(eq(expenses.id, p.id));
    if (!e) throw new UserError("That expense doesn't exist.");
    if (e.status !== "active") throw new UserError("This expense is already cancelled.");
    return {
      summary: `Cancel expense ${e.number} (${formatMoney(e.amountPaise)})`,
      target: { type: "expenses", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(e.date)}` },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

/** Cancel = reverse on its own date (D45); a non-owner's cancel of a backdated expense → a request. */
export async function cancelExpense(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "books", "cancel")) throw new Error("Not allowed");
  const [e] = await db.select().from(expenses).where(eq(expenses.id, id));
  if (!e) throw new UserError("That expense doesn't exist.");
  if (e.status !== "active") throw new UserError("This expense is already cancelled.");
  if (await needsBackdateApproval(e.date)) {
    const outcome = await runOrRequest(actor, "expense.cancel", { id } satisfies CancelPayload, reason.trim() || backdated(e.date));
    return { message: outcome.done ? `Cancelled ${e.number}; its entry is reversed.` : outcome.message };
  }
  await writeTx(actor, (tx) => doCancel(tx, { id }));
  return { message: `Cancelled ${e.number}; its entry is reversed.` };
}

// ---- Loaders

export async function listExpenses() {
  return db
    .select({
      id: expenses.id,
      number: expenses.number,
      date: expenses.date,
      category: expenseCategories.name,
      vendor: vendors.name,
      job: jobs.number,
      account: accounts.name,
      mode: expenses.mode,
      amount: expenses.amountPaise,
      status: expenses.status,
      notes: expenses.notes,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(accounts, eq(accounts.id, expenses.moneyAccountId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .leftJoin(jobs, eq(jobs.id, expenses.jobId))
    .orderBy(desc(expenses.id));
}

export async function getExpense(id: number) {
  const [row] = await db
    .select({ expense: expenses, category: expenseCategories.name, vendor: vendors.name, job: jobs.number, account: accounts.name })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .innerJoin(accounts, eq(accounts.id, expenses.moneyAccountId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .leftJoin(jobs, eq(jobs.id, expenses.jobId))
    .where(eq(expenses.id, id));
  return row && { ...row.expense, category: row.category, vendor: row.vendor, job: row.job, account: row.account };
}

/** Pick lists: active categories and vendors, jobs not cancelled (plus what this expense uses), money accounts. */
export async function expenseFormOptions(keep: Partial<Pick<Expense, "categoryId" | "vendorId" | "jobId">> = {}) {
  const [categoryRows, vendorRows, jobRows, money] = await Promise.all([
    db.select().from(expenseCategories).orderBy(asc(expenseCategories.name)),
    db.select().from(vendors).orderBy(asc(vendors.name)),
    db
      .select({ id: jobs.id, number: jobs.number, status: jobs.status, customer: customers.name })
      .from(jobs)
      .innerJoin(customers, eq(customers.id, jobs.customerId))
      .orderBy(desc(jobs.id)),
    moneyAccounts(),
  ]);
  return {
    categories: categoryRows.filter((c) => c.active || c.id === keep.categoryId).map((c) => ({ id: c.id, name: c.name })),
    vendors: vendorRows.filter((v) => v.active || v.id === keep.vendorId).map((v) => ({ id: v.id, name: v.name })),
    jobs: jobRows.filter((j) => j.status !== "cancelled" || j.id === keep.jobId).map((j) => ({ id: j.id, number: j.number, customer: j.customer })),
    accounts: money.map((a) => ({ id: a.id, name: a.name, systemKey: a.systemKey })),
  };
}
