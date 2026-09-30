"use server";

import { revalidatePath } from "next/cache";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { postCountDifference, saveCashCount } from "@/lib/cash-book";

/** Records a count for the day and account on screen (date as DD/MM/YYYY). */
export async function saveCountAction(accountId: number, date: string, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "create");
  if (!Number.isSafeInteger(accountId)) throw new Error("Bad id");
  const state = await formAction(() => saveCashCount(actor, { accountId: String(accountId), date: String(date), counted: String(form.get("counted") ?? "") }));
  revalidatePath("/cash-book");
  return state;
}

/** Posts a count's difference: the owner at once, anyone else through approval (D55). */
export async function postDifferenceAction(countId: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("books", "create");
  if (!Number.isSafeInteger(countId)) throw new Error("Bad id");
  const state = await formAction(() => postCountDifference(actor, countId, String(form.get("reason") ?? "")));
  revalidatePath("/cash-book");
  return state;
}
