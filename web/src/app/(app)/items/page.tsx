import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ExportExcelButton } from "@/components/report-actions";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can, canViewCost } from "@/lib/permissions";
import { listItems } from "@/lib/stock";
import { ItemsTable } from "./items-table";

export default async function ItemsPage() {
  const user = await requirePermission("stockItems", "view");
  const rows = await listItems(user);
  const newButton = can(user, "stockItems", "create") ? (
    <Button asChild>
      <Link href="/items/new">New item</Link>
    </Button>
  ) : undefined;
  const cost = canViewCost(user);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Items"
        description={cost ? "Stock items: what is in stock, at weighted average cost." : "Stock items and what is in stock."}
        action={
          <div className="flex gap-2">
            <ExportExcelButton name="items" />
            {can(user, "stockAdjustment") && (
              <Button asChild variant="outline">
                <Link href="/stock-adjustments">Adjustments</Link>
              </Button>
            )}
            {newButton}
          </div>
        }
      />
      <ItemsTable
        rows={rows.map((r) => ({ ...r, ...("cost" in r ? r.cost : {}) }))}
        cost={cost}
        newButton={newButton}
      />
    </div>
  );
}
