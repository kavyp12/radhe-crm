"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requireCostPermission } from "@/lib/auth";
import { cancelPurchaseBill, createPurchaseBill, updatePurchaseBill, type BillInput } from "@/lib/purchase-bills";

// Purchase bills show purchase rates: every action needs books + can_view_cost (D51).

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): BillInput => ({
  vendorId: text(form, "vendorId"),
  vendorBillNo: text(form, "vendorBillNo"),
  date: text(form, "date"),
  roundOff: text(form, "roundOff"),
  notes: text(form, "notes"),
  lines: text(form, "lines"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createBillAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("books", "create");
  return formAction(async () => {
    const { id, message } = await createPurchaseBill(actor, input(form));
    if (id !== null) redirect(`/purchase-bills/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

export async function updateBillAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("books", "edit");
  checkId(id);
  const state = await formAction(() => updatePurchaseBill(actor, id, input(form), text(form, "reason")));
  revalidatePath(`/purchase-bills/${id}`);
  return state;
}

export async function cancelBillAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("books", "cancel");
  checkId(id);
  const state = await formAction(() => cancelPurchaseBill(actor, id, text(form, "reason")));
  revalidatePath(`/purchase-bills/${id}`);
  return state;
}
