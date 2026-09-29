import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { moneyText } from "@/lib/num";
import { MODE_ACCOUNT } from "@/lib/receipt-modes";
import { vendorPaymentFormOptions } from "@/lib/vendor-payments";
import { createPaymentAction, openBillsAction } from "../actions";
import { PaymentForm } from "../payment-form";

/** ?vendor= picks the vendor; ?bill= also fills that bill's open amount ("Record payment" on a bill). */
export default async function NewVendorPaymentPage({ searchParams }: PageProps<"/vendor-payments/new">) {
  await requirePermission("payments", "create");
  const { vendor, bill } = await searchParams;
  const options = await vendorPaymentFormOptions();
  const picked = options.vendors.find((v) => String(v.id) === vendor);
  const open = picked ? await openBillsAction(picked.id) : [];
  const target = open.find((b) => String(b.id) === bill);
  const cash = options.accounts.find((a) => a.systemKey === MODE_ACCOUNT.cash);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/vendor-payments", label: "Vendor payments" }} title="New vendor payment" />
      <PaymentForm
        values={{
          vendorId: picked ? String(picked.id) : "",
          date: todayIST(),
          amount: target ? moneyText(target.open) : "",
          mode: "cash",
          moneyAccountId: cash ? String(cash.id) : "",
          reference: "",
          chequeNo: "",
          chequeDate: "",
          notes: "",
          allocated: target ? { [String(target.id)]: moneyText(target.open) } : {},
        }}
        {...options}
        open={open}
        submitLabel="Save payment"
        action={createPaymentAction}
        loadOpen={openBillsAction}
      />
    </div>
  );
}
