"use server";

import { revalidatePath } from "next/cache";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { setSettingsImage, updateSettings } from "@/lib/settings";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function saveSettingsAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("settings", "edit");
  return formAction(async () => {
    await updateSettings(actor, {
      companyName: text(form, "companyName"),
      address: text(form, "address"),
      gstin: text(form, "gstin"),
      stateCode: text(form, "stateCode"),
      phone: text(form, "phone"),
      email: text(form, "email"),
      bankDetails: text(form, "bankDetails"),
      upiId: text(form, "upiId"),
      invoiceTerms: text(form, "invoiceTerms"),
      discountLimit: text(form, "discountLimit"),
      backdateDays: text(form, "backdateDays"),
      defaultCreditDays: text(form, "defaultCreditDays"),
    });
    revalidatePath("/settings");
  });
}

export async function setImageAction(image: "logo" | "signature", attachmentId: number | null) {
  const actor = await requirePermission("settings", "edit");
  if (image !== "logo" && image !== "signature") throw new Error("Unknown image");
  if (attachmentId !== null && !Number.isSafeInteger(attachmentId)) throw new Error("Bad attachment id");
  const state = await formAction(() => setSettingsImage(actor, image, attachmentId));
  revalidatePath("/settings");
  return { error: state?.error };
}
