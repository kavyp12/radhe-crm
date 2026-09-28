import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { listCustomers } from "@/lib/customers";
import { can } from "@/lib/permissions";
import { CustomersTable } from "./customers-table";

export default async function CustomersPage() {
  const user = await requirePermission("customers", "view");
  const rows = await listCustomers();
  const newButton = can(user, "customers", "create") ? (
    <Button asChild>
      <Link href="/customers/new">New customer</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Customers" description="Outstanding = what each customer owes, from the books." action={newButton} />
      <CustomersTable
        rows={rows.map((r) => ({ ...r, firmName: r.firmName ?? "", mobile: r.mobile ?? "", gstin: r.gstin ?? "" }))}
        newButton={newButton}
      />
    </div>
  );
}
