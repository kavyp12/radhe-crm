import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { lineText } from "@/lib/lines";
import { getQuotation } from "@/lib/quotations";
import { salesFormOptions } from "@/lib/sales";
import { updateQuotationAction } from "../../actions";
import { QuotationForm } from "../../quotation-form";

export default async function EditQuotationPage({ params }: PageProps<"/quotations/[id]/edit">) {
  await requirePermission("quotations", "edit");
  const id = Number((await params).id);
  const q = Number.isSafeInteger(id) ? await getQuotation(id) : undefined;
  if (!q) notFound();
  if (q.status !== "draft" && q.status !== "sent") redirect(`/quotations/${id}`);
  const options = await salesFormOptions({ customerId: q.customerId, categoryIds: q.lines.map((l) => l.categoryId) });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/quotations/${id}`, label: q.number }}
        title={`Edit ${q.number}`}
        description={q.status === "sent" ? "Saving puts it back to Draft: send it again afterwards." : undefined}
      />
      <QuotationForm
        values={{ customerId: String(q.customerId), date: q.date, terms: q.terms ?? "", notes: q.notes ?? "", lines: q.lines.map(lineText) }}
        {...options}
        submitLabel="Save draft"
        action={updateQuotationAction.bind(null, id)}
      />
    </div>
  );
}
