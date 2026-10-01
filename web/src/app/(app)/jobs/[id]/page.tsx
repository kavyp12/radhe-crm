import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionButton, ActionDialog } from "@/components/doc-actions";
import { DocLines } from "@/components/doc-lines";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { canAttach, listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { creditWarning } from "@/lib/invoices";
import { canEnterJobCost, jobCosting } from "@/lib/job-costing";
import { getJob, JOB_STATUS, type JobStatus } from "@/lib/jobs";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { jobAdvances } from "@/lib/receipts";
import { jobsOnInvoices } from "@/lib/sales";
import { ISSUE_KIND, listStockIssues } from "@/lib/stock-issues";
import { invoiceJobAction } from "../../invoices/actions";
import { cancelJobAction } from "../actions";
import { StatusButtons } from "../status-buttons";
import { JobPnl } from "./job-pnl";

const LABELS = {
  number: "Job no",
  date: "Date",
  status: "Status",
  site_address: "Site address",
  site_reference: "Site reference",
  vehicle_no: "Vehicle no",
  sales_person_id: "Sales person",
  target_date: "Target date",
  total_paise: "Total",
  notes: "Notes",
};

export default async function JobPage({ params }: PageProps<"/jobs/[id]">) {
  const user = await requirePermission("jobs", "view");
  const id = Number((await params).id);
  const job = Number.isSafeInteger(id) ? await getJob(user, id) : undefined;
  if (!job) notFound();
  const materials = can(user, "stockIssue", "view");
  const open = job.status !== "invoiced" && job.status !== "cancelled";
  const [files, people, [invoice], advances, issues, pnl, warning] = await Promise.all([
    listAttachments("job", id),
    db.select({ id: users.id, name: users.name }).from(users),
    jobsOnInvoices(db, [id]),
    // Advances are money: only for users who may see it (never production).
    job.money ? jobAdvances(id) : [],
    // Issues / returns (T21): values only for can_view_cost users (the loader strips them).
    materials ? listStockIssues(user, id) : [],
    // Job P&L (T27): undefined unless the user has can_view_cost and may see the job's money (stripped in the loader).
    jobCosting(user, id),
    // S25: credit limit with this job added — a warning from job create until it's invoiced (never a block).
    open && job.money ? creditWarning(job.customerId, job.totals.total) : null,
  ]);
  const overdue = open && job.status !== "delivered" && !!job.targetDate && job.targetDate < todayIST();
  // Money only reaches this page for users who may see it (getJob leaves it out otherwise).
  const priced = job.money ? job : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/jobs", label: "Jobs" }}
        title={job.number}
        status={JOB_STATUS[job.status]}
        description={job.firmName ? `${job.customer} · ${job.firmName}` : job.customer}
      />
      <div className="flex flex-wrap gap-2">
        {can(user, "jobs", "status") && <StatusButtons id={id} status={job.status} />}
        {invoice && can(user, "invoices", "view") && (
          <Button asChild variant="outline">
            <Link href={`/invoices/${invoice.invoiceId}`}>{invoice.number ? `Invoice ${invoice.number}` : "Draft invoice"}</Link>
          </Button>
        )}
        {open && job.money && can(user, "payments", "create") && (
          <Button asChild variant="outline">
            <Link href={`/receipts/new?customer=${job.customerId}&job=${id}`}>Record advance</Link>
          </Button>
        )}
        {!invoice && open && can(user, "invoices", "create") && (
          <ActionButton action={invoiceJobAction.bind(null, id)} label="Create invoice" done="Draft created." />
        )}
        {can(user, "jobs", "edit") && open && (
          <Button asChild variant="outline">
            <Link href={`/jobs/${id}/edit`}>Edit</Link>
          </Button>
        )}
        {can(user, "jobs", "cancel") && open && (
          <ActionDialog
            action={cancelJobAction.bind(null, id)}
            label="Cancel job"
            title={`Cancel ${job.number}?`}
            description="It stays on record, marked Cancelled. An invoiced job can't be cancelled."
            confirmLabel="Cancel job"
            done="Job cancelled."
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
          <TabsTrigger value="status">Status history</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Job date", <DateText key="d" date={job.date} />],
              [
                "Target date",
                job.targetDate ? (
                  <span key="t" className={overdue ? "font-medium text-red-700" : undefined}>
                    <DateText date={job.targetDate} />
                    {overdue && " · overdue"}
                  </span>
                ) : null,
              ],
              ["Customer", job.firmName ? `${job.customer}\n${job.firmName}` : job.customer],
              ["Mobile", job.mobile],
              ["Site address", job.siteAddress],
              ["Site reference", job.siteReference],
              ["Vehicle no", job.vehicleNo],
              ["Sales person", job.salesPerson],
              [
                "Quotation",
                job.quotation && can(user, "quotations", "view") ? (
                  <Link key="q" href={`/quotations/${job.quotationId}`} className="text-primary hover:underline">
                    {job.quotation}
                  </Link>
                ) : (
                  job.quotation
                ),
              ],
              ["Notes", job.notes],
            ]}
          />
          <DocLines lines={job.lines} totals={priced?.totals} mode={priced?.mode} />
          {pnl && <JobPnl jobId={id} card={pnl} canEnter={canEnterJobCost(user) && job.status !== "cancelled"} />}
          {advances.length > 0 && (
            <section className="overflow-x-auto rounded-lg border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-medium">
                Advance received · <Money paise={advances.reduce((s, a) => s + a.amount, 0n)} />
                <span className="ml-2 text-xs font-normal text-muted-foreground">Adjusted on the invoice when it is issued.</span>
              </h2>
              <table className="w-full min-w-100 text-[13px]">
                <tbody>
                  {advances.map((a) => (
                    <tr key={a.href}>
                      <td className="border-b px-4 py-2 font-medium tabular-nums">
                        {can(user, "payments", "view") ? (
                          <Link href={a.href} className="text-primary hover:underline">
                            {a.number}
                          </Link>
                        ) : (
                          a.number
                        )}
                      </td>
                      <td className="border-b px-4 py-2">
                        <DateText date={a.date} />
                      </td>
                      <td className="border-b px-4 py-2">{a.mode ? RECEIPT_MODE[a.mode] : "Credit note"}</td>
                      <td className="border-b px-4 py-2 text-right">
                        <Money paise={a.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {materials && (
            <section aria-label="Materials" className="overflow-x-auto rounded-lg border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <h2 className="text-sm font-medium">
                  Materials issued
                  {issues.some((i) => "cost" in i) && (
                    <>
                      {" · "}
                      <Money
                        paise={issues.reduce(
                          (s, i) => s + ("cost" in i && i.status === "active" ? (i.kind === "issue" ? i.cost.value : -i.cost.value) : 0n),
                          0n,
                        )}
                      />
                    </>
                  )}
                </h2>
                {can(user, "stockIssue", "create") && (
                  <div className="flex gap-2">
                    {job.status !== "cancelled" && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/issue-to-job/new?job=${id}`}>Issue stock</Link>
                      </Button>
                    )}
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/issue-to-job/new?job=${id}&kind=return`}>Return stock</Link>
                    </Button>
                  </div>
                )}
              </div>
              {issues.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">No stock issued to this job yet.</p>
              ) : (
                <table className="w-full min-w-120 text-[13px]">
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id} className={i.status === "cancelled" ? "text-muted-foreground" : undefined}>
                        <td className="border-b px-4 py-2 whitespace-nowrap">
                          <Link href={`/issue-to-job/${i.id}`} className="text-primary hover:underline">
                            <DocNumber number={i.number} status={i.status === "cancelled" ? "Cancelled" : undefined} />
                          </Link>
                        </td>
                        <td className="border-b px-4 py-2">
                          <DateText date={i.date} />
                        </td>
                        <td className="border-b px-4 py-2">{ISSUE_KIND[i.kind]}</td>
                        <td className="border-b px-4 py-2">{i.items}</td>
                        {"cost" in i && (
                          <td className="border-b px-4 py-2 text-right">
                            <Money paise={i.kind === "issue" ? i.cost.value : -i.cost.value} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </TabsContent>

        <TabsContent value="status">
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="h-9 border-b px-3 font-medium">Status</th>
                  <th className="h-9 border-b px-3 font-medium">By</th>
                  <th className="h-9 border-b px-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {job.history.map((h, i) => (
                  <tr key={i}>
                    <td className="border-b px-3 py-2">
                      {h.from ? `${JOB_STATUS[h.from]} → ` : "Created · "}
                      {JOB_STATUS[h.to]}
                    </td>
                    <td className="border-b px-3 py-2">{h.by}</td>
                    <td className="border-b px-3 py-2">
                      <DateText at={h.at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="job"
            entityId={id}
            items={files}
            canUpload={canAttach(user, "job", "edit")}
            defaultKind="installation_photo"
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="jobs"
            rowId={id}
            labels={LABELS}
            // Production never sees money, not even in the audit trail.
            hide={["created_by", "customer_id", "quotation_id", "place_of_supply", ...(priced ? [] : ["total_paise"])]}
            display={{
              status: (v) => JOB_STATUS[v as JobStatus] ?? String(v),
              sales_person_id: (v) => people.find((p) => p.id === v)?.name ?? String(v),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
