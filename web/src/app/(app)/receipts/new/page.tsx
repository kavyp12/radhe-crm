import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { openInvoices } from "@/lib/allocations";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { moneyText } from "@/lib/num";
import { receiptFormOptions } from "@/lib/receipts";
import { MODE_ACCOUNT } from "@/lib/receipt-modes";
import { createReceiptAction, openItemsAction } from "../actions";
import { ReceiptForm } from "../receipt-form";

/** ?customer= picks the customer; ?invoice= also fills that invoice's open amount ("Record payment"). */
export default async function NewReceiptPage({ searchParams }: PageProps<"/receipts/new">) {
  const user = await requirePermission("payments", "create");
  const { customer, invoice } = await searchParams;
  const options = await receiptFormOptions();
  const picked = options.customers.find((c) => String(c.id) === customer);
  const open = picked ? await openInvoices(db, picked.id) : [];
  const target = open.find((i) => String(i.id) === invoice);
  const cash = options.accounts.find((a) => a.systemKey === MODE_ACCOUNT.cash);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/receipts", label: "Receipts" }} title="New receipt" />
      <ReceiptForm
        values={{
          customerId: picked ? String(picked.id) : "",
          date: todayIST(),
          amount: target ? moneyText(target.open) : "",
          mode: "cash",
          moneyAccountId: cash ? String(cash.id) : "",
          reference: "",
          chequeNo: "",
          chequeDate: "",
          receivedBy: options.staff.some((s) => s.id === user.id) ? user.id : "",
          notes: "",
          allocated: target ? { [target.id]: moneyText(target.open) } : {},
        }}
        {...options}
        open={open}
        submitLabel="Save receipt"
        action={createReceiptAction}
        loadOpen={openItemsAction}
      />
    </div>
  );
}
