"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { cancelRequest, createRequest, decideRequest } from "@/lib/material-requests";

// Material requests (T22): production, accountant and owner ask; only the owner decides; the maker cancels while pending.

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createRequestAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("materialRequests", "create");
  return formAction(async () => {
    const { id } = await createRequest(actor, {
      neededBy: text(form, "neededBy"),
      jobId: text(form, "jobId"),
      notes: text(form, "notes"),
      lines: text(form, "lines"),
    });
    revalidatePath("/", "layout"); // the owner's bell
    redirect(`/material-requests/${id}`);
  });
}

export async function decideRequestAction(id: number, decision: "approve" | "reject", _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("materialRequests", "approve");
  checkId(id);
  if (decision !== "approve" && decision !== "reject") throw new Error("Unknown decision");
  const state = await formAction(() => decideRequest(actor, id, decision, text(form, "note")));
  revalidatePath("/", "layout"); // the bell and the sidebar count
  return state;
}

export async function cancelRequestAction(id: number): Promise<FormState> {
  const actor = await requirePermission("materialRequests", "create");
  checkId(id);
  const state = await formAction(() => cancelRequest(actor, id));
  revalidatePath("/", "layout");
  return state;
}
