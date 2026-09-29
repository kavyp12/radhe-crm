"use server";

import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { createStockAdjustment } from "@/lib/stock";

// Stock adjustments: the owner adjusts at once; the accountant's "request" (A§8) becomes an approval request (A§7).
export async function createAdjustmentAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("stockAdjustment", "create");
  const text = (key: string) => String(form.get(key) ?? "");
  return formAction(async () => {
    const { id, message } = await createStockAdjustment(actor, {
      itemId: text("itemId"),
      date: text("date"),
      qty: text("qty"),
      rate: text("rate"),
      reason: text("reason"),
    });
    if (id !== null) redirect("/stock-adjustments");
    return { message }; // sent for approval: nothing saved yet
  });
}
