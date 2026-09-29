import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocLines } from "@/components/doc-lines";
import { DocFacts, DocShare } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { stateName } from "@/lib/gstin";
import { creditWarning, getInvoice, INVOICE_KIND, INVOICE_STATUS, type InvoiceKind, type InvoiceStatus } from "@/lib/invoices";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { invoicePayments } from "@/lib/receipts";
import { getSettings } from "@/lib/settings";
import { shareMessage, shareUrl, whatsappLink } from "@/lib/share";
import { cancelInvoiceAction, emailInvoiceAction, issueInvoiceAction } from "../actions";

const LABELS = {
  kind: "Kind",
  number: "Number",
  date: "Date",
  customer_id: "Customer",
  place_of_supply: "Place of supply",
  due_date: "Due date",
  status: "Status",
  total_paise: "Total",
  round_off_paise: "Round off",
  terms: "Terms",
  notes: "Notes",
};

export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const user = await requirePermission("invoices", "view");
  const id = Number((await params).id);
  const inv = Number.isSafeInteger(id) ? await getInvoice(id) : undefined;
  if (!inv) notFound();
  const [files, settings, names, warning, payments] = await Promise.all([
    listAttachments("invoice", id),
    getSettings(),
    db.select({ id: customers.id, name: customers.name }).from(customers),
    inv.status === "draft" ? creditWarning(inv.customerId, inv.totalPaise) : null,
    invoicePayments(id),
  ]);
  const c = inv.customer;
  const title = inv.number ?? `Draft ${INVOICE_KIND[inv.kind].toLowerCase()}`;
  const isOwner = can(user, "approvals", "approve");
  const jobs = [...new Map(inv.lines.filter((l) => l.jobId).map((l) => [l.jobId!, l.job!])).entries()];
  const message = shareMessage({
    what: `our ${INVOICE_KIND[inv.kind].toLowerCase()}`,
    number: title,
    name: c.name,
    total: inv.totalPaise,
    link: shareUrl(inv.shareToken),
    company: settings.companyName,
  });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/invoices", label: "Invoices" }}
        title={title}
        status={inv.payment && inv.status === "issued" ? [INVOICE_STATUS[inv.status], inv.payment] : INVOICE_STATUS[inv.status]}
        description={`${INVOICE_KIND[inv.kind]} · ${c.firmName ? `${c.name} · ${c.firmName}` : c.name}`}
      />
      <div className="flex flex-wrap gap-2">
        <DocShare
          pdfHref={`/invoices/${id}/pdf`}
          whatsapp={inv.status !== "draft" ? whatsappLink(c.mobile, message) : undefined}
          email={
            inv.status !== "draft"
              ? {
                  action: emailInvoiceAction.bind(null, id),
                  to: c.email ?? "",
                  subject: `${INVOICE_KIND[inv.kind]} ${title}${settings.companyName ? ` from ${settings.companyName}` : ""}`,
                  message,
                }
              : undefined
          }
        />
        {inv.status === "issued" && inv.open > 0n && can(user, "payments", "create") && (
          <Button asChild>
            <Link href={`/receipts/new?customer=${inv.customerId}&invoice=${id}`}>Record payment</Link>
          </Button>
        )}
        {inv.status === "draft" && can(user, "invoices", "edit") && (
          <>
            <Button asChild variant="outline">
              <Link href={`/invoices/${id}/edit`}>Edit</Link>
            </Button>
            <ActionDialog
              action={issueInvoiceAction.bind(null, id)}
              label="Issue"
              title={`Issue this ${INVOICE_KIND[inv.kind].toLowerCase()}?`}
              description={
                <>
                  It gets its number, is posted to the books and can&apos;t be edited after. Jobs on it become Invoiced.
                  {!isOwner && " A discount over the limit or an old date sends it to the owner for approval first."}
                </>
              }
              confirmLabel="Issue"
              done="Issued."
              variant="default"
            >
              {warning && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{warning}</p>}
            </ActionDialog>
          </>
        )}
        {inv.status !== "cancelled" && can(user, "invoices", "cancel") && (
          <ActionDialog
            action={cancelInvoiceAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${title}?`}
            description={
              inv.status === "draft" ? (
                "The draft stays on record, marked Cancelled. Its jobs can be billed again."
              ) : (
                <>
                  The journal entry is reversed on the invoice date ({formatDate(inv.date)}), the number stays, its jobs go
                  back to their status and payments allocated to it go back on account. After that month&apos;s GST return
                  has been filed, use a credit note instead.
                  {!isOwner && " This goes to the owner for approval."}
                </>
              )
            }
            confirmLabel="Cancel invoice"
            done="Cancelled."
            reason={inv.status === "issued"}
            variant="destructive"
          />
        )}
      </div>
      {warning && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {warning}
        </p>
      )}

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          {inv.status !== "draft" && <TabsTrigger value="payments">Payments ({payments.length})</TabsTrigger>}
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={inv.date} />],
              ["Due date", <DateText key="due" date={inv.dueDate} />],
              ["Customer", c.firmName ? `${c.name}\n${c.firmName}` : c.name],
              ["GSTIN", c.gstin ?? "Unregistered"],
              ["Place of supply", `${inv.placeOfSupply} · ${stateName(inv.placeOfSupply) ?? ""}`],
              ["Billing address", c.billingAddress],
              [
                "Jobs",
                jobs.length ? (
                  <span key="j" className="flex flex-wrap gap-x-2">
                    {jobs.map(([jobId, number]) => (
                      <Link key={jobId} href={`/jobs/${jobId}`} className="text-primary hover:underline">
                        {number}
                      </Link>
                    ))}
                  </span>
                ) : null,
              ],
              ["Terms", inv.terms],
              ["Notes", inv.notes],
            ]}
          />
          <DocLines lines={inv.lines} totals={inv.totals} mode={inv.mode} />
        </TabsContent>

        <TabsContent value="payments" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Total", <Money key="t" paise={inv.totalPaise} />],
              ["Received", <Money key="r" paise={inv.paid} />],
              ["Open", <Money key="o" paise={inv.open} />],
              ["Due date", <DateText key="due" date={inv.dueDate} />],
            ]}
          />
          {payments.length > 0 && (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-120 text-[13px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="h-9 border-b px-3 font-medium">Receipt</th>
                    <th className="h-9 border-b px-3 font-medium">Date</th>
                    <th className="h-9 border-b px-3 font-medium">Mode</th>
                    <th className="h-9 border-b px-3 text-right font-medium">Allocated here</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.receiptId}>
                      <td className="border-b px-3 py-2 font-medium tabular-nums">
                        {can(user, "payments", "view") ? (
                          <Link href={`/receipts/${p.receiptId}`} className="text-primary hover:underline">
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
          <AttachmentsPanel entityType="invoice" entityId={id} items={files} canUpload={can(user, "invoices", "edit")} />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="invoices"
            rowId={id}
            labels={LABELS}
            hide={["created_by", "share_token"]}
            display={{
              customer_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              status: (v) => INVOICE_STATUS[v as InvoiceStatus] ?? String(v),
              kind: (v) => INVOICE_KIND[v as InvoiceKind] ?? String(v),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
