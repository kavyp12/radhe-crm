import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { getInvoice, INVOICE_KIND } from "@/lib/invoices";
import { lineText } from "@/lib/lines";
import { salesFormOptions } from "@/lib/sales";
import { updateInvoiceAction } from "../../actions";
import { InvoiceForm } from "../../invoice-form";

/** Drafts only: an issued invoice is frozen. */
export default async function EditInvoicePage({ params }: PageProps<"/invoices/[id]/edit">) {
  await requirePermission("invoices", "edit");
  const id = Number((await params).id);
  const inv = Number.isSafeInteger(id) ? await getInvoice(id) : undefined;
  if (!inv) notFound();
  if (inv.status !== "draft") redirect(`/invoices/${id}`);
  const options = await salesFormOptions({ customerId: inv.customerId, categoryIds: inv.lines.map((l) => l.categoryId) });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: `/invoices/${id}`, label: "Draft" }} title={`Edit draft ${INVOICE_KIND[inv.kind].toLowerCase()}`} />
      <InvoiceForm
        values={{
          kind: inv.kind,
          customerId: String(inv.customerId),
          date: inv.date,
          terms: inv.terms ?? "",
          notes: inv.notes ?? "",
          lines: inv.lines.map(lineText),
        }}
        {...options}
        customerLocked={inv.lines.some((l) => l.jobId !== null || l.quotationLineId !== null)}
        submitLabel="Save draft"
        action={updateInvoiceAction.bind(null, id)}
      />
    </div>
  );
}
