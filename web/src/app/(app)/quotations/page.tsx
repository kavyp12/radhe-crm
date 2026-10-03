import Link from "next/link";
import { ListPeriod } from "@/components/list-period";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listQuotations, QUOTATION_STATUS } from "@/lib/quotations";
import { listPeriod } from "@/lib/statements";
import { QuotationsTable } from "./quotations-table";

export default async function QuotationsPage({ searchParams }: PageProps<"/quotations">) {
  const user = await requirePermission("quotations", "view");
  const period = listPeriod(await searchParams);
  const rows = await listQuotations(period.range);
  const newButton = can(user, "quotations", "create") ? (
    <Button asChild>
      <Link href="/quotations/new">New quotation</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Quotations" action={newButton} />
      <ListPeriod {...period} />
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
