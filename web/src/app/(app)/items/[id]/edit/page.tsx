import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { listExpenseCategories } from "@/lib/categories";
import { bpText, milliText, moneyText } from "@/lib/num";
import { can, canViewCost } from "@/lib/permissions";
import { getItem } from "@/lib/stock";
import { updateItemAction } from "../../actions";
import { ItemForm } from "../../item-form";

export default async function EditItemPage({ params }: PageProps<"/items/[id]/edit">) {
  const user = await requirePermission("stockItems", "edit");
  const id = Number((await params).id);
  const item = Number.isSafeInteger(id) ? await getItem(user, id) : undefined;
  if (!item) notFound();
  const categories = (await listExpenseCategories()).filter((c) => c.active || c.id === item.categoryId);
  const canSetOpening = can(user, "openingBalances", "edit") && canViewCost(user);

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: `/items/${id}`, label: item.name }} title="Edit item" />
      <ItemForm
        values={{
          name: item.name,
          unit: item.unit,
          categoryId: String(item.categoryId),
          hsnSac: item.hsnSac ?? "",
          gstPercent: item.gstBp === null ? "" : bpText(item.gstBp),
          openingQty: item.openingQtyMilli ? milliText(item.openingQtyMilli) : "",
          openingRate: item.cost?.openingRatePaise ? moneyText(item.cost.openingRatePaise) : "",
          active: item.active,
        }}
        categories={categories}
        canSetOpening={canSetOpening}
        canDeactivate={can(user, "stockItems", "cancel")}
        submitLabel="Save changes"
        action={updateItemAction.bind(null, id)}
      />
    </div>
  );
}
