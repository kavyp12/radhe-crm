import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { getCustomer, staffOptions } from "@/lib/customers";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { updateCustomerAction } from "../../actions";
import { CustomerForm } from "../../customer-form";

export default async function EditCustomerPage({ params }: PageProps<"/customers/[id]/edit">) {
  const user = await requirePermission("customers", "edit");
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) ? await getCustomer(id) : undefined;
  if (!c) notFound();

  // Active staff, plus whoever is assigned now even if since disabled, so saving doesn't drop them.
  const staff = await staffOptions();
  for (const [personId, name] of [
    [c.salesPersonId, c.salesPerson],
    [c.collectionPersonId, c.collectionPerson],
  ] as const) {
    if (personId && !staff.some((u) => u.id === personId)) staff.push({ id: personId, name: `${name} (disabled)` });
  }

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: `/customers/${id}`, label: c.name }} title="Edit customer" />
      <CustomerForm
        values={{
          name: c.name,
          firmName: c.firmName ?? "",
          mobile: c.mobile ?? "",
          gstin: c.gstin ?? "",
          stateCode: c.stateCode,
          billingAddress: c.billingAddress ?? "",
          siteAddress: c.siteAddress ?? "",
          creditLimit: c.creditLimitPaise === null ? "" : moneyText(c.creditLimitPaise),
          creditDays: c.creditDays === null ? "" : String(c.creditDays),
          isCreditCustomer: c.isCreditCustomer,
          salesPersonId: c.salesPersonId ?? "",
          collectionPersonId: c.collectionPersonId ?? "",
          notes: c.notes ?? "",
          openingBalance: c.openingBalancePaise ? moneyText(c.openingBalancePaise) : "",
          active: c.active,
        }}
        staff={staff}
        canSetOpening={can(user, "openingBalances", "edit")}
        canDeactivate={can(user, "customers", "cancel")}
        submitLabel="Save changes"
        action={updateCustomerAction.bind(null, id)}
      />
    </div>
  );
}
