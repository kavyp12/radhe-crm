"use server";

import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { customers } from "@/db/schema";
import { createCustomer, duplicateText, findDuplicates, updateCustomer, type CustomerInput } from "@/lib/customers";

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
