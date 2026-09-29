import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getReceipt, receiptFormOptions } from "@/lib/receipts";
import { openItemsAction, updateReceiptAction } from "../../actions";
import { ReceiptForm } from "../../receipt-form";

export default async function EditReceiptPage({ params }: PageProps<"/receipts/[id]/edit">) {
  const user = await requirePermission("payments", "edit");
  const id = Number((await params).id);
  const r = Number.isSafeInteger(id) ? await getReceipt(id) : undefined;
  if (!r) notFound();
  if (r.status !== "active") redirect(`/receipts/${id}`);
  const [options, open] = await Promise.all([receiptFormOptions(r.customerId), openItemsAction(r.customerId, id)]);
  const isOwner = can(user, "approvals", "approve");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/receipts/${id}`, label: r.number }}
        title={`Edit ${r.number}`}
        description={
          isOwner
            ? "A change to the date, amount, customer or account reverses the entry and posts it again."
            : "The owner approves changes to a receipt before they are made."
        }
      />
      <ReceiptForm
        values={{
          customerId: String(r.customerId),
          date: r.date,
          amount: moneyText(r.amountPaise),
          mode: r.mode,
          moneyAccountId: String(r.moneyAccountId),
          reference: r.reference ?? "",
          chequeNo: r.chequeNo ?? "",
          chequeDate: r.chequeDate ?? "",
          receivedBy: r.receivedBy ?? "",
          notes: r.notes ?? "",
          // One line per document: rows on the same one (two jobs' advances billed together) are added up.
          allocated: Object.fromEntries(
            [
              ...r.lines
                .reduce((sum, l) => {
                  const key = l.jobId !== null ? `job:${l.jobId}` : l.debitNoteId !== null ? `debit_note:${l.debitNoteId}` : `invoice:${l.invoiceId}`;
                  return sum.set(key, (sum.get(key) ?? 0n) + l.amount);
                }, new Map<string, bigint>())
                .entries(),
            ].map(([key, paise]) => [key, moneyText(paise)]),
          ),
        }}
        {...options}
        open={open}
        receiptId={id}
        askReason={!isOwner}
        submitLabel={isOwner ? "Save changes" : "Ask the owner"}
        action={updateReceiptAction.bind(null, id)}
        loadOpen={openItemsAction}
      />
    </div>
  );
}
