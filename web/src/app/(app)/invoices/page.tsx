import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { INVOICE_KIND, INVOICE_STATUS, listInvoices } from "@/lib/invoices";
import { can } from "@/lib/permissions";
import { InvoicesTable } from "./invoices-table";

export default async function InvoicesPage() {
  const user = await requirePermission("invoices", "view");
  const rows = await listInvoices();
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
          create && (
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/invoices/new/from">Bill jobs</Link>
              </Button>
              {newButton}
            </div>
          )
        }
      />
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
