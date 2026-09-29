"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelVendorPayment, createVendorPayment, openBills, updateVendorPayment, type VendorPaymentInput } from "@/lib/vendor-payments";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): VendorPaymentInput => ({
  vendorId: text(form, "vendorId"),
  date: text(form, "date"),
  amount: text(form, "amount"),
  mode: text(form, "mode"),
  moneyAccountId: text(form, "moneyAccountId"),
  reference: text(form, "reference"),
  chequeNo: text(form, "chequeNo"),
  chequeDate: text(form, "chequeDate"),
  notes: text(form, "notes"),
  allocations: text(form, "allocations"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

/** The allocation panel's rows: the vendor's open bills; `exceptPaymentId` = the payment being edited. */
export async function openBillsAction(vendorId: number, exceptPaymentId?: number) {
  await requirePermission("payments", "create");
  checkId(vendorId);
  if (exceptPaymentId !== undefined) checkId(exceptPaymentId);
  return openBills(db, vendorId, exceptPaymentId);
}

export async function createPaymentAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "create");
  return formAction(async () => {
    const { id, message } = await createVendorPayment(actor, input(form));
    if (id !== null) redirect(`/vendor-payments/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

export async function updatePaymentAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "edit");
  checkId(id);
  const state = await formAction(() => updateVendorPayment(actor, id, input(form), text(form, "reason")));
  revalidatePath(`/vendor-payments/${id}`);
  return state;
}

export async function cancelPaymentAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "cancel");
  checkId(id);
  const state = await formAction(() => cancelVendorPayment(actor, id, text(form, "reason")));
  revalidatePath(`/vendor-payments/${id}`);
  return state;
}
