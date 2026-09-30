import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listTransfers } from "@/lib/transfers";
import { TransfersTable } from "./transfers-table";

export default async function TransfersPage() {
  const user = await requirePermission("books", "view");
  const rows = await listTransfers();
  const newButton = can(user, "books", "create") ? (
    <Button asChild>
      <Link href="/cash-bank/transfers/new">New transfer</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/cash-bank", label: "Cash & Bank" }}
        title="Transfers"
        description="Money moved between cash, UPI and the banks."
        action={newButton}
      />
      <TransfersTable
        rows={rows.map((r) => ({ ...r, reference: r.reference ?? "", status: r.status === "cancelled" ? "Cancelled" : "Active" }))}
        newButton={newButton}
      />
    </div>
  );
}
