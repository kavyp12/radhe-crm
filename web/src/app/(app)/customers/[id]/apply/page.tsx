import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { onAccountSources } from "@/lib/allocations";
import { requirePermission } from "@/lib/auth";
import { getCustomer } from "@/lib/customers";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/num";
import { openItemsAction } from "../../../receipts/actions";
import { applyOnAccountAction } from "../../actions";
import { ApplyForm } from "./apply-form";

/** D50: ?receipt=<id> or ?creditNote=<id> — put what it has on account onto open invoices, debit notes or jobs. */
export default async function ApplyOnAccountPage({ params, searchParams }: PageProps<"/customers/[id]/apply">) {
  await requirePermission("payments", "create");
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) ? await getCustomer(id) : undefined;
  if (!c) notFound();
  const { receipt, creditNote } = await searchParams;
  const kind = receipt ? "receipt" : "credit_note";
  const sourceId = Number(receipt ?? creditNote);
  const source = (await onAccountSources(db, id)).find((s) => s.kind === kind && s.id === sourceId);
  if (!source) notFound();
  const open = await openItemsAction(id);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/customers/${id}`, label: c.name }}
        title={`Apply ${source.number}`}
        description={`${kind === "receipt" ? "Receipt" : "Credit note"} of ${formatDate(source.date)} · ${formatMoney(source.rest)} on account`}
      />
      <ApplyForm
        available={source.rest}
        open={open}
        back={`/customers/${id}`}
        action={applyOnAccountAction.bind(null, id, kind, sourceId)}
      />
    </div>
  );
}
