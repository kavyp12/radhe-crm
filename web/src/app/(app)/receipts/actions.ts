"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { openInvoices, openJobs } from "@/lib/allocations";
import { requirePermission } from "@/lib/auth";
import { JOB_STATUS } from "@/lib/jobs";
import { db } from "@/db";
import { cancelReceipt, createReceipt, updateReceipt, type ReceiptInput } from "@/lib/receipts";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): ReceiptInput => ({
  customerId: text(form, "customerId"),
  date: text(form, "date"),
  amount: text(form, "amount"),
  mode: text(form, "mode"),
  moneyAccountId: text(form, "moneyAccountId"),
  reference: text(form, "reference"),
  chequeNo: text(form, "chequeNo"),
  chequeDate: text(form, "chequeDate"),
  receivedBy: text(form, "receivedBy"),
  notes: text(form, "notes"),
  allocations: text(form, "allocations"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

/** The allocation panel's rows for a customer: open invoices and jobs; `exceptReceiptId` = the receipt being edited. */
export async function openItemsAction(customerId: number, exceptReceiptId?: number) {
  await requirePermission("payments", "create");
  checkId(customerId);
  if (exceptReceiptId !== undefined) checkId(exceptReceiptId);
  const [invoices, jobs] = await Promise.all([
    openInvoices(db, customerId, exceptReceiptId),
    openJobs(db, customerId, exceptReceiptId),
  ]);
  return { invoices, jobs: jobs.map((j) => ({ ...j, status: JOB_STATUS[j.status] })) };
}

export async function createReceiptAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "create");
  return formAction(async () => {
    const { id, message } = await createReceipt(actor, input(form));
    if (id !== null) redirect(`/receipts/${id}`);
    return { message }; // sent for approval: nothing saved yet
  });
}

export async function updateReceiptAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "edit");
  checkId(id);
  const state = await formAction(() => updateReceipt(actor, id, input(form), text(form, "reason")));
  revalidatePath(`/receipts/${id}`);
  return state;
}

export async function cancelReceiptAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "cancel");
  checkId(id);
  const state = await formAction(() => cancelReceipt(actor, id, text(form, "reason")));
  revalidatePath(`/receipts/${id}`);
  return state;
}
