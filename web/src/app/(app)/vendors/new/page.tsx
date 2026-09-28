import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { COMPANY_STATE } from "@/lib/gstin";
import { can } from "@/lib/permissions";
import { createVendorAction } from "../actions";
import { VendorForm } from "../vendor-form";

export default async function NewVendorPage() {
  const user = await requirePermission("vendors", "create");
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: "/vendors", label: "Vendors" }} title="New vendor" />
      <VendorForm
        values={{
          name: "",
          gstin: "",
          stateCode: COMPANY_STATE,
          mobile: "",
          address: "",
          creditDays: "",
          notes: "",
          openingBalance: "",
          active: true,
        }}
        canSetOpening={can(user, "openingBalances", "edit")}
        canDeactivate={false}
        submitLabel="Create vendor"
        action={createVendorAction}
      />
    </div>
  );
}
