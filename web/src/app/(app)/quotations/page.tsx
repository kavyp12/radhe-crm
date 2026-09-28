import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listQuotations, QUOTATION_STATUS } from "@/lib/quotations";
import { QuotationsTable } from "./quotations-table";

export default async function QuotationsPage() {
  const user = await requirePermission("quotations", "view");
  const rows = await listQuotations();
  const newButton = can(user, "quotations", "create") ? (
    <Button asChild>
      <Link href="/quotations/new">New quotation</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Quotations" action={newButton} />
      <QuotationsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
          status: QUOTATION_STATUS[r.status],
          total: r.total,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
