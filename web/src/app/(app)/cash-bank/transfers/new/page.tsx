import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { moneyAccounts } from "@/lib/ledger";
import { createTransferAction, transferWarningAction } from "../actions";
import { TransferForm } from "../transfer-form";

/** ?from= / ?to= (account ids) prefill the accounts, e.g. from an account book. */
export default async function NewTransferPage({ searchParams }: PageProps<"/cash-bank/transfers/new">) {
  await requirePermission("books", "create");
  const { from, to } = await searchParams;
  const accounts = await moneyAccounts();
  const pick = (id: unknown) => (accounts.some((a) => String(a.id) === id) ? String(id) : "");
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/cash-bank/transfers", label: "Transfers" }} title="New transfer" />
      <TransferForm
        values={{ date: todayIST(), fromAccountId: pick(from), toAccountId: pick(to), amount: "", reference: "", notes: "" }}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        submitLabel="Save transfer"
        back="/cash-bank/transfers"
        action={createTransferAction}
        warn={transferWarningAction}
      />
    </div>
  );
}
