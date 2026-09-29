import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { accounts, vendors } from "@/db/schema";
import { canAttach, listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { can, canViewCost } from "@/lib/permissions";
import { RECEIPT_MODE, type ReceiptMode } from "@/lib/receipt-modes";
import { getVendorPayment } from "@/lib/vendor-payments";
import { cancelPaymentAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  vendor_id: "Vendor",
  amount_paise: "Amount",
  mode: "Mode",
  money_account_id: "Account",
  reference: "Reference",
  cheque_no: "Cheque no",
  cheque_date: "Cheque date",
  notes: "Notes",
  status: "Status",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function VendorPaymentPage({ params }: PageProps<"/vendor-payments/[id]">) {
  const user = await requirePermission("payments", "view");
  const id = Number((await params).id);
  const p = Number.isSafeInteger(id) ? await getVendorPayment(id) : undefined;
  if (!p) notFound();
  const [files, names, money] = await Promise.all([
    listAttachments("vendor_payment", id),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors),
    db.select({ id: accounts.id, name: accounts.name }).from(accounts),
  ]);
  const active = p.status === "active";
  const isOwner = can(user, "approvals", "approve");
  // Bill pages show purchase rates: linked only for can_view_cost users (D51).
  const bill = (l: { billId: number; number: string }) =>
    can(user, "books", "view") && canViewCost(user) ? (
      <Link href={`/purchase-bills/${l.billId}`} className="font-medium text-primary tabular-nums hover:underline">
        {l.number}
      </Link>
    ) : (
      <span className="font-medium tabular-nums">{l.number}</span>
    );

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/vendor-payments", label: "Vendor payments" }}
        title={p.number}
        status={active ? undefined : "Cancelled"}
        description={`${p.vendor.name} · ${RECEIPT_MODE[p.mode]}`}
      />
      {active && (
        <div className="flex flex-wrap gap-2">
          {can(user, "payments", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/vendor-payments/${id}/edit`}>Edit</Link>
            </Button>
          )}
          {can(user, "payments", "cancel") && (
            <ActionDialog
              action={cancelPaymentAction.bind(null, id)}
              label="Cancel"
              title={`Cancel ${p.number}?`}
              description={
                <>
                  The entry is reversed on the payment date ({formatDate(p.date)}), the number stays and the bills it paid are
                  open again.
                  {!isOwner && " This goes to the owner for approval."}
                </>
              }
              confirmLabel="Cancel payment"
              done="Cancelled."
              reason
              variant="destructive"
            />
          )}
        </div>
      )}

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={p.date} />],
              [
                "Vendor",
                can(user, "vendors", "view") ? (
                  <Link key="v" href={`/vendors/${p.vendorId}`} className="text-primary hover:underline">
                    {p.vendor.name}
                  </Link>
                ) : (
                  p.vendor.name
                ),
              ],
              ["Amount", <Money key="a" paise={p.amountPaise} />],
              ["From account", `${p.account} (${RECEIPT_MODE[p.mode]})`],
              ["Cheque", p.chequeNo ? `No ${p.chequeNo}${p.chequeDate ? ` · dated ${formatDate(p.chequeDate)}` : ""}` : null],
              ["Reference", p.reference],
              ["Notes", p.notes],
            ]}
          />

          <section className="overflow-x-auto rounded-lg border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-medium">Allocation</h2>
            <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Bill</th>
                  <th className={th}>Vendor bill no</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>Bill total</th>
                  <th className={`${th} text-right`}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.id}>
                    <td className={td}>{bill(l)}</td>
                    <td className={td}>{l.vendorBillNo}</td>
                    <td className={td}>
                      <DateText date={l.date} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={l.total} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={l.amount} />
                    </td>
                  </tr>
                ))}
                {active && (
                  <tr>
                    <td className={td} colSpan={4}>
                      On account
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={p.onAccount} />
                    </td>
                  </tr>
                )}
                {p.removed.map((l) => (
                  <tr key={l.id} className="text-muted-foreground">
                    <td className={td}>
                      <span className="line-through">{l.number}</span> · removed <DateText at={l.changedAt} />
                    </td>
                    <td className={td}>{l.vendorBillNo}</td>
                    <td className={td}>
                      <DateText date={l.date} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={l.total} />
                    </td>
                    <td className={`${td} text-right line-through`}>
                      <Money paise={l.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="vendor_payment"
            entityId={id}
            items={files}
            canUpload={canAttach(user, "vendor_payment", "edit")}
            defaultKind={p.mode === "cheque" ? "cheque" : "payment_screenshot"}
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="vendor_payments"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              vendor_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              money_account_id: (v) => money.find((m) => m.id === v)?.name ?? String(v),
              mode: (v) => RECEIPT_MODE[v as ReceiptMode] ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
