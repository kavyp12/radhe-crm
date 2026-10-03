import { asc, eq, sql } from "drizzle-orm";
import { db, writeTx, type Tx } from "@/db";
import { journalLines, vendors } from "@/db/schema";
import { formDays, formEmail, formMoney, formPhone, formText, UserError } from "@/lib/action";
import { stateAndGstin } from "@/lib/gstin";
import { setOpening, systemAccountId } from "@/lib/ledger";
import { can, type SessionUser } from "@/lib/permissions";

// Vendors (S9, A§2): owner + accountant (A§8). Balances come from the journal's AP lines (+ = we owe them).

/** The form's fields, as typed. openingBalance / active: undefined = leave as they are. */
export type VendorInput = {
  name: string;
  gstin: string;
  stateCode: string;
  mobile: string;
  email?: string; // blank / missing = none
  address: string;
  creditDays: string;
  notes: string;
  openingBalance?: string; // rupees: + = we owe them, minus = they owe us
  active?: boolean;
};

function values(input: VendorInput) {
  const name = formText(input.name, "name");
  if (!name) throw new UserError("Enter the vendor's name.", "name");
  return {
    name,
    ...stateAndGstin(input.stateCode, input.gstin),
    mobile: formPhone(input.mobile, "mobile"),
    email: formEmail(input.email ?? "", "email"),
    address: formText(input.address, "address", 1000),
    creditDays: formDays(input.creditDays, "creditDays"),
    notes: formText(input.notes, "notes", 2000),
  };
}

function openingFrom(actor: SessionUser, input: VendorInput): bigint | undefined {
  if (input.openingBalance === undefined) return undefined;
  if (!can(actor, "openingBalances", "edit")) {
    throw new UserError("Only the owner or the accountant can set an opening balance.", "openingBalance");
  }
  return formMoney(input.openingBalance, "openingBalance") ?? 0n;
}

// + = we owe them: Dr opening_equity / Cr ap (vendor); − the other way (A§3).
const postOpening = (tx: Tx, id: number, name: string, amount: bigint) =>
  setOpening(
    tx,
    { type: "vendors", id, narration: `Opening balance: ${name}` },
    amount,
    { account: "opening_equity" },
    { account: "ap", vendorId: id },
  );

/** A vendor's opening balance changed inside the caller's transaction (opening import, opening-bill cancel, D68). */
export async function setVendorOpening(tx: Tx, id: number, name: string, amount: bigint) {
  await tx.update(vendors).set({ openingBalancePaise: amount }).where(eq(vendors.id, id));
  await postOpening(tx, id, name, amount);
}

export async function createVendor(actor: SessionUser, input: VendorInput): Promise<number> {
  if (!can(actor, "vendors", "create")) throw new Error("Not allowed");
  return writeTx(actor, (tx) => insertVendor(tx, actor, input));
}

/** createVendor inside the caller's transaction (the opening import, T43): the row and its opening balance. */
export async function insertVendor(tx: Tx, actor: SessionUser, input: VendorInput) {
  const opening = openingFrom(actor, input) ?? 0n;
  const v = values(input);
  const [row] = await tx
    .insert(vendors)
    .values({ ...v, openingBalancePaise: opening, createdBy: actor.id })
    .returning({ id: vendors.id });
  if (opening !== 0n) await postOpening(tx, row.id, v.name, opening);
  return row.id;
}

export async function updateVendor(actor: SessionUser, id: number, input: VendorInput): Promise<void> {
  if (!can(actor, "vendors", "edit")) throw new Error("Not allowed");
  const opening = openingFrom(actor, input);
  const v = values(input);
  await writeTx(actor, async (tx) => {
    const [current] = await tx.select().from(vendors).where(eq(vendors.id, id)).for("update");
    if (!current) throw new UserError("That vendor doesn't exist.");
    const active = input.active ?? current.active;
    if (active !== current.active && !can(actor, "vendors", "cancel")) {
      throw new UserError("You can't deactivate a vendor.", "active");
    }
    const openingBalancePaise = opening ?? current.openingBalancePaise;
    await tx.update(vendors).set({ ...v, active, openingBalancePaise }).where(eq(vendors.id, id));
    if (openingBalancePaise !== current.openingBalancePaise) await postOpening(tx, id, v.name, openingBalancePaise);
  });
}

/** All vendors with their outstanding = AP balance from the journal (+ = we owe them). */
export async function listVendors() {
  const ap = await systemAccountId("ap");
  const balance = db
    .select({
      vendorId: journalLines.vendorId,
      paise: sql<string>`sum(${journalLines.creditPaise} - ${journalLines.debitPaise})`.as("paise"),
    })
    .from(journalLines)
    .where(eq(journalLines.accountId, ap))
    .groupBy(journalLines.vendorId)
    .as("balance");
  const rows = await db
    .select({
      id: vendors.id,
      name: vendors.name,
      mobile: vendors.mobile,
      gstin: vendors.gstin,
      active: vendors.active,
      outstanding: balance.paise,
    })
    .from(vendors)
    .leftJoin(balance, eq(balance.vendorId, vendors.id))
    .orderBy(asc(vendors.name));
  return rows.map((r) => ({ ...r, outstanding: BigInt(r.outstanding ?? 0) }));
}

export async function getVendor(id: number) {
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id));
  return row;
}

/**
 * Totals from the vendor's AP lines: billed = purchase bills, paid = vendor payments, outstanding = the AP balance
 * (+ = we owe them), last payment = the latest vendor payment still in force. Zero until T18 / T19 post.
 */
export async function vendorOverview(id: number) {
  const ap = await systemAccountId("ap");
  const [row] = await db.execute<{ billed: string; paid: string; outstanding: string; last: string | null }>(sql`
    select
      coalesce(sum(l.credit_paise - l.debit_paise) filter (where e.doc_type = 'purchase_bills'), 0) as billed,
      coalesce(sum(l.debit_paise - l.credit_paise) filter (where e.doc_type = 'vendor_payments'), 0) as paid,
      coalesce(sum(l.credit_paise - l.debit_paise), 0) as outstanding,
      max(e.date) filter (where e.doc_type = 'vendor_payments' and e.reverses_entry_id is null
        and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id)) as last
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    where l.account_id = ${ap} and l.vendor_id = ${id}`);
  return {
    billed: BigInt(row.billed),
    paid: BigInt(row.paid),
    outstanding: BigInt(row.outstanding),
    lastPaymentDate: row.last,
  };
}
