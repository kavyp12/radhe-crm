import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionButton, ActionDialog } from "@/components/doc-actions";
import { DocLines } from "@/components/doc-lines";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { canAttach, listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { getJob, JOB_STATUS, type JobStatus } from "@/lib/jobs";
import { can } from "@/lib/permissions";
import { jobsOnInvoices } from "@/lib/sales";
import { invoiceJobAction } from "../../invoices/actions";
import { cancelJobAction } from "../actions";
import { StatusButtons } from "../status-buttons";

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
  const [files, people, [invoice]] = await Promise.all([
    listAttachments("job", id),
    db.select({ id: users.id, name: users.name }).from(users),
    jobsOnInvoices(db, [id]),
  ]);
  const open = job.status !== "invoiced" && job.status !== "cancelled";
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
