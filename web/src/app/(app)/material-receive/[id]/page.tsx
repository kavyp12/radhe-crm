import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { PurchaseChain } from "@/components/purchase-chain";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireCostPermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { getReceipt } from "@/lib/goods-receipts";
import { milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { cancelReceiptAction } from "../actions";

const LABELS = { number: "Number", date: "Date", order_id: "Purchase order", notes: "Notes", status: "Status" };

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function ReceiptPage({ params }: PageProps<"/material-receive/[id]">) {
  const user = await requireCostPermission("goodsReceipts", "view");
  const id = Number((await params).id);
  const g = Number.isSafeInteger(id) ? await getReceipt(id) : undefined;
  if (!g) notFound();
  const active = g.status === "active";
  const unbilled = g.lines.some((l) => l.bill === null);
  const isOwner = can(user, "approvals", "approve");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/material-receive", label: "Material receive" }}
        title={g.number}
        status={active ? undefined : "Cancelled"}
        description={`${g.vendor} · against ${g.order}`}
      />
      <div className="flex flex-wrap gap-2">
        {active && unbilled && can(user, "books", "create") && (
          <Button asChild>
            <Link href={`/purchase-bills/new?grn=${id}`}>Enter the vendor&apos;s bill</Link>
          </Button>
        )}
        {active && can(user, "goodsReceipts", "cancel") && (
          <ActionDialog
            action={cancelReceiptAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${g.number}?`}
            description={
              <>
                Its stock and entry are reversed on its date ({formatDate(g.date)}) and the order&apos;s lines are open again.
                Refused once it is billed (cancel the bill first) or any of its stock has been used since.
                {!isOwner && " A backdated one goes to the owner for approval."}
              </>
            }
            confirmLabel="Cancel GRN"
            done="Cancelled."
            reason
            variant="destructive"
          />
        )}
      </div>
      <PurchaseChain user={user} step="receipt" id={id} />

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              [
                "Vendor",
                <Link key="v" href={`/vendors/${g.vendorId}`} className="text-primary hover:underline">
                  {g.vendor}
                </Link>,
              ],
              [
                "Purchase order",
                <Link key="o" href={`/purchase-orders/${g.orderId}`} className="text-primary hover:underline">
                  {g.order}
                </Link>,
              ],
              ["Date received", <DateText key="d" date={g.date} />],
              ["Notes", g.notes],
            ]}
          />
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} w-8 text-right`}>#</th>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>PO rate</th>
                  <th className={`${th} text-right`}>Value</th>
                  <th className={th}>Billed on</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => (
                  <tr key={l.id}>
                    <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.position}</td>
                    <td className={`${td} font-medium`}>
                      <Link href={`/items/${l.itemId}`} className="text-primary hover:underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                      {milliText(l.qtyMilli)} {l.unit}
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={l.ratePaise} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={l.valuePaise} />
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {l.bill ? (
                        <Link href={`/purchase-bills/${l.bill.id}`} className="text-primary hover:underline">
                          {l.bill.number}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Not billed</span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className={td} />
                  <td className={td}>Total (into stock, excl. GST)</td>
                  <td className={td} />
                  <td className={td} />
                  <td className={`${td} text-right`}>
                    <Money paise={g.total} />
                  </td>
                  <td className={td} />
                </tr>
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <History
            table="goods_receipts"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              order_id: (v) => (v === g.orderId ? g.order : String(v)),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
