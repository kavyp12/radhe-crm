import { PageHeader } from "@/components/page-header";
import { requireCostPermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { billLinesFromReceipts } from "@/lib/goods-receipts";
import { purchaseFormOptions } from "@/lib/purchase-bills";
import { createBillAction } from "../actions";
import { BillForm } from "../bill-form";

/** ?vendor= picks the vendor (from the vendor page); ?grn= (repeatable) bills those GRNs' unbilled lines (T23). */
export default async function NewPurchaseBillPage({ searchParams }: PageProps<"/purchase-bills/new">) {
  await requireCostPermission("books", "create");
  const { vendor, grn } = await searchParams;
  const options = await purchaseFormOptions();
  const fromGrn = await billLinesFromReceipts([grn ?? []].flat().map(Number).filter(Number.isSafeInteger));
  const vendorId = fromGrn.vendorId ?? options.vendors.find((v) => String(v.id) === vendor)?.id;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/purchase-bills", label: "Purchase bills" }}
        title="New purchase bill"
        description={fromGrn.receipts.length ? `From ${fromGrn.receipts.map((g) => g.number).join(", ")}` : undefined}
      />
      <BillForm
        values={{ vendorId: vendorId ? String(vendorId) : "", vendorBillNo: "", date: todayIST(), roundOff: "", notes: "", lines: fromGrn.lines }}
        options={options}
        submitLabel="Save bill"
        back="/purchase-bills"
        action={createBillAction}
      />
    </div>
  );
}
