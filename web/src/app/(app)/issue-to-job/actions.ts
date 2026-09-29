"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelStockIssue, createStockIssue, returnableItems } from "@/lib/stock-issues";

// Issue to job (T21): production, accountant and owner issue / return (production: qty only); owner / accountant cancel.

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function createIssueAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("stockIssue", "create");
  return formAction(async () => {
    const { id, message } = await createStockIssue(actor, {
      kind: text(form, "kind"),
      jobId: text(form, "jobId"),
      date: text(form, "date"),
      notes: text(form, "notes"),
      lines: text(form, "lines"),
    });
    if (id !== null) redirect(`/issue-to-job/${id}`);
    return { message }; // backdated, sent for approval: nothing saved yet
  });
}

/** The return form's items for a job: what it holds (issued less returned), qty only. */
export async function returnableAction(jobId: number) {
  await requirePermission("stockIssue", "create");
  if (!Number.isSafeInteger(jobId)) throw new Error("Bad id");
  return returnableItems(jobId);
}

export async function cancelIssueAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("stockIssue", "cancel");
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
  const state = await formAction(() => cancelStockIssue(actor, id, text(form, "reason")));
  revalidatePath(`/issue-to-job/${id}`);
  return state;
}
