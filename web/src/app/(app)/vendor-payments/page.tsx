import Link from "next/link";
import { ListPeriod } from "@/components/list-period";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { listVendorPayments } from "@/lib/vendor-payments";
import { listPeriod } from "@/lib/statements";
import { PaymentsTable } from "./payments-table";

export default async function VendorPaymentsPage({ searchParams }: PageProps<"/vendor-payments">) {
  const user = await requirePermission("payments", "view");
  const period = listPeriod(await searchParams);
  const rows = await listVendorPayments(period.range);
  const newButton = can(user, "payments", "create") ? (
    <Button asChild>
      <Link href="/vendor-payments/new">New payment</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Vendor payments" description="Money paid to vendors, and the bills it paid. What isn't allocated is on account." action={newButton} />
      <ListPeriod {...period} />
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
