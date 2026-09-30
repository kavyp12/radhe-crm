import { and, desc, eq, lte, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, writeTx, type Tx } from "@/db";
import { accounts, journalEntries, journalLines, transfers } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { type Change, needsBackdateApproval, registerExecutor, runOrRequest } from "@/lib/approvals";
import { formatDate, fyKey } from "@/lib/dates";
import { checkBooksDate, liveEntry, post, reverse } from "@/lib/ledger";
import { formatMoney } from "@/lib/num";
import { nextNumber } from "@/lib/numbering";
import { can, type SessionUser } from "@/lib/permissions";
import { checkVersion, readDate } from "@/lib/sales";

// Transfers (contra, S13, A§3, D55): money moved between two money accounts, numbered TR/ and posted on save —
// Dr the to-account / Cr the from-account. The same account is refused; the from-account going below zero that day
// is only a warning (transferWarning). Edit = reverse (on the old date) + repost, cancel = reverse on its own date
// (D45). Owner / accountant (A§8); the backdate gate (A§7) sends a non-owner's old-dated save, edit or cancel to the owner.

type Transfer = typeof transfers.$inferSelect;

export type TransferInput = {
  date: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  reference: string;
  notes: string;
};

async function moneyAccount(tx: Tx, text: string, field: string, what: string) {
  const id = Number(text);
  const [account] = Number.isSafeInteger(id)
    ? await tx.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.isMoney, true)))
    : [];
  if (!account) throw new UserError(`Pick the account the money goes ${what}.`, field);
  return account;
}

async function readTransfer(tx: Tx, input: TransferInput) {
  const date = readDate(input.date);
  await checkBooksDate(tx, date);
  const from = await moneyAccount(tx, input.fromAccountId, "fromAccountId", "out of");
  const to = await moneyAccount(tx, input.toAccountId, "toAccountId", "into");
  if (from.id === to.id) throw new UserError("Pick two different accounts.", "toAccountId");
  const amountPaise = formMoney(input.amount, "amount");
  if (amountPaise === null || amountPaise <= 0n) throw new UserError("Enter the amount moved.", "amount");
  return {
    from,
    to,
    values: {
      date,
      fromAccountId: from.id,
      toAccountId: to.id,
      amountPaise,
      reference: formText(input.reference, "reference", 100),
      notes: formText(input.notes, "notes", 2000),
    },
  };
}

type Read = Awaited<ReturnType<typeof readTransfer>>;

/** A§3: Dr the to-account / Cr the from-account. */
const postTransfer = (tx: Tx, id: number, number: string, r: Read) =>
  post(tx, {
    date: r.values.date,
    docType: "transfers",
    docId: id,
    number,
    narration: `Transfer ${number} · ${r.from.name} → ${r.to.name}`,
    lines: [
      { account: r.to.id, debit: r.values.amountPaise },
      { account: r.from.id, credit: r.values.amountPaise },
    ],
  });

async function doCreate(tx: Tx, actor: SessionUser, input: TransferInput) {
  const r = await readTransfer(tx, input);
  const number = await nextNumber(tx, "transfer", r.values.date);
  const [row] = await tx.insert(transfers).values({ ...r.values, number, createdBy: actor.id }).returning({ id: transfers.id });
  await postTransfer(tx, row.id, number, r);
  return { id: row.id, number };
}

type CreatePayload = { input: TransferInput };

registerExecutor<CreatePayload>("transfer.create", {
  async describe(tx, p) {
    const r = await readTransfer(tx, p.input);
    return {
      summary: `Transfer ${formatMoney(r.values.amountPaise)} ${r.from.name} → ${r.to.name}, dated ${formatDate(r.values.date)}`,
      changes: [
        { label: "Date", old: null, new: formatDate(r.values.date) },
        { label: "Amount", old: null, new: formatMoney(r.values.amountPaise) },
        { label: "From → to", old: null, new: `${r.from.name} → ${r.to.name}` },
        { label: "Reference", old: null, new: r.values.reference },
      ],
    };
  },
  run: (tx, owner, p) => doCreate(tx, owner, p.input),
});

const backdated = (date: string) => `Dated ${formatDate(date)}, before the backdate window`;

/** Save a new transfer: numbered and posted in one transaction; a non-owner's backdated one → a request (A§7). */
export async function createTransfer(actor: SessionUser, input: TransferInput): Promise<{ id: number | null; message: string }> {
  if (!can(actor, "books", "create")) throw new Error("Not allowed");
  const date = readDate(input.date);
  if (await needsBackdateApproval(date)) {
    const outcome = await runOrRequest(actor, "transfer.create", { input } satisfies CreatePayload, backdated(date));
    if (!outcome.done) return { id: null, message: outcome.message };
    const done = outcome.result as { id: number; number: string };
    return { id: done.id, message: `Saved ${done.number}.` };
  }
  const done = await writeTx(actor, (tx) => doCreate(tx, actor, input));
  return { id: done.id, message: `Saved ${done.number}.` };
}

async function lock(tx: Tx, id: number) {
  const [t] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
  if (!t) throw new UserError("That transfer doesn't exist.");
  return t;
}

type EditPayload = { id: number; version: string; input: TransferInput };

const nameOf = async (tx: Tx, id: number) => (await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, id)))[0]?.name ?? `#${id}`;

async function planEdit(tx: Tx, p: EditPayload) {
  const current = await lock(tx, p.id);
  if (current.status !== "active") throw new UserError("A cancelled transfer can't be changed.");
  checkVersion(current, p.version, "transfer");
  const r = await readTransfer(tx, p.input);
  if (fyKey(r.values.date) !== fyKey(current.date)) {
    throw new UserError("A transfer can't move to another financial year: cancel it and enter a new one.", "date");
  }
  const changes: Change[] = [];
  const diff = (label: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ label, old: before, new: after });
  };
  const v = r.values;
  diff("Date", formatDate(current.date), formatDate(v.date));
  diff("Amount", formatMoney(current.amountPaise), formatMoney(v.amountPaise));
  diff("From", await nameOf(tx, current.fromAccountId), r.from.name);
  diff("To", await nameOf(tx, current.toAccountId), r.to.name);
  diff("Reference", current.reference, v.reference);
  diff("Notes", current.notes, v.notes);
  const reposts =
    v.date !== current.date ||
    v.amountPaise !== current.amountPaise ||
    v.fromAccountId !== current.fromAccountId ||
    v.toAccountId !== current.toAccountId;
  return { current, r, changes, reposts };
}

/** Edit = reverse (on the old date) + repost when a posted figure changed; the old values stay in the audit log. */
async function doEdit(tx: Tx, p: EditPayload) {
  const { current, r, changes, reposts } = await planEdit(tx, p);
  if (!changes.length) return current.number;
  await tx.update(transfers).set(r.values).where(eq(transfers.id, current.id));
  if (reposts) {
    const entry = await liveEntry(tx, "transfers", current.id);
    if (!entry) throw new Error(`Transfer ${current.id} has no journal entry in force`);
    await reverse(tx, entry.id, current.date);
    await postTransfer(tx, current.id, current.number, r);
  }
  return current.number;
}

registerExecutor<EditPayload>("transfer.edit", {
  async describe(tx, p) {
    const { current, changes } = await planEdit(tx, p);
    if (!changes.length) throw new UserError("Nothing was changed.");
    return { summary: `Change transfer ${current.number}`, target: { type: "transfers", id: p.id }, changes };
  },
  run: (tx, _owner, p) => doEdit(tx, p),
});

/** Owner / accountant edit at once; a non-owner's edit of a backdated transfer (old or new date) → a request (A§7). */
export async function updateTransfer(actor: SessionUser, id: number, input: TransferInput, reason: string) {
  if (!can(actor, "books", "edit")) throw new Error("Not allowed");
  const [t] = await db.select().from(transfers).where(eq(transfers.id, id));
  if (!t) throw new UserError("That transfer doesn't exist.");
  if (t.status !== "active") throw new UserError("A cancelled transfer can't be changed.");
  const payload: EditPayload = { id, version: t.updatedAt.toISOString(), input };
  const date = readDate(input.date);
  const old = (await needsBackdateApproval(t.date)) ? t.date : (await needsBackdateApproval(date)) ? date : null;
  if (old) {
    const outcome = await runOrRequest(actor, "transfer.edit", payload, reason.trim() || backdated(old));
    return { message: outcome.done ? `Saved ${t.number}.` : outcome.message };
  }
  await writeTx(actor, (tx) => doEdit(tx, payload));
  return { message: `Saved ${t.number}.` };
}

type CancelPayload = { id: number };

async function doCancel(tx: Tx, p: CancelPayload) {
  const t = await lock(tx, p.id);
  if (t.status !== "active") throw new UserError("This transfer is already cancelled.");
  const entry = await liveEntry(tx, "transfers", t.id);
  if (!entry) throw new Error(`Transfer ${t.id} has no journal entry in force`);
  await reverse(tx, entry.id, t.date);
  await tx.update(transfers).set({ status: "cancelled" }).where(eq(transfers.id, t.id));
}

registerExecutor<CancelPayload>("transfer.cancel", {
  async describe(tx, p) {
    const [t] = await tx.select().from(transfers).where(eq(transfers.id, p.id));
    if (!t) throw new UserError("That transfer doesn't exist.");
    if (t.status !== "active") throw new UserError("This transfer is already cancelled.");
    return {
      summary: `Cancel transfer ${t.number} (${formatMoney(t.amountPaise)})`,
      target: { type: "transfers", id: p.id },
      changes: [
        { label: "Status", old: "Active", new: "Cancelled (number kept)" },
        { label: "Journal", old: null, new: `Entry reversed on ${formatDate(t.date)}` },
      ],
    };
  },
  run: (tx, _owner, p) => doCancel(tx, p),
});

/** Cancel = reverse on its own date (D45); a non-owner's cancel of a backdated transfer → a request. */
export async function cancelTransfer(actor: SessionUser, id: number, reason: string): Promise<{ message: string }> {
  if (!can(actor, "books", "cancel")) throw new Error("Not allowed");
  const [t] = await db.select().from(transfers).where(eq(transfers.id, id));
  if (!t) throw new UserError("That transfer doesn't exist.");
  if (t.status !== "active") throw new UserError("This transfer is already cancelled.");
  if (await needsBackdateApproval(t.date)) {
    const outcome = await runOrRequest(actor, "transfer.cancel", { id } satisfies CancelPayload, reason.trim() || backdated(t.date));
    return { message: outcome.done ? `Cancelled ${t.number}; its entry is reversed.` : outcome.message };
  }
  await writeTx(actor, (tx) => doCancel(tx, { id }));
  return { message: `Cancelled ${t.number}; its entry is reversed.` };
}

/**
 * D55's warning (never a block): what the from-account holds at the end of the transfer's day once it is moved —
 * a message when that is below zero, else null. `exceptId`: the transfer being edited (its own entries left out).
 */
export async function transferWarning(input: Pick<TransferInput, "date" | "fromAccountId" | "amount">, exceptId?: number) {
  let date: string;
  let amount: bigint | null;
  try {
    date = readDate(input.date);
    amount = formMoney(input.amount, "amount");
  } catch {
    return null; // the form shows those errors itself
  }
  const accountId = Number(input.fromAccountId);
  if (!amount || amount <= 0n || !Number.isSafeInteger(accountId)) return null;
  const [account] = await db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.isMoney, true)));
  if (!account) return null;
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalLines.debitPaise} - ${journalLines.creditPaise}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(journalLines.accountId, accountId),
        lte(journalEntries.date, date),
        exceptId === undefined ? undefined : not(and(eq(journalEntries.docType, "transfers"), eq(journalEntries.docId, exceptId))!),
      ),
    );
  const after = BigInt(row.net) - amount;
  return after < 0n ? `${account.name} would be ${formatMoney(-after)} below zero at the end of ${formatDate(date)}.` : null;
}

// ---- Loaders

const toAccount = alias(accounts, "to_account");

export async function listTransfers() {
  return db
    .select({
      id: transfers.id,
      number: transfers.number,
      date: transfers.date,
      from: accounts.name,
      to: toAccount.name,
      reference: transfers.reference,
      amount: transfers.amountPaise,
      status: transfers.status,
    })
    .from(transfers)
    .innerJoin(accounts, eq(accounts.id, transfers.fromAccountId))
    .innerJoin(toAccount, eq(toAccount.id, transfers.toAccountId))
    .orderBy(desc(transfers.id));
}

export async function getTransfer(id: number): Promise<(Transfer & { from: string; to: string }) | undefined> {
  const [row] = await db
    .select({ transfer: transfers, from: accounts.name, to: toAccount.name })
    .from(transfers)
    .innerJoin(accounts, eq(accounts.id, transfers.fromAccountId))
    .innerJoin(toAccount, eq(toAccount.id, transfers.toAccountId))
    .where(eq(transfers.id, id));
  return row && { ...row.transfer, from: row.from, to: row.to };
}
