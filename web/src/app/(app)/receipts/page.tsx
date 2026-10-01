import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ExportExcelButton } from "@/components/report-actions";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { listReceipts } from "@/lib/receipts";
import { ReceiptsTable } from "./receipts-table";

export default async function ReceiptsPage() {
  const user = await requirePermission("payments", "view");
  const rows = await listReceipts();
  const newButton = can(user, "payments", "create") ? (
    <Button asChild>
      <Link href="/receipts/new">New receipt</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Receipts"
        description="Money received from customers, and the invoices it paid. What isn't allocated is on account."
        action={
          <div className="flex gap-2">
            <ExportExcelButton name="receipts" />
            {newButton}
          </div>
        }
      />
      <ReceiptsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
          mode: RECEIPT_MODE[r.mode],
          status: r.status === "cancelled" ? "Cancelled" : "Active",
          amount: r.amount,
          allocated: r.allocated,
          onAccount: r.onAccount,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
