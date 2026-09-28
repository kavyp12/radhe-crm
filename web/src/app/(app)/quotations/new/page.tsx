import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { salesFormOptions } from "@/lib/sales";
import { getSettings } from "@/lib/settings";
import { createQuotationAction } from "../actions";
import { QuotationForm } from "../quotation-form";

export default async function NewQuotationPage({ searchParams }: PageProps<"/quotations/new">) {
  await requirePermission("quotations", "create");
  const { customer } = await searchParams;
  const [options, settings] = await Promise.all([salesFormOptions(), getSettings()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/quotations", label: "Quotations" }} title="New quotation" />
      <QuotationForm
        values={{
          customerId: typeof customer === "string" ? customer : "",
          date: todayIST(),
          terms: settings.quotationTerms ?? "",
          notes: "",
          lines: [],
        }}
        {...options}
        submitLabel="Save draft"
        action={createQuotationAction}
      />
    </div>
  );
}
