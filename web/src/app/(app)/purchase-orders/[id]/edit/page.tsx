import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireCostPermission } from "@/lib/auth";
import { formLines, getOrder, orderFormOptions } from "@/lib/purchase-orders";
import { updateOrderAction } from "../../actions";
import { OrderForm } from "../../order-form";

export default async function EditOrderPage({ params }: PageProps<"/purchase-orders/[id]/edit">) {
  await requireCostPermission("purchaseOrders", "edit");
  const id = Number((await params).id);
  const o = Number.isSafeInteger(id) ? await getOrder(id) : undefined;
  if (!o || o.status === "cancelled") notFound();
  const options = await orderFormOptions({ vendorId: o.vendorId, itemIds: o.lines.map((l) => l.itemId) });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/purchase-orders/${id}`, label: o.number }}
        title={`Edit ${o.number}`}
        description={o.status === "sent" ? "Saving takes it back to Draft: send it to the vendor again." : undefined}
      />
      <OrderForm
        values={{ vendorId: String(o.vendorId), date: o.date, notes: o.notes ?? "", lines: formLines(o.lines) }}
        options={options}
        submitLabel="Save changes"
        action={updateOrderAction.bind(null, id)}
      />
    </div>
  );
}
