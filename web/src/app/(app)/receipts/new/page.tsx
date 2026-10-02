import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { moneyText } from "@/lib/num";
import { receiptFormOptions } from "@/lib/receipts";
import { MODE_ACCOUNT } from "@/lib/receipt-modes";
import { createReceiptAction, openItemsAction } from "../actions";
import { ReceiptForm } from "../receipt-form";

/**
 * ?customer= picks the customer; ?invoice= / ?printJob= also fills that invoice's / print job's open amount ("Record
 * payment"); ?job= puts the amount on that job as an advance ("Record advance", S12).
 */
export default async function NewReceiptPage({ searchParams }: PageProps<"/receipts/new">) {
  const user = await requirePermission("payments", "create");
  const { customer, invoice, printJob, job } = await searchParams;
  const options = await receiptFormOptions();
  const picked = options.customers.find((c) => String(c.id) === customer);
  const open = picked ? await openItemsAction(picked.id) : { invoices: [], jobs: [] };
  const target = open.invoices.find((i) =>
    printJob ? i.target === "print_job" && String(i.id) === printJob : i.target === "invoice" && String(i.id) === invoice,
  );
  const advanceFor = open.jobs.find((j) => String(j.id) === job)?.id;
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
          allocated: target ? { [`${target.target}:${target.id}`]: moneyText(target.open) } : {},
        }}
        {...options}
        open={open}
        advanceFor={advanceFor}
        submitLabel="Save receipt"
        action={createReceiptAction}
        loadOpen={openItemsAction}
      />
    </div>
  );
}
