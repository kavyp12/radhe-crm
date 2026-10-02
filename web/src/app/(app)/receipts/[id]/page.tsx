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
import { accounts, customers, users } from "@/db/schema";
import { canAttach, listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE, type ReceiptMode } from "@/lib/receipt-modes";
import { getReceipt } from "@/lib/receipts";
import { cancelReceiptAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  customer_id: "Customer",
  amount_paise: "Amount",
  mode: "Mode",
  money_account_id: "Account",
  reference: "Reference",
  cheque_no: "Cheque no",
  cheque_date: "Cheque date",
  received_by: "Received by",
  notes: "Notes",
  status: "Status",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function ReceiptPage({ params }: PageProps<"/receipts/[id]">) {
  const user = await requirePermission("payments", "view");
  const id = Number((await params).id);
  const r = Number.isSafeInteger(id) ? await getReceipt(id) : undefined;
  if (!r) notFound();
  const [files, names, people, money] = await Promise.all([
    listAttachments("receipt", id),
    db.select({ id: customers.id, name: customers.name }).from(customers),
    db.select({ id: users.id, name: users.name }).from(users),
    db.select({ id: accounts.id, name: accounts.name }).from(accounts),
  ]);
  const c = r.customer;
  const active = r.status === "active";
  const isOwner = can(user, "approvals", "approve");
  /** An invoice, a job the money is an advance for (S12), a print job (D64), or a refund JV that paid it back (D55). */
  const target = (l: { invoiceId: number | null; debitNoteId: number | null; jobId: number | null; printJobId: number | null; refundId: number | null; number: string }) => {
    const [href, area] =
      l.jobId !== null
        ? [`/jobs/${l.jobId}`, "jobs" as const]
        : l.printJobId !== null
          ? [`/print-jobs/${l.printJobId}`, "printJobs" as const]
          : l.refundId !== null
          ? [`/journal-vouchers/${l.refundId}`, "books" as const]
          : l.debitNoteId !== null
            ? [`/credit-debit-notes/dn/${l.debitNoteId}`, "invoices" as const]
            : [`/invoices/${l.invoiceId}`, "invoices" as const];
    const number = can(user, area, "view") ? (
      <Link href={href} className="font-medium text-primary tabular-nums hover:underline">
        {l.number}
      </Link>
    ) : (
      <span className="font-medium tabular-nums">{l.number}</span>
    );
    return l.jobId !== null ? (
      <>Advance for job {number}</>
    ) : l.printJobId !== null ? (
      <>Print job {number}</>
    ) : l.refundId !== null ? (
      <>Paid back on {number}</>
    ) : (
      number
    );
  };

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/receipts", label: "Receipts" }}
        title={r.number}
        status={active ? undefined : "Cancelled"}
        description={`${c.firmName ? `${c.name} · ${c.firmName}` : c.name} · ${RECEIPT_MODE[r.mode]}`}
      />
      {active && (
        <div className="flex flex-wrap gap-2">
          {can(user, "payments", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/receipts/${id}/edit`}>Edit</Link>
            </Button>
          )}
          {can(user, "payments", "cancel") && (
            <ActionDialog
              action={cancelReceiptAction.bind(null, id)}
              label="Cancel"
              title={`Cancel ${r.number}?`}
              description={
                <>
                  The entry is reversed on the receipt date ({formatDate(r.date)}), the number stays and the invoices it paid
                  are open again.
                  {!isOwner && " This goes to the owner for approval."}
                </>
              }
              confirmLabel="Cancel receipt"
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
              ["Date", <DateText key="d" date={r.date} />],
              [
                "Customer",
                can(user, "customers", "view") ? (
                  <Link key="c" href={`/customers/${c.id}`} className="text-primary hover:underline">
                    {c.firmName ? `${c.name}\n${c.firmName}` : c.name}
                  </Link>
                ) : (
                  c.name
                ),
              ],
              ["Amount", <Money key="a" paise={r.amountPaise} />],
              ["Into account", `${r.account} (${RECEIPT_MODE[r.mode]})`],
              ["Cheque", r.chequeNo ? `No ${r.chequeNo}${r.chequeDate ? ` · dated ${formatDate(r.chequeDate)}` : ""}` : null],
              ["Reference", r.reference],
              ["Received by", r.receivedByName],
              ["Notes", r.notes],
            ]}
          />

          <section className="overflow-x-auto rounded-lg border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-medium">Allocation</h2>
            <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Paid towards</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>Document total</th>
                  <th className={`${th} text-right`}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td className={td}>{target(l)}</td>
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
                    <td className={td} colSpan={3}>
                      On account (advance)
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={r.onAccount} />
                    </td>
                  </tr>
                )}
                {r.removed.map((l) => (
                  <tr key={l.id} className="text-muted-foreground">
                    <td className={td}>
                      <span className="line-through">{l.number}</span> · removed <DateText at={l.changedAt} />
                    </td>
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
            entityType="receipt"
            entityId={id}
            items={files}
            canUpload={canAttach(user, "receipt", "edit")}
            defaultKind={r.mode === "cheque" ? "cheque" : "payment_screenshot"}
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="receipts"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              customer_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              money_account_id: (v) => money.find((m) => m.id === v)?.name ?? String(v),
              received_by: (v) => people.find((p) => p.id === v)?.name ?? String(v),
              mode: (v) => RECEIPT_MODE[v as ReceiptMode] ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
