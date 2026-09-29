"use server";

import { redirect } from "next/navigation";
import { formAction, UserError, type FormState } from "@/lib/action";
import { requirePermission } from "@/lib/auth";
import { vendors } from "@/db/schema";
import { duplicateText, findDuplicates } from "@/lib/customers";
import { vendorStatementPdf } from "@/lib/pdf";
import { getSettings } from "@/lib/settings";
import { readMail, sendPdfMail, shareUrl, whatsappLink } from "@/lib/share";
import { createVendorStatementLink, readRange, statementMessage, vendorLedger } from "@/lib/statements";
import { applyVendorOnAccount } from "@/lib/vendor-payments";
import { createVendor, getVendor, updateVendor, type VendorInput } from "@/lib/vendors";

/** The form as typed. Opening balance / active only when the form showed them. */
function input(form: FormData): VendorInput {
  const text = (key: string) => String(form.get(key) ?? "");
  return {
    name: text("name"),
    gstin: text("gstin"),
    stateCode: text("stateCode"),
    mobile: text("mobile"),
    address: text("address"),
    creditDays: text("creditDays"),
    notes: text("notes"),
    openingBalance: form.has("openingBalance") ? text("openingBalance") : undefined,
    active: form.has("activeShown") ? form.get("active") === "on" : undefined,
  };
}

export async function createVendorAction(_: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("vendors", "create");
  return formAction(async () => {
    const id = await createVendor(actor, input(form));
    redirect(`/vendors/${id}`);
  });
}

export async function updateVendorAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("vendors", "edit");
  if (!Number.isSafeInteger(id)) throw new Error("Bad vendor id");
  return formAction(async () => {
    await updateVendor(actor, id, input(form));
    redirect(`/vendors/${id}`);
  });
}

/** The duplicate GSTIN / mobile warning (D46). exceptId = the vendor being edited. */
export async function vendorDuplicatesAction(exceptId: number | null, gstin: string, mobile: string) {
  await requirePermission("vendors", "view");
  const found = await findDuplicates(vendors, String(gstin), String(mobile), exceptId ?? undefined);
  return duplicateText(found, "vendor");
}

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad vendor id");
};

/** WhatsApp the vendor's statement (S15, like customers): a new public link wrapped in a wa.me link with the message. */
export async function vendorStatementShareAction(vendorId: number, period: string, from: string, to: string) {
  const actor = await requirePermission("vendors", "view");
  checkId(vendorId);
  const { range, error } = readRange(period, from, to);
  if (error) return { error };
  const v = await getVendor(vendorId);
  if (!v) return { error: "That vendor doesn't exist." };
  const [token, { closing }, { companyName }] = await Promise.all([
    createVendorStatementLink(actor, vendorId, range),
    vendorLedger(vendorId, range),
    getSettings(),
  ]);
  const link = shareUrl(token);
  return { url: whatsappLink(v.mobile, statementMessage({ name: v.name, range, closing, link, company: companyName })), link };
}

/** Email the vendor's statement PDF. */
export async function emailVendorStatementAction(
  vendorId: number,
  period: string,
  from: string,
  to: string,
  _: FormState,
  form: FormData,
): Promise<FormState> {
  await requirePermission("vendors", "view");
  checkId(vendorId);
  return formAction(async () => {
    const { range, error } = readRange(period, from, to);
    if (error) throw new UserError(error);
    const pdf = await vendorStatementPdf(vendorId, range);
    if (!pdf) throw new UserError("That vendor doesn't exist.");
    await sendPdfMail({ ...readMail(form), fileName: pdf.fileName, pdf: pdf.bytes });
  });
}

/** D52 (as D50 for customers): put a vendor payment's rest on the vendor's open bills. */
export async function applyVendorOnAccountAction(vendorId: number, paymentId: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("payments", "create");
  checkId(vendorId);
  checkId(paymentId);
  // No revalidatePath (as for customers): it would re-render the used-up apply page as a 404. The form goes back to
  // the vendor page, which renders fresh (dynamic).
  return formAction(() => applyVendorOnAccount(actor, vendorId, paymentId, String(form.get("allocations") ?? "")));
}
