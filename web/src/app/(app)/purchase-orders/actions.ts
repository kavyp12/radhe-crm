"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requireCostPermission } from "@/lib/auth";
import { purchaseOrderPdf } from "@/lib/pdf";
import { cancelOrder, createOrder, getOrder, markOrderSent, updateOrder, type OrderInput } from "@/lib/purchase-orders";
import { readMail, sendPdfMail } from "@/lib/share";

// Purchase orders show purchase rates: every action needs purchaseOrders + can_view_cost (D36, D53).

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const input = (form: FormData): OrderInput => ({
  vendorId: text(form, "vendorId"),
  date: text(form, "date"),
  notes: text(form, "notes"),
  lines: text(form, "lines"),
});
const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

export async function createOrderAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("purchaseOrders", "create");
  return formAction(async () => {
    const { id } = await createOrder(actor, input(form));
    redirect(`/purchase-orders/${id}`);
  });
}

export async function updateOrderAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("purchaseOrders", "edit");
  checkId(id);
  return formAction(async () => {
    await updateOrder(actor, id, input(form));
    redirect(`/purchase-orders/${id}`);
  });
}

export async function sendOrderAction(id: number): Promise<FormState> {
  const actor = await requireCostPermission("purchaseOrders", "edit");
  checkId(id);
  const state = await formAction(() => markOrderSent(actor, id));
  revalidatePath(`/purchase-orders/${id}`);
  return state;
}

export async function cancelOrderAction(id: number): Promise<FormState> {
  const actor = await requireCostPermission("purchaseOrders", "cancel");
  checkId(id);
  const state = await formAction(() => cancelOrder(actor, id));
  revalidatePath(`/purchase-orders/${id}`);
  return state;
}

/** Email the PDF to the vendor (D07), once it has left Draft. */
export async function emailOrderAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  await requireCostPermission("purchaseOrders", "view");
  checkId(id);
  return formAction(async () => {
    const o = await getOrder(id);
    if (!o) throw new UserError("That order doesn't exist.");
    if (o.status === "draft") throw new UserError("Mark the order as sent first: drafts aren't shared.");
    const mail = readMail(form);
    const pdf = (await purchaseOrderPdf(id))!;
    await sendPdfMail({ ...mail, fileName: pdf.fileName, pdf: pdf.bytes });
  });
}
