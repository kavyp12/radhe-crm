import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { needsBackdateApproval } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { moneyAccounts } from "@/lib/ledger";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getTransfer } from "@/lib/transfers";
import { transferWarningAction, updateTransferAction } from "../../actions";
import { TransferForm } from "../../transfer-form";

export default async function EditTransferPage({ params }: PageProps<"/cash-bank/transfers/[id]/edit">) {
  const user = await requirePermission("books", "edit");
  const id = Number((await params).id);
  const t = Number.isSafeInteger(id) ? await getTransfer(id) : undefined;
  if (!t) notFound();
  if (t.status !== "active") redirect(`/cash-bank/transfers/${id}`);
  const accounts = await moneyAccounts();
  // An old transfer (before the backdate window) goes to the owner when anyone else changes it (A§7).
  const askReason = !can(user, "approvals", "approve") && (await needsBackdateApproval(t.date));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/cash-bank/transfers/${id}`, label: t.number }}
        title={`Edit ${t.number}`}
        description="A change to the date, accounts or amount reverses the entry and posts it again."
      />
      <TransferForm
        values={{
          date: t.date,
          fromAccountId: String(t.fromAccountId),
          toAccountId: String(t.toAccountId),
          amount: moneyText(t.amountPaise),
          reference: t.reference ?? "",
          notes: t.notes ?? "",
        }}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        transferId={id}
        askReason={askReason}
        submitLabel={askReason ? "Ask the owner" : "Save changes"}
        back={`/cash-bank/transfers/${id}`}
        action={updateTransferAction.bind(null, id)}
        warn={transferWarningAction}
      />
    </div>
  );
}
