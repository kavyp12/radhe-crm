import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { TotalsPanel } from "@/components/line-items";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { listAttachments } from "@/lib/attachments";
import { requireCostPermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { stateName } from "@/lib/gstin";
import { amountInWords, bpText, milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getPurchaseBill } from "@/lib/purchase-bills";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { billPayments } from "@/lib/vendor-payments";
import { cancelBillAction } from "../actions";

const LABELS = {
  number: "Number",
  vendor_id: "Vendor",
  vendor_bill_no: "Vendor bill no",
  date: "Bill date",
  due_date: "Due date",
  vendor_state_code: "Vendor state",
  round_off_paise: "Round off",
  total_paise: "Total",
  status: "Status",
  notes: "Notes",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 align-top";

export default async function PurchaseBillPage({ params }: PageProps<"/purchase-bills/[id]">) {
  const user = await requireCostPermission("books", "view");
  const id = Number((await params).id);
  const b = Number.isSafeInteger(id) ? await getPurchaseBill(id) : undefined;
  if (!b) notFound();
  const [files, names, payments] = await Promise.all([
    listAttachments("purchase_bill", id),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors),
    billPayments(id),
  ]);
  const isOwner = can(user, "approvals", "approve");
  const active = b.status === "active";
  const t = b.totals;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/purchase-bills", label: "Purchase bills" }}
        title={b.number}
        status={b.payment}
        description={`${b.vendor.name} · bill ${b.vendorBillNo}`}
      />
      <div className="flex flex-wrap gap-2">
        {active && b.open > 0n && can(user, "payments", "create") && (
          <Button asChild>
            <Link href={`/vendor-payments/new?vendor=${b.vendorId}&bill=${id}`}>Record payment</Link>
          </Button>
        )}
        {active && can(user, "books", "edit") && (
          <Button asChild variant="outline">
            <Link href={`/purchase-bills/${id}/edit`}>Edit</Link>
          </Button>
        )}
        {active && can(user, "books", "cancel") && (
          <ActionDialog
            action={cancelBillAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${b.number}?`}
            description={
              <>
                Its journal entry and its stock are reversed on the bill date ({formatDate(b.date)}); the number stays and
                payments on it go back on account. Refused once any of its items has been used or issued since (use a
                stock adjustment then).
                {!isOwner && " This goes to the owner for approval."}
              </>
            }
            confirmLabel="Cancel bill"
            done="Cancelled."
            reason
            variant="destructive"
          />
        )}
      </div>

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="payments">Payments ({payments.length})</TabsTrigger>
          <TabsTrigger value="attachments">Bill photo ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              [
                "Vendor",
                can(user, "vendors", "view") ? (
                  <Link key="v" href={`/vendors/${b.vendorId}`} className="text-primary hover:underline">
                    {b.vendor.name}
                  </Link>
                ) : (
                  b.vendor.name
                ),
              ],
              ["Vendor bill no", b.vendorBillNo],
              ["Bill date", <DateText key="d" date={b.date} />],
              ["Due date", <DateText key="due" date={b.dueDate} />],
              ["GSTIN", b.vendor.gstin ?? "Unregistered"],
              ["Vendor state", `${b.vendorStateCode} · ${stateName(b.vendorStateCode) ?? ""}`],
              ["Notes", b.notes],
            ]}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} w-8 text-right`}>#</th>
                    <th className={th}>Item / expense</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Rate</th>
                    <th className={`${th} text-right`}>Taxable</th>
                    <th className={`${th} text-right`}>GST %</th>
                    <th className={th}>Job</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l, i) => (
                    <tr key={l.id}>
                      <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.position}</td>
                      <td className={td}>
                        <div className="font-medium">
                          {l.stockItemId !== null ? (
                            <Link href={`/items/${l.stockItemId}`} className="text-primary hover:underline">
                              {l.what}
                            </Link>
                          ) : (
                            <>Expense · {l.what}</>
                          )}
                        </div>
                        {l.description && <div className="text-xs text-muted-foreground">{l.description}</div>}
                      </td>
                      <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                        {milliText(l.qtyMilli)} {l.unit ?? ""}
                      </td>
                      <td className={`${td} text-right`}>
                        <Money paise={l.ratePaise} />
                      </td>
                      <td className={`${td} text-right`}>
                        <Money paise={t.lines[i].taxable} />
                      </td>
                      <td className={`${td} text-right tabular-nums`}>{bpText(l.gstBp)}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        {l.jobId !== null && (
                          <Link href={`/jobs/${l.jobId}`} className="text-primary hover:underline">
                            {l.job}
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
                ...(b.mode === "same_state"
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

        <TabsContent value="payments" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Total", <Money key="t" paise={b.totalPaise} />],
              ["Paid", <Money key="p" paise={b.paid} />],
              ["Open", <Money key="o" paise={b.open} />],
              ["Due date", <DateText key="due" date={b.dueDate} />],
            ]}
          />
          {payments.length > 0 && (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-120 text-[13px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="h-9 border-b px-3 font-medium">Payment</th>
                    <th className="h-9 border-b px-3 font-medium">Date</th>
                    <th className="h-9 border-b px-3 font-medium">Mode</th>
                    <th className="h-9 border-b px-3 text-right font-medium">Allocated here</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.paymentId}>
                      <td className="border-b px-3 py-2 font-medium tabular-nums">
                        {can(user, "payments", "view") ? (
                          <Link href={`/vendor-payments/${p.paymentId}`} className="text-primary hover:underline">
                            {p.number}
                          </Link>
                        ) : (
                          p.number
                        )}
                      </td>
                      <td className="border-b px-3 py-2">
                        <DateText date={p.date} />
                      </td>
                      <td className="border-b px-3 py-2">{RECEIPT_MODE[p.mode]}</td>
                      <td className="border-b px-3 py-2 text-right">
                        <Money paise={p.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="purchase_bill"
            entityId={id}
            items={files}
            canUpload={can(user, "books", "edit")}
            defaultKind="purchase_bill_photo"
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="purchase_bills"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              vendor_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
