"use server";

import { revalidatePath } from "next/cache";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { createFollowUp } from "@/lib/follow-ups";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function createFollowUpAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("followUps", "create");
  const state = await formAction(() =>
    createFollowUp(actor, {
      customerId: text(form, "customerId"),
      invoiceId: text(form, "invoiceId"),
      followUpDate: text(form, "followUpDate"),
      personId: text(form, "personId"),
      response: text(form, "response"),
      promiseDate: text(form, "promiseDate"),
      expected: text(form, "expected"),
      nextReminderDate: text(form, "nextReminderDate"),
    }),
  );
  revalidatePath("/", "layout"); // the Follow-ups badge and the bell
  return state;
}
