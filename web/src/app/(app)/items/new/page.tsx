import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { listExpenseCategories } from "@/lib/categories";
import { can, canViewCost } from "@/lib/permissions";
import { createItemAction } from "../actions";
import { ItemForm } from "../item-form";

export default async function NewItemPage() {
  const user = await requirePermission("stockItems", "create");
  const categories = (await listExpenseCategories()).filter((c) => c.active);
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: "/items", label: "Items" }} title="New item" />
      <ItemForm
        values={{ name: "", unit: "Nos", categoryId: "", hsnSac: "", gstPercent: "", openingQty: "", openingRate: "", active: true }}
        categories={categories}
        canSetOpening={can(user, "openingBalances", "edit") && canViewCost(user)}
        canDeactivate={false}
        submitLabel="Create item"
        action={createItemAction}
      />
    </div>
  );
}
