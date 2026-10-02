import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getVendorPayment, vendorPaymentFormOptions } from "@/lib/vendor-payments";
import { openBillsAction, updatePaymentAction } from "../../actions";
import { PaymentForm } from "../../payment-form";

export default async function EditVendorPaymentPage({ params }: PageProps<"/vendor-payments/[id]/edit">) {
  const user = await requirePermission("payments", "edit");
  const id = Number((await params).id);
  const p = Number.isSafeInteger(id) ? await getVendorPayment(id) : undefined;
  if (!p) notFound();
  if (p.status !== "active") redirect(`/vendor-payments/${id}`);
  const [options, open] = await Promise.all([vendorPaymentFormOptions(p.vendorId), openBillsAction(p.vendorId, id)]);
  const isOwner = can(user, "approvals", "approve");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/vendor-payments/${id}`, label: p.number }}
        title={`Edit ${p.number}`}
        description={
          isOwner
            ? "A change to the date, amount, vendor or account reverses the entry and posts it again."
            : "The owner approves changes to a payment before they are made."
        }
      />
      <PaymentForm
        values={{
          vendorId: String(p.vendorId),
          date: p.date,
          amount: moneyText(p.amountPaise),
          mode: p.mode,
          moneyAccountId: String(p.moneyAccountId),
          reference: p.reference ?? "",
          chequeNo: p.chequeNo ?? "",
          chequeDate: p.chequeDate ?? "",
          notes: p.notes ?? "",
          allocated: Object.fromEntries(p.lines.map((l) => [`${l.target}:${l.billId}`, moneyText(l.amount)])),
        }}
        {...options}
        open={open}
        paymentId={id}
        askReason={!isOwner}
        submitLabel={isOwner ? "Save changes" : "Ask the owner"}
        action={updatePaymentAction.bind(null, id)}
        loadOpen={openBillsAction}
      />
    </div>
  );
}
