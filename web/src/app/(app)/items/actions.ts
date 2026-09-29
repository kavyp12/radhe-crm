"use server";

import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { createItem, updateItem, type ItemInput } from "@/lib/stock";

/** The form as typed. Opening stock / active only when the form showed them. */
function input(form: FormData): ItemInput {
  const text = (key: string) => String(form.get(key) ?? "");
  return {
    name: text("name"),
    unit: text("unit"),
    categoryId: text("categoryId"),
    hsnSac: text("hsnSac"),
    gstPercent: text("gstPercent"),
    openingQty: form.has("openingQty") ? text("openingQty") : undefined,
    openingRate: form.has("openingRate") ? text("openingRate") : undefined,
    active: form.has("activeShown") ? form.get("active") === "on" : undefined,
  };
}

export async function createItemAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("stockItems", "create");
  return formAction(async () => {
    const id = await createItem(actor, input(form));
    redirect(`/items/${id}`);
  });
}

export async function updateItemAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("stockItems", "edit");
  if (!Number.isSafeInteger(id)) throw new Error("Bad item id");
  return formAction(async () => {
    await updateItem(actor, id, input(form));
    redirect(`/items/${id}`);
  });
}
