import { PageHeader } from "@/components/page-header";
import { requireCostPermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { purchaseFormOptions } from "@/lib/purchase-bills";
import { createBillAction } from "../actions";
import { BillForm } from "../bill-form";

/** ?vendor= picks the vendor (from the vendor page). */
export default async function NewPurchaseBillPage({ searchParams }: PageProps<"/purchase-bills/new">) {
  await requireCostPermission("books", "create");
  const { vendor } = await searchParams;
  const options = await purchaseFormOptions();
  const picked = options.vendors.find((v) => String(v.id) === vendor);
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/purchase-bills", label: "Purchase bills" }} title="New purchase bill" />
      <BillForm
        values={{ vendorId: picked ? String(picked.id) : "", vendorBillNo: "", date: todayIST(), roundOff: "", notes: "", lines: [] }}
        options={options}
        submitLabel="Save bill"
        back="/purchase-bills"
        action={createBillAction}
      />
    </div>
  );
}
