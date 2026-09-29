import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireCostPermission } from "@/lib/auth";
import { listReceipts } from "@/lib/goods-receipts";
import { can } from "@/lib/permissions";
import { ReceiptsTable } from "./receipts-table";

export default async function MaterialReceivePage() {
  const user = await requireCostPermission("goodsReceipts", "view");
  const rows = await listReceipts();
  const newButton = can(user, "goodsReceipts", "create") ? (
    <Button asChild>
      <Link href="/material-receive/new">Receive goods</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Material receive"
        description="Goods received against purchase orders (GRN): into stock at the PO rate, then billed when the vendor's bill comes."
        action={newButton}
      />
      <ReceiptsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          order: r.order,
          vendor: r.vendor,
          bills: r.bills.join(", "),
          status: r.status === "cancelled" ? "Cancelled" : "Active",
          value: r.value,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
