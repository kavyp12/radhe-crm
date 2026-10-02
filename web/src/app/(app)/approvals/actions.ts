"use server";

import { revalidatePath } from "next/cache";
import { formAction, type FormState } from "@/lib/action";
import { approve, reject } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";

// Modules that register approval executors (registerExecutor) are imported here, so approving can find them.
import "@/lib/adjustments";
import "@/lib/cash-book";
import "@/lib/expenses";
import "@/lib/goods-receipts";
import "@/lib/invoices";
import "@/lib/notes";
import "@/lib/print-jobs";
import "@/lib/purchase-bills";
import "@/lib/quotations";
import "@/lib/receipts";
import "@/lib/stock";
import "@/lib/stock-issues";
import "@/lib/transfers";
import "@/lib/vendor-payments";

export async function decideAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const owner = await requirePermission("approvals", "approve");
  if (!Number.isSafeInteger(id)) throw new Error("Bad request id");
  const decision = form.get("decision");
  const note = String(form.get("note") ?? "");
  return formAction(async () => {
    if (decision === "approve") await approve(owner, id, note);
    else if (decision === "reject") await reject(owner, id, note);
    else throw new Error("Unknown decision");
    revalidatePath("/", "layout"); // the bell and the sidebar count
    return { message: decision === "approve" ? "Approved. The change is done." : "Rejected. Nothing was changed." };
  });
}
