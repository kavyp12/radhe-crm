import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { listVendorPayments } from "@/lib/vendor-payments";
import { PaymentsTable } from "./payments-table";

export default async function VendorPaymentsPage() {
  const user = await requirePermission("payments", "view");
  const rows = await listVendorPayments();
  const newButton = can(user, "payments", "create") ? (
    <Button asChild>
      <Link href="/vendor-payments/new">New payment</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Vendor payments" description="Money paid to vendors, and the bills it paid. What isn't allocated is on account." action={newButton} />
      <PaymentsTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          vendor: r.vendor,
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
