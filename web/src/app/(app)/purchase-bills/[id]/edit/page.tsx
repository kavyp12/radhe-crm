import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireCostPermission } from "@/lib/auth";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { formLines, getPurchaseBill, purchaseFormOptions } from "@/lib/purchase-bills";
import { updateBillAction } from "../../actions";
import { BillForm } from "../../bill-form";

export default async function EditPurchaseBillPage({ params }: PageProps<"/purchase-bills/[id]/edit">) {
  const user = await requireCostPermission("books", "edit");
  const id = Number((await params).id);
  const b = Number.isSafeInteger(id) ? await getPurchaseBill(id) : undefined;
  if (!b) notFound();
  if (b.status !== "active") redirect(`/purchase-bills/${id}`);
  const options = await purchaseFormOptions({ vendorId: b.vendorId, lines: b.lines });
  const isOwner = can(user, "approvals", "approve");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/purchase-bills/${id}`, label: b.number }}
        title={`Edit ${b.number}`}
        description={
          isOwner
            ? "Saving reverses the bill's entry and stock and posts them again."
            : "The owner approves changes to a bill before they are made."
        }
      />
      <BillForm
        values={{
          vendorId: String(b.vendorId),
          vendorBillNo: b.vendorBillNo,
          date: b.date,
          roundOff: moneyText(b.roundOffPaise),
          notes: b.notes ?? "",
          lines: formLines(b.lines),
        }}
        options={options}
        askReason={!isOwner}
        submitLabel={isOwner ? "Save changes" : "Ask the owner"}
        back={`/purchase-bills/${id}`}
        action={updateBillAction.bind(null, id)}
      />
    </div>
  );
}
