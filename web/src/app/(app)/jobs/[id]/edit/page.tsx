import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { staffOptions } from "@/lib/customers";
import { getJob } from "@/lib/jobs";
import { lineText } from "@/lib/lines";
import { salesFormOptions } from "@/lib/sales";
import { updateJobAction } from "../../actions";
import { JobForm } from "../../job-form";

/** Owner: fields and lines until the job is invoiced (A§8). */
export default async function EditJobPage({ params }: PageProps<"/jobs/[id]/edit">) {
  const user = await requirePermission("jobs", "edit");
  const id = Number((await params).id);
  const job = Number.isSafeInteger(id) ? await getJob(user, id) : undefined;
  if (!job?.money) notFound();
  if (job.status === "invoiced" || job.status === "cancelled") redirect(`/jobs/${id}`);
  const [options, staff] = await Promise.all([
    salesFormOptions({ customerId: job.customerId, categoryIds: job.lines.map((l) => l.categoryId) }),
    staffOptions(),
  ]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: `/jobs/${id}`, label: job.number }} title={`Edit ${job.number}`} />
      <JobForm
        values={{
          customerId: String(job.customerId),
          date: job.date,
          targetDate: job.targetDate ?? "",
          salesPersonId: job.salesPersonId ?? "",
          siteAddress: job.siteAddress ?? "",
          siteReference: job.siteReference ?? "",
          vehicleNo: job.vehicleNo ?? "",
          notes: job.notes ?? "",
          lines: job.lines.map(lineText),
        }}
        {...options}
        staff={staff}
        customerLocked
        submitLabel="Save changes"
        action={updateJobAction.bind(null, id)}
      />
    </div>
  );
}
