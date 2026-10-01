import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, writeTx } from "@/db";
import { customers, followUps, invoices, users } from "@/db/schema";
import { formMoney, formText, UserError } from "@/lib/action";
import { formatDate, todayIST } from "@/lib/dates";
import { can, type SessionUser } from "@/lib/permissions";
import { readDate } from "@/lib/sales";

// Payment follow-ups (S8, A§2, D57). A log: each call is a new row (never changed or deleted); the customer's latest
// follow-up holds their next reminder. "My follow-ups" = latest follow-ups whose person is me with the next reminder
// on or before today. A promise (date + expected amount) is kept once the customer's receipts dated on or after the
// follow-up reach the expected amount; broken when its date has passed before that. Computed, never stored (hard rule 6).

export type FollowUpInput = {
  customerId: string;
  invoiceId: string;
  followUpDate: string;
  personId: string;
  response: string;
  promiseDate: string;
  expected: string;
  nextReminderDate: string;
};

const optionalDate = (value: string, field: string) => {
  if (!value.trim()) return null;
  try {
    return readDate(value);
  } catch {
    throw new UserError("Use DD/MM/YYYY, e.g. 28/09/2026.", field);
  }
};

export async function createFollowUp(actor: SessionUser, input: FollowUpInput): Promise<{ id: number; message: string }> {
  if (!can(actor, "followUps", "create")) throw new Error("Not allowed");
  const followUpDate = optionalDate(input.followUpDate, "followUpDate");
  if (!followUpDate) throw new UserError("Enter the follow-up date.", "followUpDate");
  const promiseDate = optionalDate(input.promiseDate, "promiseDate");
  const expected = formMoney(input.expected, "expected");
  const nextReminderDate = optionalDate(input.nextReminderDate, "nextReminderDate");
  const response = formText(input.response, "response", 1000);
  if (expected !== null && expected <= 0n) throw new UserError("The expected amount must be more than 0.", "expected");
  if ((promiseDate === null) !== (expected === null)) {
    throw new UserError(promiseDate ? "Enter the amount promised." : "Enter the date the payment was promised for.", promiseDate ? "expected" : "promiseDate");
  }
  if (promiseDate && promiseDate < followUpDate) throw new UserError("The promise date can't be before the follow-up.", "promiseDate");
  if (nextReminderDate && nextReminderDate < followUpDate) throw new UserError("The next reminder can't be before the follow-up.", "nextReminderDate");

  return writeTx(actor, async (tx) => {
    const customerId = Number(input.customerId);
    const [customer] = Number.isSafeInteger(customerId) ? await tx.select().from(customers).where(eq(customers.id, customerId)) : [];
    if (!customer) throw new UserError("Pick the customer.", "customerId");
    let invoiceId: number | null = null;
    if (input.invoiceId) {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, Number(input.invoiceId) || 0), eq(invoices.customerId, customerId), eq(invoices.status, "issued")));
      if (!inv) throw new UserError("Pick one of the customer's issued invoices (or leave it blank).", "invoiceId");
      invoiceId = inv.id;
    }
    const [person] = await tx.select().from(users).where(and(eq(users.id, input.personId), eq(users.active, true)));
    if (!person) throw new UserError("Pick who followed up.", "personId");
    const [row] = await tx
      .insert(followUps)
      .values({ customerId, invoiceId, followUpDate, personId: person.id, response, promiseDate, expectedPaise: expected, nextReminderDate, createdBy: actor.id })
      .returning({ id: followUps.id });
    const next = nextReminderDate ? ` Next reminder ${formatDate(nextReminderDate)}.` : "";
    return { id: row.id, message: `Follow-up for ${customer.name} saved.${next}` };
  });
}

export type PromiseState = "Kept" | "Broken" | "Due today" | "Pending";

/** D57: kept once the receipts since the follow-up reach the expected amount; else broken after the promise date. */
export function promiseState(f: { promiseDate: string | null; expected: bigint | null; received: bigint }, today = todayIST()): PromiseState | null {
  if (!f.promiseDate || f.expected === null) return null;
  if (f.received >= f.expected) return "Kept";
  if (f.promiseDate < today) return "Broken";
  return f.promiseDate === today ? "Due today" : "Pending";
}

// The customer's receipts (not cancelled) dated on or after the follow-up.
const receivedSince = sql<string>`(select coalesce(sum(r.amount_paise), 0) from receipts r
  where r.customer_id = ${followUps.customerId} and r.status = 'active' and r.date >= ${followUps.followUpDate})`;
// No later follow-up for the customer (by date, then entry order).
export const latestFollowUp = sql`not exists (select 1 from follow_ups l where l.customer_id = ${followUps.customerId}
  and (l.follow_up_date, l.id) > (${followUps.followUpDate}, ${followUps.id}))`;

/** Follow-ups with names and the promise state, newest first. */
export async function listFollowUps(where?: SQL, today = todayIST()) {
  const rows = await db
    .select({
      id: followUps.id,
      customerId: followUps.customerId,
      customer: customers.name,
      invoiceId: followUps.invoiceId,
      invoice: invoices.number,
      followUpDate: followUps.followUpDate,
      personId: followUps.personId,
      person: users.name,
      response: followUps.response,
      promiseDate: followUps.promiseDate,
      expected: followUps.expectedPaise,
      nextReminderDate: followUps.nextReminderDate,
      received: receivedSince,
      latest: sql<boolean>`${latestFollowUp}`,
    })
    .from(followUps)
    .innerJoin(customers, eq(customers.id, followUps.customerId))
    .innerJoin(users, eq(users.id, followUps.personId))
    .leftJoin(invoices, eq(invoices.id, followUps.invoiceId))
    .where(where)
    .orderBy(desc(followUps.followUpDate), desc(followUps.id));
  return rows.map((r) => {
    const received = BigInt(r.received);
    return { ...r, received, promise: promiseState({ ...r, received }, today) };
  });
}

/** Mine to follow up: the customer's latest follow-up, my name on it, next reminder on or before today. */
export const myFollowUpsDue = (user: SessionUser, today = todayIST()) =>
  listFollowUps(and(eq(followUps.personId, user.id), latestFollowUp, sql`${followUps.nextReminderDate} <= ${today}`), today);

/** The sidebar badge: how many of mine are due (0 for users without follow-ups). */
export async function myFollowUpsDueCount(user: SessionUser, today = todayIST()): Promise<number> {
  if (!can(user, "followUps", "view")) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(followUps)
    .where(and(eq(followUps.personId, user.id), latestFollowUp, sql`${followUps.nextReminderDate} <= ${today}`));
  return row.n;
}

/** Promises not kept whose date is today or past (alerts, D57). */
export const openPromises = (today = todayIST()) =>
  listFollowUps(sql`${followUps.promiseDate} <= ${today} and ${followUps.expectedPaise} > ${receivedSince}`, today);

/** Pick lists: active customers, their issued invoices, active staff. */
export async function followUpFormOptions() {
  const [customerRows, invoiceRows, staff] = await Promise.all([
    db.select({ id: customers.id, name: customers.name, firmName: customers.firmName }).from(customers).where(eq(customers.active, true)).orderBy(asc(customers.name)),
    db
      .select({ id: invoices.id, number: invoices.number, customerId: invoices.customerId, date: invoices.date })
      .from(invoices)
      .where(eq(invoices.status, "issued"))
      .orderBy(desc(invoices.date), desc(invoices.id)),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.active, true)).orderBy(asc(users.name)),
  ]);
  return { customers: customerRows, invoices: invoiceRows.map((i) => ({ ...i, number: i.number ?? "" })), staff };
}
