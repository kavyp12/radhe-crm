"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import {
  cancelInvoice,
  createInvoice,
  createInvoiceFromJobs,
  createInvoiceFromQuotation,
  getInvoice,
  issueInvoice,
  updateInvoice,
  type InvoiceInput,
} from "@/lib/invoices";
import { invoicePdf } from "@/lib/pdf";
import { readMail, sendPdfMail } from "@/lib/share";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): InvoiceInput => ({
  kind: text(form, "kind"),
  customerId: text(form, "customerId"),
  date: text(form, "date"),
  terms: text(form, "terms"),
  notes: text(form, "notes"),
  lines: text(form, "lines"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createInvoiceAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  return formAction(async () => {
    const id = await createInvoice(actor, input(form));
    redirect(`/invoices/${id}`);
  });
}

/** From the "Bill jobs" page (checked jobs) or a job page (one job). */
export async function invoiceJobsAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  const jobIds = form.getAll("jobId").map(Number);
  if (!jobIds.every(Number.isSafeInteger)) throw new Error("Bad job id");
  return formAction(async () => {
    const id = await createInvoiceFromJobs(actor, jobIds, text(form, "kind") || "tax");
    redirect(`/invoices/${id}`);
  });
}

export async function invoiceQuotationAction(quotationId: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  checkId(quotationId);
  return formAction(async () => {
    const id = await createInvoiceFromQuotation(actor, quotationId, text(form, "kind") || "tax");
    redirect(`/invoices/${id}`);
  });
}

export async function updateInvoiceAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "edit");
  checkId(id);
  return formAction(async () => {
    await updateInvoice(actor, id, input(form));
    redirect(`/invoices/${id}`);
  });
}

export async function issueInvoiceAction(id: number): Promise<FormState> {
  const actor = await requirePermission("invoices", "edit");
  checkId(id);
  const state = await formAction(() => issueInvoice(actor, id));
  revalidatePath(`/invoices/${id}`);
  return state;
}

export async function cancelInvoiceAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "cancel");
  checkId(id);
  const state = await formAction(() => cancelInvoice(actor, id, text(form, "reason")));
  revalidatePath(`/invoices/${id}`);
  return state;
}

/** Email the PDF (D07), only once issued. */
export async function emailInvoiceAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  await requirePermission("invoices", "view");
  checkId(id);
  return formAction(async () => {
    const inv = await getInvoice(id);
    if (!inv) throw new UserError("That invoice doesn't exist.");
    if (inv.status === "draft") throw new UserError("Issue the invoice first: drafts aren't shared.");
    const mail = readMail(form);
    const pdf = (await invoicePdf(id))!;
    await sendPdfMail({ ...mail, fileName: pdf.fileName, pdf: pdf.bytes });
  });
}

/** "Create invoice" on a job page. */
export async function invoiceJobAction(jobId: number): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  checkId(jobId);
  return formAction(async () => {
    const id = await createInvoiceFromJobs(actor, [jobId], "tax");
    redirect(`/invoices/${id}`);
  });
}
