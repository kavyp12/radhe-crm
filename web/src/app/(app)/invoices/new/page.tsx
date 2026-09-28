import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { salesFormOptions } from "@/lib/sales";
import { getSettings } from "@/lib/settings";
import { createInvoiceAction } from "../actions";
import { InvoiceForm } from "../invoice-form";

export default async function NewInvoicePage({ searchParams }: PageProps<"/invoices/new">) {
  await requirePermission("invoices", "create");
  const { customer, kind } = await searchParams;
  const [options, settings] = await Promise.all([salesFormOptions(), getSettings()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/invoices", label: "Invoices" }}
        title="New invoice"
        description="Typing lines by hand. To bill jobs or an approved quotation without retyping, use Bill jobs."
        action={
          <Button asChild variant="outline">
            <Link href="/invoices/new/from">Bill jobs</Link>
          </Button>
        }
      />
      <InvoiceForm
        values={{
          kind: kind === "estimate" ? "estimate" : "tax",
          customerId: typeof customer === "string" ? customer : "",
          date: todayIST(),
          terms: settings.invoiceTerms ?? "",
          notes: "",
          lines: [],
        }}
        {...options}
        submitLabel="Save draft"
        action={createInvoiceAction}
      />
    </div>
  );
}
