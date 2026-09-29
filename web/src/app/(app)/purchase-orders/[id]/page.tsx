import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionButton, ActionDialog } from "@/components/doc-actions";
import { DocFacts, DocShare } from "@/components/doc-share";
import { History } from "@/components/history";
import { TotalsPanel } from "@/components/line-items";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { requireCostPermission } from "@/lib/auth";
import { stateName } from "@/lib/gstin";
import { amountInWords, bpText, milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getOrder, ORDER_STATUS } from "@/lib/purchase-orders";
import { getSettings } from "@/lib/settings";
import { shareMessage, shareUrl, whatsappLink } from "@/lib/share";
import { cancelOrderAction, emailOrderAction, sendOrderAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Order date",
  vendor_id: "Vendor",
  vendor_state_code: "Vendor state",
  total_paise: "Total",
  status: "Status",
  notes: "Notes",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 align-top";

export default async function PurchaseOrderPage({ params }: PageProps<"/purchase-orders/[id]">) {
  const user = await requireCostPermission("purchaseOrders", "view");
  const id = Number((await params).id);
  const o = Number.isSafeInteger(id) ? await getOrder(id) : undefined;
  if (!o) notFound();
  const [settings, names] = await Promise.all([getSettings(), db.select({ id: vendors.id, name: vendors.name }).from(vendors)]);
  const open = o.status !== "cancelled";
  const shared = o.status !== "draft";
  const t = o.totals;
  const message = shareMessage({
    what: "our purchase order",
    number: o.number,
    name: o.vendor.name,
    total: o.totalPaise,
    link: shareUrl(o.shareToken),
    company: settings.companyName,
  });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/purchase-orders", label: "Purchase orders" }} title={o.number} status={ORDER_STATUS[o.status]} description={o.vendor.name} />
      <div className="flex flex-wrap gap-2">
        <DocShare
          pdfHref={`/purchase-orders/${id}/pdf`}
          whatsapp={shared && open ? whatsappLink(o.vendor.mobile, message) : undefined}
          email={
            shared && open
              ? {
                  action: emailOrderAction.bind(null, id),
                  to: o.vendor.email ?? "",
                  subject: `Purchase order ${o.number}${settings.companyName ? ` from ${settings.companyName}` : ""}`,
                  message,
                }
              : undefined
          }
        />
        {o.status === "draft" && can(user, "purchaseOrders", "edit") && (
          <ActionButton action={sendOrderAction.bind(null, id)} label="Mark as sent" done="Marked as sent." variant="default" />
        )}
        {open && can(user, "purchaseOrders", "edit") && (
          <Button asChild variant="outline">
            <Link href={`/purchase-orders/${id}/edit`}>Edit</Link>
          </Button>
        )}
        {open && can(user, "purchaseOrders", "cancel") && (
          <ActionDialog
            action={cancelOrderAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${o.number}?`}
            description="The number stays, marked Cancelled. Its material requests become Approved again, so they can be ordered elsewhere."
            confirmLabel="Cancel order"
            done="Cancelled."
            variant="destructive"
          />
        )}
      </div>

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
                <Link key="v" href={`/vendors/${o.vendorId}`} className="text-primary hover:underline">
                  {o.vendor.name}
                </Link>,
              ],
              ["Order date", <DateText key="d" date={o.date} />],
              ["GSTIN", o.vendor.gstin ?? "Unregistered"],
              ["Vendor state", `${o.vendorStateCode} · ${stateName(o.vendorStateCode) ?? ""}`],
              [
                "Material requests",
                o.requests.length
                  ? o.requests.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ", "}
                        <Link href={`/material-requests/${r.id}`} className="text-primary hover:underline">
                          {r.number}
                        </Link>
                      </span>
                    ))
                  : null,
              ],
              ["Notes", o.notes],
            ]}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} w-8 text-right`}>#</th>
                    <th className={th}>Item</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Rate</th>
                    <th className={`${th} text-right`}>Taxable</th>
                    <th className={`${th} text-right`}>GST %</th>
                    <th className={th}>Request</th>
                  </tr>
                </thead>
                <tbody>
                  {o.lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.position}</td>
                      <td className={td}>
                        <Link href={`/items/${l.itemId}`} className="font-medium text-primary hover:underline">
                          {l.name}
                        </Link>
                        {l.description && <div className="text-xs text-muted-foreground">{l.description}</div>}
                      </td>
                      <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                        {milliText(l.qtyMilli)} {l.unit}
                      </td>
                      <td className={`${td} text-right`}>
                        <Money paise={l.ratePaise} />
                      </td>
                      <td className={`${td} text-right`}>
                        <Money paise={t.lines[i].taxable} />
                      </td>
                      <td className={`${td} text-right tabular-nums`}>{bpText(l.gstBp)}</td>
                      <td className={`${td} whitespace-nowrap tabular-nums`}>
                        {l.requestId !== null && (
                          <Link href={`/material-requests/${l.requestId}`} className="text-primary hover:underline">
                            {l.request}
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TotalsPanel
              rows={[
                { label: "Taxable value", paise: t.taxable },
                ...(o.mode === "same_state"
                  ? [
                      { label: "CGST", paise: t.cgst },
                      { label: "SGST", paise: t.sgst },
                    ]
                  : [{ label: "IGST", paise: t.igst }]),
                { label: "Round off", paise: t.roundOff },
              ]}
              total={t.total}
              words={amountInWords(t.total)}
            />
          </div>
        </TabsContent>

        <TabsContent value="history">
          <History
            table="purchase_orders"
            rowId={id}
            labels={LABELS}
            hide={["created_by", "share_token"]}
            display={{
              vendor_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              status: (v) => ORDER_STATUS[v as keyof typeof ORDER_STATUS] ?? String(v),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
