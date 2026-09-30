import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ADJUSTMENT_KIND, listAdjustments } from "@/lib/adjustments";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { JournalTable } from "./journal-table";

export default async function JournalVouchersPage() {
  const user = await requirePermission("books", "view");
  const rows = await listAdjustments();
  const newButton = can(user, "books", "create") ? (
    <Button asChild>
      <Link href="/journal-vouchers/new">New journal voucher</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Journal vouchers"
        description="Corrections posted straight to the books, and customer write-offs, discounts and refunds. Anyone but the owner needs approval."
        action={newButton}
      />
      <JournalTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          kind: ADJUSTMENT_KIND[r.kind],
          customer: r.customer ?? "",
          narration: r.narration,
          status: r.status === "cancelled" ? "Cancelled" : "Active",
          amount: r.amount,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
