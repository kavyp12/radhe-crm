import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { staffOptions } from "@/lib/customers";
import { COMPANY_STATE } from "@/lib/gstin";
import { can } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { createCustomerAction, customerDuplicatesAction } from "../actions";
import { CustomerForm } from "../customer-form";

export default async function NewCustomerPage() {
  const user = await requirePermission("customers", "create");
  const [staff, { defaultCreditDays }] = await Promise.all([staffOptions(), getSettings()]);

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: "/customers", label: "Customers" }} title="New customer" />
      <CustomerForm
        values={{
          name: "",
          firmName: "",
          email: "",
          mobile: "",
          gstin: "",
          stateCode: COMPANY_STATE,
          billingAddress: "",
          siteAddress: "",
          creditLimit: "",
          creditDays: defaultCreditDays === null ? "" : String(defaultCreditDays),
          isCreditCustomer: false,
          salesPersonId: "",
          collectionPersonId: "",
          notes: "",
          openingBalance: "",
          active: true,
        }}
        staff={staff}
        canSetOpening={can(user, "openingBalances", "edit")}
        canDeactivate={false}
        submitLabel="Create customer"
        action={createCustomerAction}
        duplicates={customerDuplicatesAction.bind(null, null)}
      />
    </div>
  );
}
