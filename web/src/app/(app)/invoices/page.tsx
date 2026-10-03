import Link from "next/link";
import { ListPeriod } from "@/components/list-period";
import { PageHeader } from "@/components/page-header";
import { ExportExcelButton } from "@/components/report-actions";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { INVOICE_KIND, INVOICE_STATUS, listInvoices } from "@/lib/invoices";
import { can } from "@/lib/permissions";
import { listPeriod } from "@/lib/statements";
import { InvoicesTable } from "./invoices-table";

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const user = await requirePermission("invoices", "view");
  const period = listPeriod(await searchParams);
  const rows = await listInvoices(period.range);
  const create = can(user, "invoices", "create");
  const newButton = create ? (
    <Button asChild>
      <Link href="/invoices/new">New invoice</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Invoices"
        description="Tax invoices and estimates. Payment status comes from the receipts allocated to them."
        action={
          <div className="flex gap-2">
            <ExportExcelButton name="invoices" query={period.query} />
            {create && (
              <>
                <Button asChild variant="outline">
                  <Link href="/invoices/new/from">Bill jobs</Link>
                </Button>
                {newButton}
              </>
            )}
          </div>
        }
      />
      <ListPeriod {...period} />
      <InvoicesTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number ?? "Draft",
          kind: INVOICE_KIND[r.kind],
          date: r.date,
          dueDate: r.dueDate,
          customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
          status: INVOICE_STATUS[r.status],
          payment: r.payment,
          total: r.total,
          open: r.open,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
