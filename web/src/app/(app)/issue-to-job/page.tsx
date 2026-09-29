import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can, canViewCost } from "@/lib/permissions";
import { ISSUE_KIND, listStockIssues } from "@/lib/stock-issues";
import { IssuesTable } from "./issues-table";

// Owner / accountant / production (qty only: the loader leaves values out without can_view_cost).
export default async function IssueToJobPage() {
  const user = await requirePermission("stockIssue", "view");
  const rows = await listStockIssues(user);
  const cost = canViewCost(user);
  const newButton = can(user, "stockIssue", "create") ? (
    <Button asChild>
      <Link href="/issue-to-job/new">Issue to job</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Issue to job"
        description={cost ? "Materials out of stock to a job at the average cost, and back from it." : "Materials out of stock to a job, and back from it."}
        action={
          newButton && (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/issue-to-job/new?kind=return">Return from job</Link>
              </Button>
              {newButton}
            </div>
          )
        }
      />
      <IssuesTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          kind: ISSUE_KIND[r.kind],
          job: r.job,
          customer: r.customer,
          items: r.items,
          status: r.status === "cancelled" ? "Cancelled" : "Active",
          value: "cost" in r ? r.cost.value : undefined,
        }))}
        cost={cost}
        newButton={newButton}
      />
    </div>
  );
}
