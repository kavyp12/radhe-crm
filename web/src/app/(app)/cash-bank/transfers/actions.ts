"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelTransfer, createTransfer, transferWarning, updateTransfer, type TransferInput } from "@/lib/transfers";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): TransferInput => ({
  date: text(form, "date"),
  fromAccountId: text(form, "fromAccountId"),
  toAccountId: text(form, "toAccountId"),
  amount: text(form, "amount"),
  reference: text(form, "reference"),
  notes: text(form, "notes"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createTransferAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "create");
  return formAction(async () => {
    const { id, message } = await createTransfer(actor, input(form));
    if (id !== null) redirect(`/cash-bank/transfers/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

export async function updateTransferAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "edit");
  checkId(id);
  const state = await formAction(() => updateTransfer(actor, id, input(form), text(form, "reason")));
  revalidatePath(`/cash-bank/transfers/${id}`);
  return state;
}

export async function cancelTransferAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "cancel");
  checkId(id);
  const state = await formAction(() => cancelTransfer(actor, id, text(form, "reason")));
  revalidatePath(`/cash-bank/transfers/${id}`);
  return state;
}

/** D55: the live "below zero that day" warning on the form (never a block). */
export async function transferWarningAction(date: string, fromAccountId: string, amount: string, exceptId?: number) {
  await requirePermission("books", "view");
  if (exceptId !== undefined) checkId(exceptId);
  return transferWarning({ date: String(date), fromAccountId: String(fromAccountId), amount: String(amount) }, exceptId);
}
