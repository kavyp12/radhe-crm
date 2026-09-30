import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts, DocShare } from "@/components/doc-share";
import { History } from "@/components/history";
import { TotalsPanel } from "@/components/line-items";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import type { Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { sizeText } from "@/lib/lines";
import { getNote, kindOfPath, NOTE_KIND, NOTE_STATUS, type NoteStatus } from "@/lib/notes";
import { amountInWords, bpText, milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { ADJUSTMENT_KIND } from "@/lib/adjustments";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { debitNotePayments } from "@/lib/receipts";
import { getSettings } from "@/lib/settings";
import { shareMessage, shareUrl, whatsappLink } from "@/lib/share";
import { cancelNoteAction, emailNoteAction, issueNoteAction } from "../../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  reason: "Reason",
  status: "Status",
  due_date: "Due date",
  total_paise: "Total",
  notes: "Notes",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 align-top";

export default async function NotePage({ params }: PageProps<"/credit-debit-notes/[kind]/[id]">) {
  const user = await requirePermission("invoices", "view");
  const { kind: path, id: raw } = await params;
  const kind = kindOfPath(path);
  const id = Number(raw);
  const note = kind && Number.isSafeInteger(id) ? await getNote(kind, id) : undefined;
  if (!kind || !note) notFound();
  const [settings, payments] = await Promise.all([getSettings(), kind === "debit" ? debitNotePayments(id) : []]);
  const { title: kindTitle } = NOTE_KIND[kind];
  const c = note.customer;
  const title = note.number ?? `Draft ${kindTitle.toLowerCase()}`;
  const isOwner = can(user, "approvals", "approve");
  const issued = note.status === "issued";
  const status: Status | Status[] = note.payment && issued ? [NOTE_STATUS[note.status], note.payment] : NOTE_STATUS[note.status];
  const message = shareMessage({
    what: `our ${kindTitle.toLowerCase()}`,
    number: title,
    name: c.name,
    total: note.totalPaise,
    link: shareUrl(note.shareToken),
    company: settings.companyName,
  });
  const gst = note.mode !== "estimate";

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/credit-debit-notes", label: "Credit/Debit Notes" }}
        title={title}
        status={status}
        description={`${kindTitle} · against ${note.invoice.number} · ${c.firmName ? `${c.name} · ${c.firmName}` : c.name}`}
      />
      <div className="flex flex-wrap gap-2">
        <DocShare
          pdfHref={`/credit-debit-notes/${path}/${id}/pdf`}
          whatsapp={note.status !== "draft" ? whatsappLink(c.mobile, message) : undefined}
          email={
            note.status !== "draft"
              ? {
                  action: emailNoteAction.bind(null, kind, id),
                  to: c.email ?? "",
                  subject: `${kindTitle} ${title}${settings.companyName ? ` from ${settings.companyName}` : ""}`,
                  message,
                }
              : undefined
          }
        />
        {note.status === "draft" && can(user, "invoices", "edit") && (
          <>
            <Button asChild variant="outline">
              <Link href={`/credit-debit-notes/${path}/${id}/edit`}>Edit</Link>
            </Button>
            <ActionDialog
              action={issueNoteAction.bind(null, kind, id)}
              label="Issue"
              title={`Issue this ${kindTitle.toLowerCase()}?`}
              description={
                kind === "credit" ? (
                  <>
                    It gets its number, is posted to the books and pays its invoice up to the open amount (any excess stays as
                    the customer&apos;s credit). It can&apos;t be edited after.
                    {!isOwner && " A credit note goes to the owner for approval first."}
                  </>
                ) : (
                  <>
                    It gets its number, is posted to the books and becomes a receivable of its own that receipts can pay. It
                    can&apos;t be edited after.{!isOwner && " An old date sends it to the owner for approval first."}
                  </>
                )
              }
              confirmLabel="Issue"
              done="Issued."
              variant="default"
            />
          </>
        )}
        {note.status !== "cancelled" && can(user, "invoices", "cancel") && (
          <ActionDialog
            action={cancelNoteAction.bind(null, kind, id)}
            label="Cancel"
            title={`Cancel ${title}?`}
            description={
              note.status === "draft" ? (
                "The draft stays on record, marked Cancelled."
              ) : (
                <>
                  The journal entry is reversed on the note date ({formatDate(note.date)}) and the number stays.{" "}
                  {kind === "credit" ? "The invoice's open amount goes back up." : "Payments on it go back on account."}
                  {!isOwner && " This goes to the owner for approval."}
                </>
              )
            }
            confirmLabel={`Cancel ${kindTitle.toLowerCase()}`}
            done="Cancelled."
            reason={issued}
            variant="destructive"
          />
        )}
        {kind === "debit" && issued && note.open > 0n && can(user, "payments", "create") && (
          <Button asChild>
            <Link href={`/receipts/new?customer=${note.customerId}`}>Record payment</Link>
          </Button>
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
              ["Date", <DateText key="d" date={note.date} />],
              [
                "Against invoice",
                <Link key="i" href={`/invoices/${note.invoiceId}`} className="text-primary hover:underline">
                  {note.invoice.number} · {formatDate(note.invoice.date)}
                </Link>,
              ],
              ["Customer", c.firmName ? `${c.name}\n${c.firmName}` : c.name],
              ["Reason", note.reason],
              ...(kind === "debit"
                ? ([
                    ["Due date", note.dueDate ? <DateText key="due" date={note.dueDate} /> : null],
                    ["Received / open", issued ? <span key="o"><Money paise={note.paid} /> / <Money paise={note.open} /></span> : null],
                  ] as [string, React.ReactNode][])
                : ([
                    ["Applied (invoices / jobs)", issued ? <Money key="p" paise={note.paid} /> : null],
                    ["Customer credit", issued ? <Money key="c" paise={note.open} /> : null],
                  ] as [string, React.ReactNode][])),
              ["Notes", note.notes],
            ]}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} w-8 text-right`}>#</th>
                    <th className={th}>Item</th>
                    <th className={th}>HSN/SAC</th>
                    <th className={`${th} text-right`}>Qty</th>
                    <th className={`${th} text-right`}>Taxable</th>
                    {gst && <th className={`${th} text-right`}>GST %</th>}
                    {gst && <th className={`${th} text-right`}>GST</th>}
                  </tr>
                </thead>
                <tbody>
                  {note.lines.map((l, i) => {
                    const t = note.totals.lines[i];
                    return (
                      <tr key={l.id}>
                        <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.invoicePosition}</td>
                        <td className={td}>
                          <div className="font-medium">{l.description ?? l.category}</div>
                          <div className="text-xs text-muted-foreground">
                            {[l.description && l.category, sizeText(l.widthMilli, l.heightMilli)].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className={`${td} tabular-nums`}>{l.hsnSac ?? "—"}</td>
                        <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                          {l.qtyMilli === null ? "—" : `${milliText(l.qtyMilli)} ${l.unit}`}
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={t.taxable} />
                        </td>
                        {gst && <td className={`${td} text-right tabular-nums`}>{bpText(l.gstBp)}</td>}
                        {gst && (
                          <td className={`${td} text-right`}>
                            <Money paise={t.cgst + t.sgst + t.igst} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TotalsPanel
              rows={[
                { label: gst ? "Taxable value" : "Sub total", paise: note.totals.taxable },
                ...(note.mode === "same_state"
                  ? [
                      { label: "CGST", paise: note.totals.cgst },
                      { label: "SGST", paise: note.totals.sgst },
                    ]
                  : note.mode === "other_state"
                    ? [{ label: "IGST", paise: note.totals.igst }]
                    : []),
              ]}
              total={note.totals.total}
              words={amountInWords(note.totals.total)}
            />
          </div>
          {payments.length > 0 && (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-100 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Paid by</th>
                    <th className={th}>Date</th>
                    <th className={th}>Mode</th>
                    <th className={`${th} text-right`}>Allocated here</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.href}>
                      <td className={`${td} font-medium tabular-nums`}>
                        {can(user, "payments", "view") ? (
                          <Link href={p.href} className="text-primary hover:underline">
                            {p.number}
                          </Link>
                        ) : (
                          p.number
                        )}
                      </td>
                      <td className={td}>
                        <DateText date={p.date} />
                      </td>
                      <td className={td}>{p.mode ? RECEIPT_MODE[p.mode] : p.kind ? ADJUSTMENT_KIND[p.kind] : "Credit note"}</td>
                      <td className={`${td} text-right`}>
                        <Money paise={p.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history">
          <History
            table={NOTE_KIND[kind].docType}
            rowId={id}
            labels={LABELS}
            hide={["created_by", "share_token", "invoice_id", "customer_id"]}
            display={{ status: (v) => NOTE_STATUS[v as NoteStatus] ?? String(v) }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
