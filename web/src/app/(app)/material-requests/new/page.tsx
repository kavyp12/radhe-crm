import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { issueFormOptions } from "@/lib/stock-issues";
import { createRequestAction } from "../actions";
import { RequestForm } from "../request-form";

/** ?job= picks the job (from its page). */
export default async function NewRequestPage({ searchParams }: PageProps<"/material-requests/new">) {
  const user = await requirePermission("materialRequests", "create");
  const { job } = await searchParams;
  const options = await issueFormOptions(user); // items with qty only, jobs
  const jobs = options.jobs.filter((j) => !j.cancelled);
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/material-requests", label: "Material requests" }} title="New material request" />
      <RequestForm
        items={options.items}
        jobs={jobs}
        jobId={jobs.some((j) => String(j.id) === job) ? String(job) : ""}
        today={todayIST()}
        action={createRequestAction}
      />
    </div>
  );
}
