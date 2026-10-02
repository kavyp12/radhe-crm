import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { milliText } from "@/lib/num";
import { can, canViewCost } from "@/lib/permissions";
import { getPrintJob, printThumbnail } from "@/lib/print-jobs";
import { printJobPayments } from "@/lib/receipts";
import { cancelPrintJobAction } from "../actions";

const LABELS = {
  number: "Number",
  customer_id: "Customer",
  job_id: "Job",
  mode: "Mode",
  file_name: "File",
  file_path: "File location",
  machine_id: "Machine",
  printing_type_id: "Printing type",
  width_milli: "Width (ft, thousandths)",
  height_milli: "Height (ft, thousandths)",
  qty_milli: "Qty (thousandths)",
  sqft_milli: "Sq ft (thousandths)",
  rate_paise: "Rate per sq ft",
  amount_paise: "Amount",
  operator_user_id: "Operator",
  printed_at: "Printed at",
  reprint_of_id: "Reprint of",
  status: "Status",
  notes: "Notes",
};

const link = (href: string, text: string, allowed: boolean) =>
  allowed ? (
    <Link href={href} className="font-medium text-primary tabular-nums hover:underline">
      {text}
    </Link>
  ) : (
    <span className="tabular-nums">{text}</span>
  );

export default async function PrintJobPage({ params }: PageProps<"/print-jobs/[id]">) {
  const user = await requirePermission("printJobs", "view");
  const id = Number((await params).id);
  const pj = await getPrintJob(user, id);
  if (!pj) notFound();
  const m = pj.money; // null for production (no money, A§8)
  const [payments, thumbnail] = await Promise.all([m && pj.mode === "sale" ? printJobPayments(id) : [], printThumbnail(id)]);
  const active = pj.status === "active";
  const unbilled = active && !m?.invoice;
  const sale = pj.mode === "sale";
  // Rate and amount of a print on a job are its cost (hard rule 5); production sees no money at all.
  const hideMoney = !can(user, "printJobs", "money") || (!sale && !canViewCost(user)) ? ["rate_paise", "amount_paise"] : [];

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/print-jobs", label: "Print jobs" }}
        title={pj.number}
        status={m ? m.payment : active ? undefined : "Cancelled"}
        description={[pj.firmName ? `${pj.customer} · ${pj.firmName}` : pj.customer, pj.fileName].join(" · ")}
      />
      <div className="flex flex-wrap gap-2">
        {unbilled && sale && m && m.balance !== null && m.balance > 0n && can(user, "payments", "create") && (
          <Button asChild>
            <Link href={`/receipts/new?customer=${pj.customerId}&printJob=${id}`}>Record payment</Link>
          </Button>
        )}
        {unbilled && sale && can(user, "invoices", "create") && can(user, "printJobs", "edit") && (
          <Button asChild variant="outline">
            <Link href={`/print-jobs/unbilled?customer=${pj.customerId}&pick=${id}`}>Bill</Link>
          </Button>
        )}
        {pj.filePath && (
          // P7: the print agent opens it (T41), only under its file roots and only design / image / PDF files.
          <Button asChild variant="outline">
            <a href={`radhe-crm://open?path=${encodeURIComponent(pj.filePath)}`}>Open file</a>
          </Button>
        )}
        {can(user, "printJobs", "create") && (
          <Button asChild variant="outline">
            <Link href={`/print-jobs/new?reprint=${id}`}>Reprint</Link>
          </Button>
        )}
        {unbilled && can(user, "printJobs", "edit") && (
          <Button asChild variant="outline">
            <Link href={`/print-jobs/${id}/edit`}>Edit</Link>
          </Button>
        )}
        {unbilled && can(user, "printJobs", "cancel") && (
          <ActionDialog
            action={cancelPrintJobAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${pj.number}?`}
            description="It stays in the list as cancelled (with its history). Money taken for it goes on account for the customer."
            confirmLabel="Cancel print job"
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
          {pj.filePath && (
            <p className="text-xs text-muted-foreground">
              Open file works on a Radhe PC with the print agent installed; on other devices the button does nothing.
            </p>
          )}
          {thumbnail && (
            <figure className="w-fit rounded-lg border bg-card p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- auth-checked file route */}
              <img src={`/api/files/${thumbnail.id}`} alt={`Preview of ${pj.fileName}`} className="max-h-64 max-w-full rounded object-contain" />
            </figure>
          )}
          <DocFacts
            facts={[
              ["Printed", formatDateTime(pj.printedAt)],
              ["Customer", link(`/customers/${pj.customerId}`, pj.customer, can(user, "customers", "view"))],
              ["Job", pj.job ? link(`/jobs/${pj.jobId}`, `${pj.job} (cost to the job)`, can(user, "jobs", "view")) : "New (sale)"],
              ["Operator", pj.operator],
              ["File", pj.fileName],
              ["File location", pj.filePath],
              ["Machine", pj.machine],
              ["Printing type", pj.type],
              ["Size", `${milliText(pj.widthMilli)} × ${milliText(pj.heightMilli)} ft`],
              ["Qty", milliText(pj.qtyMilli)],
              ["Sq ft", milliText(pj.sqftMilli)],
              ["Reprint of", pj.reprintOf ? link(`/print-jobs/${pj.reprintOfId}`, pj.reprintOf, true) : null],
              ...(pj.costPending
                ? ([["Cost to the job", <span key="cp" className="text-amber-700">Pending: {pj.machine} has no cost rate yet</span>]] as [string, React.ReactNode][])
                : []),
              ...(pj.ratePaise !== null && pj.amountPaise !== null
                ? ([
                    [sale ? "Rate per sq ft" : "Cost rate per sq ft", <Money key="r" paise={pj.ratePaise} />],
                    [sale ? "Amount" : "Cost to the job", <Money key="a" paise={pj.amountPaise} />],
                  ] as [string, React.ReactNode][])
                : []),
              ...(m && sale
                ? ([
                    ["Received", <Money key="rc" paise={m.received} />],
                    ["Balance", m.balance === null ? "On the invoice" : <Money key="b" paise={m.balance} />],
                    ["Invoice", m.invoice ? link(`/invoices/${m.invoice.id}`, m.invoice.number ?? "Draft", can(user, "invoices", "view")) : "Not billed yet"],
                  ] as [string, React.ReactNode][])
                : []),
              ["Notes", pj.notes],
            ]}
          />
          {payments.length > 0 && (
            <section aria-label="Payments" className="overflow-x-auto rounded-lg border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-medium">Money for this print</h2>
              </div>
              <table className="w-full min-w-96 border-separate border-spacing-0 text-[13px]">
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={i}>
                      <td className="border-b px-4 py-2">{link(p.href, p.number, can(user, "payments", "view"))}</td>
                      <td className="border-b px-4 py-2">
                        <DateText date={p.date} />
                      </td>
                      <td className="border-b px-4 py-2 text-right">
                        <Money paise={p.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {pj.reprints.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Reprinted as{" "}
              {pj.reprints.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ", "}
                  {link(`/print-jobs/${r.id}`, r.number, true)}
                </span>
              ))}
              .
            </p>
          )}
        </TabsContent>

        <TabsContent value="history">
          <History table="print_jobs" rowId={id} labels={LABELS} hide={hideMoney} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
