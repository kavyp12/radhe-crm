import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listVendors } from "@/lib/vendors";
import { VendorsTable } from "./vendors-table";

export default async function VendorsPage() {
  const user = await requirePermission("vendors", "view");
  const rows = await listVendors();
  const newButton = can(user, "vendors", "create") ? (
    <Button asChild>
      <Link href="/vendors/new">New vendor</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Vendors" description="Suppliers. We owe = what we still have to pay each one, from the books." action={newButton} />
      <VendorsTable rows={rows.map((r) => ({ ...r, mobile: r.mobile ?? "", gstin: r.gstin ?? "" }))} newButton={newButton} />
    </div>
  );
}
