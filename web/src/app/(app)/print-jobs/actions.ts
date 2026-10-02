"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { createInvoicesFromPrintJobs } from "@/lib/invoices";
import {
  cancelPrintJob,
  createPrintJob,
  saveMachine,
  savePrintingType,
  updatePrintJob,
  type PrintJobEdit,
  type PrintJobInput,
} from "@/lib/print-jobs";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

const edit = (form: FormData): PrintJobEdit => ({
  customerId: text(form, "customerId"),
  jobId: text(form, "jobId"),
  fileName: text(form, "fileName"),
  filePath: text(form, "filePath"),
  machineId: text(form, "machineId"),
  printingTypeId: text(form, "printingTypeId"),
  width: text(form, "width"),
  height: text(form, "height"),
  qty: text(form, "qty"),
  rate: text(form, "rate"),
  notes: text(form, "notes"),
});

const input = (form: FormData): PrintJobInput => ({
  ...edit(form),
  newCustomerName: text(form, "newCustomerName"),
  newCustomerMobile: text(form, "newCustomerMobile"),
  payment: text(form, "payment"),
  received: text(form, "received"),
  receiptMode: text(form, "receiptMode"),
  reprintOfId: text(form, "reprintOfId"),
});

export async function createPrintJobAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("printJobs", "create");
  return formAction(async () => {
    const { id, message } = await createPrintJob(actor, { ...input(form), date: text(form, "date"), time: text(form, "time") });
    if (id !== null) redirect(`/print-jobs/${id}`);
    return { message }; // sent for approval: nothing saved yet
  });
}

export async function updatePrintJobAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("printJobs", "edit");
  checkId(id);
  const state = await formAction(() => updatePrintJob(actor, id, edit(form)));
  revalidatePath(`/print-jobs/${id}`);
  return state;
}

export async function cancelPrintJobAction(id: number): Promise<FormState> {
  const actor = await requirePermission("printJobs", "cancel");
  checkId(id);
  const state = await formAction(() => cancelPrintJob(actor, id));
  revalidatePath(`/print-jobs/${id}`);
  return state;
}

/** "Bill selected print jobs" (D64): one draft per customer; one draft opens, several land on the invoice list. */
export async function billPrintJobsAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  const ids = form.getAll("printJobId").map(Number);
  if (!ids.every(Number.isSafeInteger)) throw new Error("Bad print job id");
  return formAction(async () => {
    if (!ids.length) throw new UserError("Tick the print jobs to bill.");
    const made = await createInvoicesFromPrintJobs(actor, ids, text(form, "kind") || "tax", text(form, "categoryId"));
    redirect(made.length === 1 ? `/invoices/${made[0]}` : "/invoices");
  });
}

/** The hidden "id" field: blank = new. */
function idOf(form: FormData): number | null {
  const raw = text(form, "id");
  if (!raw) return null;
  const id = Number(raw);
  checkId(id);
  return id;
}
const active = (form: FormData) => !form.has("activeShown") || form.get("active") === "on";

export async function saveMachineAction(_: FormState, form: FormData): Promise<FormState> {
  const id = idOf(form);
  const actor = await requirePermission("printJobs", id === null ? "create" : "edit");
  return formAction(async () => {
    await saveMachine(actor, id, {
      name: text(form, "name"),
      printerNames: text(form, "printerNames"),
      saleRate: text(form, "saleRate"),
      costRate: text(form, "costRate"),
      active: active(form),
    });
    revalidatePath("/print-jobs/setup");
  });
}

export async function savePrintingTypeAction(_: FormState, form: FormData): Promise<FormState> {
  const id = idOf(form);
  const actor = await requirePermission("printJobs", id === null ? "create" : "edit");
  return formAction(async () => {
    await savePrintingType(actor, id, { name: text(form, "name"), categoryId: text(form, "categoryId"), active: active(form) });
    revalidatePath("/print-jobs/setup");
  });
}
