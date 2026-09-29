import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { listRequests, REQUEST_STATUS } from "@/lib/material-requests";
import { can } from "@/lib/permissions";
import { RequestsTable } from "./requests-table";

export default async function MaterialRequestsPage() {
  const user = await requirePermission("materialRequests", "view");
  const rows = await listRequests();
  const newButton = can(user, "materialRequests", "create") ? (
    <Button asChild>
      <Link href="/material-requests/new">New request</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Material requests"
        description="What the workshop needs. The owner approves; a purchase order is made from approved ones."
        action={newButton}
      />
      <RequestsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          neededBy: r.neededBy,
          job: r.job ?? "",
          requestedBy: r.requestedBy ?? "",
          items: r.items,
          status: REQUEST_STATUS[r.status],
        }))}
        newButton={newButton}
      />
    </div>
  );
}
