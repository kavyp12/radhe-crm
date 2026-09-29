import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can, canViewCost } from "@/lib/permissions";
import { listAdjustments } from "@/lib/stock";
import { AdjustmentsTable } from "./adjustments-table";

// Owner: full; accountant: requests them (A§8). Both see the list.
export default async function StockAdjustmentsPage() {
  const user = await requirePermission("stockAdjustment");
  const rows = await listAdjustments(user);
  const newButton = can(user, "stockAdjustment", "create") ? (
    <Button asChild>
      <Link href="/stock-adjustments/new">New adjustment</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Stock adjustments"
        description="Stock found or lost on a count, at the average cost. Posted against Cash Short / Excess."
        action={newButton}
      />
      <AdjustmentsTable
        rows={rows.map((r) => ({ ...r, value: "cost" in r ? r.cost.value : undefined }))}
        cost={canViewCost(user)}
        newButton={newButton}
      />
    </div>
  );
}
