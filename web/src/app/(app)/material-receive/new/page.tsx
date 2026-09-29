import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { requireCostPermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { openOrders, receiveForm } from "@/lib/goods-receipts";
import { createReceiptAction } from "../actions";
import { ReceiveForm } from "../receive-form";

/** ?po= the order the goods came against; without it, pick one of the orders still to come. */
export default async function NewReceiptPage({ searchParams }: PageProps<"/material-receive/new">) {
  await requireCostPermission("goodsReceipts", "create");
  const { po } = await searchParams;
  const back = { href: "/material-receive", label: "Material receive" };

  if (!po) {
    const orders = await openOrders();
    return (
      <div className="grid grid-cols-1 gap-5">
        <PageHeader back={back} title="Receive goods" description="Pick the purchase order the goods came against." />
        <div className="rounded-lg border bg-card">
          {orders.length === 0 ? (
            <EmptyState title="No purchase orders are waiting for goods." />
          ) : (
            <ul className="divide-y text-[13px]">
              {orders.map((o) => (
                <li key={o.id}>
                  <Link href={`/material-receive/new?po=${o.id}`} className="flex flex-wrap items-center gap-x-3 px-4 py-2.5 hover:bg-muted/50">
                    <span className="font-medium text-primary tabular-nums">{o.number}</span>
                    <span>{o.vendor}</span>
                    <span className="text-muted-foreground">
                      <DateText date={o.date} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const id = Number(po);
  const order = Number.isSafeInteger(id) ? await receiveForm(id) : undefined;
  if (!order) notFound();
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={back} title={`Receive goods · ${order.number}`} description={order.vendor} />
      <ReceiveForm orderId={order.id} lines={order.lines} today={todayIST()} action={createReceiptAction} />
    </div>
  );
}
