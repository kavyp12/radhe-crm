"use server";

import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { vendors } from "@/db/schema";
import { duplicateText, findDuplicates } from "@/lib/customers";
import { createVendor, updateVendor, type VendorInput } from "@/lib/vendors";

/** The form as typed. Opening balance / active only when the form showed them. */
function input(form: FormData): VendorInput {
  const text = (key: string) => String(form.get(key) ?? "");
  return {
    name: text("name"),
    gstin: text("gstin"),
    stateCode: text("stateCode"),
    mobile: text("mobile"),
    address: text("address"),
    creditDays: text("creditDays"),
    notes: text("notes"),
    openingBalance: form.has("openingBalance") ? text("openingBalance") : undefined,
    active: form.has("activeShown") ? form.get("active") === "on" : undefined,
  };
}

export async function createVendorAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("vendors", "create");
  return formAction(async () => {
    const id = await createVendor(actor, input(form));
    redirect(`/vendors/${id}`);
  });
}

export async function updateVendorAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("vendors", "edit");
  if (!Number.isSafeInteger(id)) throw new Error("Bad vendor id");
  return formAction(async () => {
    await updateVendor(actor, id, input(form));
    redirect(`/vendors/${id}`);
  });
}

/** The duplicate GSTIN / mobile warning (D46). exceptId = the vendor being edited. */
export async function vendorDuplicatesAction(exceptId: number | null, gstin: string, mobile: string) {
  await requirePermission("vendors", "view");
  const found = await findDuplicates(vendors, String(gstin), String(mobile), exceptId ?? undefined);
  return duplicateText(found, "vendor");
}
