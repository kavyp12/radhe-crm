import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ExportExcelButton } from "@/components/report-actions";
import { Button } from "@/components/ui/button";
import { requireCostPermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listPurchaseBills } from "@/lib/purchase-bills";
import { BillsTable } from "./bills-table";

export default async function PurchaseBillsPage() {
  const user = await requireCostPermission("books", "view");
  const rows = await listPurchaseBills();
  const newButton = can(user, "books", "create") ? (
    <Button asChild>
      <Link href="/purchase-bills/new">New purchase bill</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Purchase bills" description="Vendors' bills: material into stock, expenses to their category (and job)." action={
          <div className="flex gap-2">
            <ExportExcelButton name="purchase-bills" />
            {newButton}
          </div>
        }
      />
      <BillsTable
        rows={rows.map((r) => ({ ...r, status: r.payment }))}
        newButton={newButton}
      />
    </div>
  );
}
