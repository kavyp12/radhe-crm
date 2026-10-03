import Link from "next/link";
import { ListPeriod } from "@/components/list-period";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { JOB_STATUS, listJobs } from "@/lib/jobs";
import { can } from "@/lib/permissions";
import { listPeriod } from "@/lib/statements";
import { JobsTable } from "./jobs-table";

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requirePermission("jobs", "view");
  const period = listPeriod(await searchParams);
  const rows = await listJobs(user, period.range);
  const newButton = can(user, "jobs", "create") ? (
    <Button asChild>
      <Link href="/jobs/new">New job</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Jobs"
        action={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/jobs/board">Production board</Link>
            </Button>
            {newButton}
          </div>
        }
      />
      <ListPeriod {...period} />
      <JobsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
          status: JOB_STATUS[r.status],
          targetDate: r.targetDate ?? "",
          total: "total" in r ? r.total : undefined,
        }))}
        showMoney={can(user, "jobs", "money")}
        newButton={newButton}
      />
    </div>
  );
}
