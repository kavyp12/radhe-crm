import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, writeTx, type Tx } from "@/db";
import { customers, journalLines, users, vendors } from "@/db/schema";
import { formDays, formEmail, formMoney, formPhone, formText, UserError } from "@/lib/action";
import { stateAndGstin } from "@/lib/gstin";
import { setOpening, systemAccountId } from "@/lib/ledger";
import { can, type SessionUser } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";

// Customers (S1, A§2). Sales may create and edit (A§8); only the owner / accountant deactivate a customer or set the
// opening balance, which posts to the journal (D40). Balances come from the journal, never from the row.

/** The form's fields, as typed. openingBalance / active: undefined = leave as they are. */
export type CustomerInput = {
  name: string;
  firmName: string;
  mobile: string;
  email: string;
  gstin: string;
  stateCode: string;
  billingAddress: string;
  siteAddress: string;
  creditLimit: string;
  creditDays: string;
  isCreditCustomer: boolean;
  salesPersonId: string;
  collectionPersonId: string;
  notes: string;
  openingBalance?: string; // rupees, minus = Cr
  active?: boolean;
};

async function values(tx: Tx, input: CustomerInput) {
  const name = formText(input.name, "name");
  if (!name) throw new UserError("Enter the customer's name.", "name");
  const creditLimitPaise = formMoney(input.creditLimit, "creditLimit");
  if (creditLimitPaise !== null && creditLimitPaise < 0n) throw new UserError("A credit limit can't be negative.", "creditLimit");

  const people = [input.salesPersonId, input.collectionPersonId].filter(Boolean);
  // Any existing user: a person disabled later stays on the customers they were given.
  const found = people.length ? await tx.select({ id: users.id }).from(users).where(inArray(users.id, people)) : [];
  const person = (id: string, field: string) => {
    if (!id) return null;
    if (!found.some((u) => u.id === id)) throw new UserError("Pick someone from the list.", field);
    return id;
  };

  return {
    name,
    firmName: formText(input.firmName, "firmName"),
    mobile: formPhone(input.mobile, "mobile"),
    email: formEmail(input.email, "email"),
    ...stateAndGstin(input.stateCode, input.gstin),
    billingAddress: formText(input.billingAddress, "billingAddress", 1000),
    siteAddress: formText(input.siteAddress, "siteAddress", 1000),
    creditLimitPaise,
    creditDays: formDays(input.creditDays, "creditDays"),
    isCreditCustomer: input.isCreditCustomer,
    salesPersonId: person(input.salesPersonId, "salesPersonId"),
    collectionPersonId: person(input.collectionPersonId, "collectionPersonId"),
    notes: formText(input.notes, "notes", 2000),
  };
}

/** The opening balance the form sent, if any; only owner / accountant may send one (D40). */
function openingFrom(actor: SessionUser, input: CustomerInput): bigint | undefined {
  if (input.openingBalance === undefined) return undefined;
  if (!can(actor, "openingBalances", "edit")) {
    throw new UserError("Only the owner or the accountant can set an opening balance.", "openingBalance");
  }
  return formMoney(input.openingBalance, "openingBalance") ?? 0n;
}

// + = the customer owes us: Dr ar (customer) / Cr opening_equity; − the other way (A§3).
const postOpening = (tx: Tx, id: number, name: string, amount: bigint) =>
  setOpening(
    tx,
    { type: "customers", id, narration: `Opening balance: ${name}` },
    amount,
    { account: "ar", customerId: id },
    { account: "opening_equity" },
  );

export async function createCustomer(actor: SessionUser, input: CustomerInput): Promise<number> {
  if (!can(actor, "customers", "create")) throw new Error("Not allowed");
  const opening = openingFrom(actor, input) ?? 0n;
  const { defaultCreditDays } = await getSettings();
  return writeTx(actor, async (tx) => {
    const v = await values(tx, input);
    const [row] = await tx
      .insert(customers)
      .values({ ...v, creditDays: v.creditDays ?? defaultCreditDays, openingBalancePaise: opening, createdBy: actor.id })
      .returning({ id: customers.id });
    if (opening !== 0n) await postOpening(tx, row.id, v.name, opening);
    return row.id;
  });
}

export async function updateCustomer(actor: SessionUser, id: number, input: CustomerInput): Promise<void> {
  if (!can(actor, "customers", "edit")) throw new Error("Not allowed");
  const opening = openingFrom(actor, input);
  await writeTx(actor, async (tx) => {
    const [current] = await tx.select().from(customers).where(eq(customers.id, id)).for("update");
    if (!current) throw new UserError("That customer doesn't exist.");
    const v = await values(tx, input);
    const active = input.active ?? current.active;
    if (active !== current.active && !can(actor, "customers", "cancel")) {
      throw new UserError("Only the owner or the accountant can deactivate a customer.", "active");
    }
    const openingBalancePaise = opening ?? current.openingBalancePaise;
    await tx.update(customers).set({ ...v, active, openingBalancePaise }).where(eq(customers.id, id));
    if (openingBalancePaise !== current.openingBalancePaise) await postOpening(tx, id, v.name, openingBalancePaise);
  });
}

/** Everyone who can be picked as sales / collection person (Q4 will say who they are). */
export const staffOptions = () =>
  db.select({ id: users.id, name: users.name }).from(users).where(eq(users.active, true)).orderBy(asc(users.name));

/** All customers with their outstanding = AR balance from the journal (+ = they owe us). */
export async function listCustomers() {
  const ar = await systemAccountId("ar");
  const balance = db
    .select({
      customerId: journalLines.customerId,
      paise: sql<string>`sum(${journalLines.debitPaise} - ${journalLines.creditPaise})`.as("paise"),
    })
    .from(journalLines)
    .where(eq(journalLines.accountId, ar))
    .groupBy(journalLines.customerId)
    .as("balance");
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      firmName: customers.firmName,
      mobile: customers.mobile,
      gstin: customers.gstin,
      active: customers.active,
      outstanding: balance.paise,
    })
    .from(customers)
    .leftJoin(balance, eq(balance.customerId, customers.id))
    .orderBy(asc(customers.name));
  return rows.map((r) => ({ ...r, outstanding: BigInt(r.outstanding ?? 0) }));
}

const salesPerson = alias(users, "sales_person");
const collectionPerson = alias(users, "collection_person");

export async function getCustomer(id: number) {
  const [row] = await db
    .select({ customer: customers, salesPerson: salesPerson.name, collectionPerson: collectionPerson.name })
    .from(customers)
    .leftJoin(salesPerson, eq(salesPerson.id, customers.salesPersonId))
    .leftJoin(collectionPerson, eq(collectionPerson.id, customers.collectionPersonId))
    .where(eq(customers.id, id));
  return row && { ...row.customer, salesPerson: row.salesPerson, collectionPerson: row.collectionPerson };
}

/**
 * S1 totals from the customer's AR lines: business = invoices (+ estimates) and debit notes less credit notes,
 * received = receipts, outstanding = the AR balance, last payment = the latest receipt still in force.
 * Zero until invoices (T12) and receipts (T13) post; doc_type is the posting table's name.
 */
export async function customerOverview(id: number) {
  const ar = await systemAccountId("ar");
  const [row] = await db.execute<{ business: string; received: string; outstanding: string; last: string | null }>(sql`
    select
      coalesce(sum(l.debit_paise - l.credit_paise)
        filter (where e.doc_type in ('invoices', 'debit_notes', 'credit_notes')), 0) as business,
      coalesce(sum(l.credit_paise - l.debit_paise) filter (where e.doc_type = 'receipts'), 0) as received,
      coalesce(sum(l.debit_paise - l.credit_paise), 0) as outstanding,
      max(e.date) filter (where e.doc_type = 'receipts' and e.reverses_entry_id is null
        and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id)) as last
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    where l.account_id = ${ar} and l.customer_id = ${id}`);
  return {
    business: BigInt(row.business),
    received: BigInt(row.received),
    outstanding: BigInt(row.outstanding),
    lastPaymentDate: row.last,
  };
}

/**
 * Other customers / vendors with this GSTIN or mobile (last 10 digits), for a warning on the form, never a block
 * (D46). exceptId = the record being edited.
 */
export async function findDuplicates(
  table: typeof customers | typeof vendors,
  gstinInput: string,
  mobileInput: string,
  exceptId?: number,
) {
  const gstin = gstinInput.replace(/\s/g, "").toUpperCase();
  const mobile = mobileInput.replace(/\D/g, "").slice(-10);
  if (gstin.length < 15 && mobile.length < 10) return [];
  const rows = await db
    .select({ id: table.id, name: table.name, gstin: table.gstin })
    .from(table)
    .where(
      or(
        gstin.length === 15 ? eq(table.gstin, gstin) : undefined,
        mobile.length === 10
          ? sql`right(regexp_replace(coalesce(${table.mobile}, ''), '[^0-9]', '', 'g'), 10) = ${mobile}`
          : undefined,
      ),
    )
    .orderBy(asc(table.name));
  return rows
    .filter((r) => r.id !== exceptId)
    .map((r) => ({ id: r.id, name: r.name, same: r.gstin === gstin ? "GSTIN" : "mobile" }));
}

/** The warning text for findDuplicates, or null. */
export function duplicateText(found: Awaited<ReturnType<typeof findDuplicates>>, what: string): string | null {
  if (!found.length) return null;
  return `Also on another ${what}: ${found.map((d) => `${d.name} (same ${d.same})`).join(", ")}. Save anyway if that's right.`;
}
