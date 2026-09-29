import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireCostPermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listOrders, ORDER_STATUS } from "@/lib/purchase-orders";
import { OrdersTable } from "./orders-table";

export default async function PurchaseOrdersPage() {
  const user = await requireCostPermission("purchaseOrders", "view");
  const rows = await listOrders();
  const newButton = can(user, "purchaseOrders", "create") ? (
    <Button asChild>
      <Link href="/purchase-orders/new">New purchase order</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Purchase orders" description="Orders to vendors, from approved material requests or blank. They don't post to the books." action={newButton} />
      <OrdersTable rows={rows.map((r) => ({ ...r, status: ORDER_STATUS[r.status] }))} newButton={newButton} />
    </div>
  );
}
