import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { can, canViewCost } from "@/lib/permissions";
import { itemOptions } from "@/lib/stock";
import { createAdjustmentAction } from "../actions";
import { AdjustmentForm } from "../adjustment-form";

/** ?item= picks the item (from its page). */
export default async function NewAdjustmentPage({ searchParams }: PageProps<"/stock-adjustments/new">) {
  const user = await requirePermission("stockAdjustment", "create");
  const { item } = await searchParams;
  const items = await itemOptions(user);
  const owner = can(user, "approvals", "approve");
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/stock-adjustments", label: "Adjustments" }}
        title="New stock adjustment"
        description={owner ? "Numbered SA/… and posted when saved." : "The owner approves stock adjustments before they are made."}
      />
      <AdjustmentForm
        items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: i.qty, ...("cost" in i ? { average: i.cost.average } : {}) }))}
        today={todayIST()}
        itemId={typeof item === "string" ? item : ""}
        cost={canViewCost(user)}
        owner={owner}
        action={createAdjustmentAction}
      />
    </div>
  );
}
