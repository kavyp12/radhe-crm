import { DateText } from "@/components/date-text";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireCostPermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { approvedRequests, linesFromRequests, orderFormOptions } from "@/lib/purchase-orders";
import { createOrderAction } from "../actions";
import { OrderForm } from "../order-form";

/** ?mr=<id> (repeatable): the lines of those approved requests are copied in (qty editable); otherwise blank. */
export default async function NewOrderPage({ searchParams }: PageProps<"/purchase-orders/new">) {
  await requireCostPermission("purchaseOrders", "create");
  const { mr } = await searchParams;
  const asked = [mr ?? []].flat().map(Number).filter(Number.isSafeInteger);
  const [options, approved, copied] = await Promise.all([orderFormOptions(), approvedRequests(), linesFromRequests(asked)]);
  const picked = new Set(copied.requests.map((r) => r.id));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/purchase-orders", label: "Purchase orders" }} title="New purchase order" />
      {approved.length > 0 && (
        <form method="get" className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Approved material requests</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Tick the ones to order together; their lines are copied into the order below.</p>
          </div>
          <ul className="divide-y text-[13px]">
            {approved.map((r) => (
              <li key={r.id}>
                <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-muted/50">
                  <input type="checkbox" name="mr" value={r.id} defaultChecked={picked.has(r.id)} className="mt-0.5 size-4" />
                  <span className="grid gap-0.5">
                    <span className="font-medium tabular-nums">
                      {r.number}
                      {r.job && <span className="font-normal text-muted-foreground"> · job {r.job}</span>}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · needed by <DateText date={r.neededBy} />
                      </span>
                    </span>
                    <span className="text-muted-foreground">{r.items}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="border-t px-4 py-3">
            <Button type="submit" variant="outline" size="sm">
              Copy their lines
            </Button>
          </div>
        </form>
      )}
      <OrderForm
        key={[...picked].join(",")}
        values={{ vendorId: "", date: todayIST(), notes: "", lines: copied.lines }}
        options={options}
        submitLabel="Save order"
        action={createOrderAction}
      />
    </div>
  );
}
