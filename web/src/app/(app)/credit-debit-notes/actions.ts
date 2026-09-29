"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelNote, createNote, getNote, issueNote, NOTE_KIND, updateNote, type NoteInput, type NoteKind } from "@/lib/notes";
import { notePdf } from "@/lib/pdf";
import { readMail, sendPdfMail } from "@/lib/share";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): NoteInput => ({
  date: text(form, "date"),
  reason: text(form, "reason"),
  notes: text(form, "notes"),
  lines: text(form, "lines"),
});

function check(kind: NoteKind, id: number) {
  if (kind !== "credit" && kind !== "debit") throw new Error("Bad note kind");
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
}
const detail = (kind: NoteKind, id: number) => `/credit-debit-notes/${NOTE_KIND[kind].path}/${id}`;

export async function createNoteAction(kind: NoteKind, invoiceId: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "create");
  check(kind, invoiceId);
  return formAction(async () => {
    const id = await createNote(actor, kind, invoiceId, input(form));
    redirect(detail(kind, id));
  });
}

export async function updateNoteAction(kind: NoteKind, id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "edit");
  check(kind, id);
  return formAction(async () => {
    await updateNote(actor, kind, id, input(form));
    redirect(detail(kind, id));
  });
}

export async function issueNoteAction(kind: NoteKind, id: number): Promise<FormState> {
  const actor = await requirePermission("invoices", "edit");
  check(kind, id);
  const state = await formAction(() => issueNote(actor, kind, id));
  revalidatePath(detail(kind, id));
  return state;
}

export async function cancelNoteAction(kind: NoteKind, id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("invoices", "cancel");
  check(kind, id);
  const state = await formAction(() => cancelNote(actor, kind, id, text(form, "reason")));
  revalidatePath(detail(kind, id));
  return state;
}

/** Email the PDF (D07), once issued. */
export async function emailNoteAction(kind: NoteKind, id: number, _: FormState, form: FormData): Promise<FormState> {
  await requirePermission("invoices", "view");
  check(kind, id);
  return formAction(async () => {
    const note = await getNote(kind, id);
    if (!note) throw new UserError("That note doesn't exist.");
    if (note.status === "draft") throw new UserError("Issue the note first: drafts aren't shared.");
    const pdf = (await notePdf(kind, id))!;
    await sendPdfMail({ ...readMail(form), fileName: pdf.fileName, pdf: pdf.bytes });
  });
}
