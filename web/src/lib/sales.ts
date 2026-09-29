import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { customers, invoiceLines, invoices, productCategories, quotationLines, settings } from "@/db/schema";
import { UserError } from "@/lib/action";
import { discountNeedsApproval, needsBackdateApproval } from "@/lib/approvals";
import { addDays, formatDate, parseDate } from "@/lib/dates";
import { LINE_KEYS, readLine, type Line, type LineText } from "@/lib/lines";
import { divRound, formatMoney } from "@/lib/num";

// Server helpers shared by quotations, jobs and invoices (A§2, A§4, A§7, D44).

/** A line ready to save: HSN/SAC and GST % filled from the category where left blank. */
export type SavedLine = Line & { gstBp: number };

/** Public share-link token (D07, D46): 32 random bytes. */
export const newShareToken = () => randomBytes(32).toString("base64url");

export function readDate(input: string): string {
  try {
    return parseDate(input);
  } catch {
    throw new UserError("Use DD/MM/YYYY, e.g. 28/09/2026.", "date");
  }
}

/** The form's lines (JSON of LineText) → lines to save. Throws a UserError naming the line. */
export async function readLines(tx: Tx, json: string): Promise<SavedLine[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) throw new UserError("The lines couldn't be read: reload the page.", "lines");
  if (!raw.length) throw new UserError("Add at least one line.", "lines");
  if (raw.length > 200) throw new UserError("A document can have 200 lines at most.", "lines");
  const lines = raw.map((row, i) => {
    const o = (row ?? {}) as Record<string, unknown>;
    const text = Object.fromEntries(LINE_KEYS.map((k) => [k, typeof o[k] === "string" ? o[k] : ""])) as LineText;
    return readLine(text, i + 1);
  });

  const ids = [...new Set(lines.map((l) => l.categoryId))];
  const found = await tx.select().from(productCategories).where(inArray(productCategories.id, ids));
  return lines.map((l, i) => {
    const category = found.find((c) => c.id === l.categoryId);
    if (!category) throw new UserError(`Line ${i + 1}: pick a category.`, "lines");
    return { ...l, hsnSac: l.hsnSac ?? category.hsnSac, gstBp: l.gstBp ?? category.gstBp };
  });
}

/** The line columns every lines table shares, from a line being saved or a saved line being copied (R0). */
export const lineRow = (l: Omit<SavedLine, "lineId">, index: number) => ({
  position: index + 1,
  categoryId: l.categoryId,
  description: l.description,
  hsnSac: l.hsnSac,
  widthMilli: l.widthMilli,
  heightMilli: l.heightMilli,
  qtyMilli: l.qtyMilli,
  unit: l.unit,
  ratePaise: l.ratePaise,
  discountPaise: l.discountPaise,
  gstBp: l.gstBp,
});

/** The customer a new or edited document is for. New documents need an active customer. */
export async function customerFor(tx: Tx, input: string, isNew: boolean) {
  const id = Number(input);
  const [c] = Number.isSafeInteger(id) ? await tx.select().from(customers).where(eq(customers.id, id)) : [];
  if (!c) throw new UserError("Pick the customer.", "customerId");
  if (isNew && !c.active) throw new UserError("This customer is inactive.", "customerId");
  return c;
}

/** A document date + the customer's credit days (Settings default when blank; none = due the same day). */
export async function dueDateFor(tx: Tx, date: string, creditDays: number | null) {
  const [s] = await tx.select({ days: settings.defaultCreditDays }).from(settings).where(eq(settings.id, 1));
  return addDays(date, creditDays ?? s.days ?? 0);
}

/** The company's own state code (Settings), for CGST + SGST vs IGST (A§4). */
export async function companyState(q: Tx | typeof db): Promise<string> {
  const [s] = await q.select({ stateCode: settings.stateCode }).from(settings).where(eq(settings.id, 1));
  return s.stateCode;
}

/**
 * Why a document leaving Draft needs the owner's approval when someone else does it (A§7, D44): a line discount
 * over the limit, or a date before the backdate window. Empty = no approval needed.
 */
export async function approvalReasons(
  lines: { qtyMilli: bigint; ratePaise: bigint; discountPaise: bigint }[],
  date: string,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const [i, l] of lines.entries()) {
    const amount = divRound(l.qtyMilli * l.ratePaise, 1000n);
    if (l.discountPaise > 0n && (await discountNeedsApproval(l.discountPaise, amount))) {
      reasons.push(`Line ${i + 1}: discount ${formatMoney(l.discountPaise)} on ${formatMoney(amount)} is over the limit`);
    }
  }
  if (await needsBackdateApproval(date)) reasons.push(`Dated ${formatDate(date)}, before the backdate window`);
  return reasons;
}

/** A request is for the document as it was (D44): refuse it if the document changed since. */
export function checkVersion(doc: { updatedAt: Date }, version: string, what: string) {
  if (doc.updatedAt.toISOString() !== version) {
    throw new UserError(`This ${what} was changed after the request was made. Ask again for the current version.`);
  }
}

/** Pick lists for a sales form: active customers and categories, plus the ones this document already uses. */
export async function salesFormOptions(keep: { customerId?: number; categoryIds?: number[] } = {}) {
  const [allCustomers, allCategories, state] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        firmName: customers.firmName,
        stateCode: customers.stateCode,
        active: customers.active,
      })
      .from(customers)
      .orderBy(asc(customers.name)),
    db.select().from(productCategories).orderBy(asc(productCategories.id)),
    companyState(db),
  ]);
  return {
    customers: allCustomers
      .filter((c) => c.active || c.id === keep.customerId)
      .map((c) => ({ id: c.id, name: c.name, firmName: c.firmName, stateCode: c.stateCode })),
    categories: allCategories
      .filter((c) => c.active || keep.categoryIds?.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, hsnSac: c.hsnSac, gstBp: c.gstBp })),
    companyState: state,
  };
}

/** The live (not cancelled) invoice a quotation's lines are on, if any. */
export async function quotationInvoice(q: Tx | typeof db, quotationId: number) {
  const [row] = await q
    .select({ id: invoices.id, number: invoices.number })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .innerJoin(quotationLines, eq(quotationLines.id, invoiceLines.quotationLineId))
    .where(and(eq(quotationLines.quotationId, quotationId), ne(invoices.status, "cancelled")))
    .limit(1);
  return row;
}

/** Of these jobs, the ones already on a live invoice (other than `exceptInvoiceId`), with that invoice. */
export async function jobsOnInvoices(q: Tx | typeof db, jobIds: number[], exceptInvoiceId?: number) {
  if (!jobIds.length) return [];
  return q
    .selectDistinct({ jobId: invoiceLines.jobId, invoiceId: invoices.id, number: invoices.number })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        inArray(invoiceLines.jobId, jobIds),
        ne(invoices.status, "cancelled"),
        exceptInvoiceId ? ne(invoices.id, exceptInvoiceId) : undefined,
      ),
    );
}
