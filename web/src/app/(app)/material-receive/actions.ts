"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requireCostPermission } from "@/lib/auth";
import { cancelReceipt, createReceipt } from "@/lib/goods-receipts";

// GRNs carry PO rates: every action needs goodsReceipts + can_view_cost (D36, D53).

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function createReceiptAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("goodsReceipts", "create");
  return formAction(async () => {
    const { id, message } = await createReceipt(actor, {
      orderId: text(form, "orderId"),
      date: text(form, "date"),
      notes: text(form, "notes"),
      lines: text(form, "lines"),
    });
    if (id !== null) redirect(`/material-receive/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

export async function cancelReceiptAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("goodsReceipts", "cancel");
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
  const state = await formAction(() => cancelReceipt(actor, id, text(form, "reason")));
  revalidatePath(`/material-receive/${id}`);
  return state;
}
