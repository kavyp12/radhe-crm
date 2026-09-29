"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelExpense, createExpense, updateExpense, type ExpenseInput } from "@/lib/expenses";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): ExpenseInput => ({
  date: text(form, "date"),
  categoryId: text(form, "categoryId"),
  vendorId: text(form, "vendorId"),
  jobId: text(form, "jobId"),
  amount: text(form, "amount"),
  mode: text(form, "mode"),
  moneyAccountId: text(form, "moneyAccountId"),
  notes: text(form, "notes"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createExpenseAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "create");
  return formAction(async () => {
    const { id, message } = await createExpense(actor, input(form));
    if (id !== null) redirect(`/expenses/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

export async function updateExpenseAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "edit");
  checkId(id);
  const state = await formAction(() => updateExpense(actor, id, input(form), text(form, "reason")));
  revalidatePath(`/expenses/${id}`);
  return state;
}

export async function cancelExpenseAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "cancel");
  checkId(id);
  const state = await formAction(() => cancelExpense(actor, id, text(form, "reason")));
  revalidatePath(`/expenses/${id}`);
  return state;
}
