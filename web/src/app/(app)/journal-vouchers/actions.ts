"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { cancelAdjustment, createAdjustment, type AdjustmentInput } from "@/lib/adjustments";
import { requirePermission } from "@/lib/auth";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): AdjustmentInput => ({
  kind: text(form, "kind"),
  date: text(form, "date"),
  narration: text(form, "narration"),
  lines: text(form, "lines"),
  customerId: text(form, "customerId"),
  amount: text(form, "amount"),
  moneyAccountId: text(form, "moneyAccountId"),
  allocations: text(form, "allocations"),
});

/** A JV or a customer adjustment (write-off, discount, refund): the owner's is saved, anyone else's goes for approval. */
export async function createAdjustmentAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "create");
  return formAction(async () => {
    const { id, message } = await createAdjustment(actor, input(form));
    if (id !== null) redirect(`/journal-vouchers/${id}`);
    return { message }; // sent for approval: nothing saved yet
  });
}

export async function cancelAdjustmentAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "cancel");
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
  const state = await formAction(() => cancelAdjustment(actor, id, text(form, "reason")));
  revalidatePath(`/journal-vouchers/${id}`);
  return state;
}
