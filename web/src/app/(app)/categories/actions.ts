"use server";

import { revalidatePath } from "next/cache";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { saveExpenseCategory, saveProductCategory } from "@/lib/categories";

/** The hidden "id" field: blank = a new category. */
function idOf(form: FormData): number | null {
  const raw = String(form.get("id") ?? "");
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error("Bad category id");
  return id;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const active = (form: FormData) => !form.has("activeShown") || form.get("active") === "on";

export async function saveProductCategoryAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("categories", "edit");
  const id = idOf(form);
  return formAction(async () => {
    await saveProductCategory(actor, id, {
      name: text(form, "name"),
      hsnSac: text(form, "hsnSac"),
      gstPercent: text(form, "gstPercent"),
      active: active(form),
    });
    revalidatePath("/categories");
  });
}

export async function saveExpenseCategoryAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("categories", "edit");
  const id = idOf(form);
  return formAction(async () => {
    await saveExpenseCategory(actor, id, { name: text(form, "name"), costBucket: text(form, "costBucket"), active: active(form) });
    revalidatePath("/categories");
  });
}
