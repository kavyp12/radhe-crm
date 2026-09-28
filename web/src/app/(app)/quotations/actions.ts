"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { quotationPdf } from "@/lib/pdf";
import {
  approveQuotation,
  cancelQuotation,
  createQuotation,
  duplicateQuotation,
  getQuotation,
  sendQuotation,
  updateQuotation,
  type QuotationInput,
} from "@/lib/quotations";
import { readMail, sendPdfMail } from "@/lib/share";

const input = (form: FormData): QuotationInput => {
  const text = (key: string) => String(form.get(key) ?? "");
  return { customerId: text("customerId"), date: text("date"), terms: text("terms"), notes: text("notes"), lines: text("lines") };
};

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad quotation id");
};

export async function createQuotationAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("quotations", "create");
  return formAction(async () => {
    const id = await createQuotation(actor, input(form));
    redirect(`/quotations/${id}`);
  });
}

export async function updateQuotationAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("quotations", "edit");
  checkId(id);
  return formAction(async () => {
    await updateQuotation(actor, id, input(form));
    redirect(`/quotations/${id}`);
  });
}

export async function sendQuotationAction(id: number): Promise<FormState> {
  const actor = await requirePermission("quotations", "edit");
  checkId(id);
  const state = await formAction(() => sendQuotation(actor, id));
  revalidatePath(`/quotations/${id}`);
  return state;
}

export async function approveQuotationAction(id: number): Promise<FormState> {
  const actor = await requirePermission("quotations", "edit");
  checkId(id);
  const state = await formAction(() => approveQuotation(actor, id));
  revalidatePath(`/quotations/${id}`);
  return state;
}

export async function cancelQuotationAction(id: number): Promise<FormState> {
  const actor = await requirePermission("quotations", "cancel");
  checkId(id);
  const state = await formAction(() => cancelQuotation(actor, id));
  revalidatePath(`/quotations/${id}`);
  return state;
}

export async function duplicateQuotationAction(id: number): Promise<FormState> {
  const actor = await requirePermission("quotations", "create");
  checkId(id);
  return formAction(async () => {
    const copy = await duplicateQuotation(actor, id);
    redirect(`/quotations/${copy}/edit`);
  });
}

/** Email the PDF (D07), only once the quotation has left Draft. */
export async function emailQuotationAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  await requirePermission("quotations", "view");
  checkId(id);
  return formAction(async () => {
    const q = await getQuotation(id);
    if (!q) throw new UserError("That quotation doesn't exist.");
    if (q.status === "draft") throw new UserError("Send the quotation first: drafts aren't shared.");
    const mail = readMail(form);
    const pdf = (await quotationPdf(id))!;
    await sendPdfMail({ ...mail, fileName: pdf.fileName, pdf: pdf.bytes });
  });
}
