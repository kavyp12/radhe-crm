import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/num";
import { openBills, vendorOnAccount } from "@/lib/vendor-payments";
import { getVendor } from "@/lib/vendors";
import { ApplyForm } from "../../../customers/[id]/apply/apply-form";
import { applyVendorOnAccountAction } from "../../actions";

/** D52: ?payment=<id> — put what a vendor payment has on account onto the vendor's open bills (oldest first). */
export default async function VendorApplyPage({ params, searchParams }: PageProps<"/vendors/[id]/apply">) {
  await requirePermission("payments", "create");
  const id = Number((await params).id);
  const v = Number.isSafeInteger(id) ? await getVendor(id) : undefined;
  if (!v) notFound();
  const paymentId = Number((await searchParams).payment);
  const source = (await vendorOnAccount(db, id)).find((s) => s.id === paymentId);
  if (!source) notFound();
  const bills = await openBills(db, id);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/vendors/${id}`, label: v.name }}
        title={`Apply ${source.number}`}
        description={`Payment of ${formatDate(source.date)} · ${formatMoney(source.rest)} on account`}
      />
      <ApplyForm
        vendor
        available={source.rest}
        open={{
          // The customer panel's rows: a purchase bill rides as "invoice", an opening bill as itself (T43).
          invoices: bills.map((b) => ({
            target: b.target === "bill" ? "invoice" : "opening_bill",
            id: b.id,
            number: b.target === "bill" ? `${b.number} · ${b.vendorBillNo}` : b.number,
            date: b.date,
            dueDate: b.dueDate,
            total: b.total,
            open: b.open,
          })),
          jobs: [],
        }}
        back={`/vendors/${id}`}
        action={applyVendorOnAccountAction.bind(null, id, paymentId)}
      />
    </div>
  );
}
