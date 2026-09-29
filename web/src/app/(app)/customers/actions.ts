"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { applyOnAccount } from "@/lib/allocations";
import { requirePermission } from "@/lib/auth";
import { customers } from "@/db/schema";
import {
  createCustomer,
  duplicateText,
  findDuplicates,
  getCustomer,
  updateCustomer,
  type CustomerInput,
} from "@/lib/customers";
import { statementPdf } from "@/lib/pdf";
import { getSettings } from "@/lib/settings";
import { readMail, sendPdfMail, shareUrl, whatsappLink } from "@/lib/share";
import { createStatementLink, customerLedger, readRange, statementMessage } from "@/lib/statements";

/** The form as typed. Opening balance / active only when the form showed them (owner / accountant). */
function input(form: FormData): CustomerInput {
  const text = (key: string) => String(form.get(key) ?? "");
  return {
    name: text("name"),
    firmName: text("firmName"),
    mobile: text("mobile"),
    email: text("email"),
    gstin: text("gstin"),
    stateCode: text("stateCode"),
    billingAddress: text("billingAddress"),
    siteAddress: text("siteAddress"),
    creditLimit: text("creditLimit"),
    creditDays: text("creditDays"),
    isCreditCustomer: form.get("isCreditCustomer") === "on",
    salesPersonId: text("salesPersonId"),
    collectionPersonId: text("collectionPersonId"),
    notes: text("notes"),
    openingBalance: form.has("openingBalance") ? text("openingBalance") : undefined,
    active: form.has("activeShown") ? form.get("active") === "on" : undefined,
  };
}

export async function createCustomerAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("customers", "create");
  return formAction(async () => {
    const id = await createCustomer(actor, input(form));
    redirect(`/customers/${id}`);
  });
}

export async function updateCustomerAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("customers", "edit");
  if (!Number.isSafeInteger(id)) throw new Error("Bad customer id");
  return formAction(async () => {
    await updateCustomer(actor, id, input(form));
    redirect(`/customers/${id}`);
  });
}

/** The duplicate GSTIN / mobile warning (D46). exceptId = the customer being edited. */
export async function customerDuplicatesAction(exceptId: number | null, gstin: string, mobile: string) {
  await requirePermission("customers", "view");
  const found = await findDuplicates(customers, String(gstin), String(mobile), exceptId ?? undefined);
  return duplicateText(found, "customer");
}

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad customer id");
};

/** WhatsApp a statement (D49): a new public link for customer + range, wrapped in a wa.me link with the message. */
export async function statementShareAction(customerId: number, period: string, from: string, to: string) {
  const actor = await requirePermission("customers", "money");
  checkId(customerId);
  const { range, error } = readRange(period, from, to);
  if (error) return { error };
  const c = await getCustomer(customerId);
  if (!c) return { error: "That customer doesn't exist." };
  const [token, { closing }, { companyName }] = await Promise.all([
    createStatementLink(actor, customerId, range),
    customerLedger(customerId, range),
    getSettings(),
  ]);
  const link = shareUrl(token);
  return { url: whatsappLink(c.mobile, statementMessage({ name: c.name, range, closing, link, company: companyName })), link };
}

/** Email the statement PDF. */
export async function emailStatementAction(
  customerId: number,
  period: string,
  from: string,
  to: string,
  _: FormState,
  form: FormData,
): Promise<FormState> {
  await requirePermission("customers", "money");
  checkId(customerId);
  return formAction(async () => {
    const { range, error } = readRange(period, from, to);
    if (error) throw new UserError(error);
    const pdf = await statementPdf(customerId, range);
    if (!pdf) throw new UserError("That customer doesn't exist.");
    await sendPdfMail({ ...readMail(form), fileName: pdf.fileName, pdf: pdf.bytes });
  });
}

/** D50: apply a receipt's rest / a credit note's leftover credit to open invoices, debit notes or jobs. */
export async function applyOnAccountAction(
  customerId: number,
  kind: "receipt" | "credit_note",
  sourceId: number,
  _: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await requirePermission("payments", "create");
  checkId(customerId);
  checkId(sourceId);
  if (kind !== "receipt" && kind !== "credit_note") throw new Error("Bad source");
  const state = await formAction(() =>
    applyOnAccount(actor, customerId, { kind, id: sourceId }, String(form.get("allocations") ?? "")),
  );
  revalidatePath(`/customers/${customerId}`);
  return state;
}
