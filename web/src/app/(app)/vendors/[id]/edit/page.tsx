import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getVendor } from "@/lib/vendors";
import { updateVendorAction } from "../../actions";
import { VendorForm } from "../../vendor-form";

export default async function EditVendorPage({ params }: PageProps<"/vendors/[id]/edit">) {
  const user = await requirePermission("vendors", "edit");
  const id = Number((await params).id);
  const v = Number.isSafeInteger(id) ? await getVendor(id) : undefined;
  if (!v) notFound();

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: `/vendors/${id}`, label: v.name }} title="Edit vendor" />
      <VendorForm
        values={{
          name: v.name,
          gstin: v.gstin ?? "",
          stateCode: v.stateCode,
          mobile: v.mobile ?? "",
          address: v.address ?? "",
          creditDays: v.creditDays === null ? "" : String(v.creditDays),
          notes: v.notes ?? "",
          openingBalance: v.openingBalancePaise ? moneyText(v.openingBalancePaise) : "",
          active: v.active,
        }}
        canSetOpening={can(user, "openingBalances", "edit")}
        canDeactivate={can(user, "vendors", "cancel")}
        submitLabel="Save changes"
        action={updateVendorAction.bind(null, id)}
      />
    </div>
  );
}
