import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { onAccountSources, openInvoices } from "@/lib/allocations";
import { requirePermission } from "@/lib/auth";
import { getCustomer } from "@/lib/customers";
import { todayIST } from "@/lib/dates";
import { moneyAccounts } from "@/lib/ledger";
import { can } from "@/lib/permissions";
import { createAdjustmentAction } from "../../../journal-vouchers/actions";
import { AdjustForm, type AdjustKind } from "./adjust-form";

/** D55 customer adjustment: ?kind=write_off | discount | refund (a guided JV). */
export default async function AdjustCustomerPage({ params, searchParams }: PageProps<"/customers/[id]/adjust">) {
  const user = await requirePermission("books", "create");
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) ? await getCustomer(id) : undefined;
  if (!c) notFound();
  const { kind } = await searchParams;
  const start: AdjustKind = kind === "refund" || kind === "discount" ? kind : "write_off";
  const [invoices, sources, money] = await Promise.all([openInvoices(db, id), onAccountSources(db, id), moneyAccounts()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/customers/${id}`, label: c.name }}
        title="Adjust outstanding"
        description="Write off what won't be paid, allow a settlement discount, or pay back money the customer has on account."
      />
      <AdjustForm
        customerId={id}
        kind={start}
        today={todayIST()}
        owner={can(user, "approvals", "approve")}
        receivables={invoices.map((i) => ({
          target: i.target,
          id: i.id,
          number: i.number,
          date: i.date,
          note: i.target === "invoice" ? "Invoice" : i.target === "debit_note" ? "Debit note" : "Opening bill",
          open: i.open,
        }))}
        onAccount={sources.map((s) => ({
          target: s.kind,
          id: s.id,
          number: s.number,
          date: s.date,
          note: s.kind === "receipt" ? "Receipt, not allocated" : "Credit note, leftover credit",
          open: s.rest,
        }))}
        accounts={money.map((a) => ({ id: a.id, name: a.name, systemKey: a.systemKey }))}
        back={`/customers/${id}`}
        action={createAdjustmentAction}
      />
    </div>
  );
}
