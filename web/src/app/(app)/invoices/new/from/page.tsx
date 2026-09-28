import { ActionButton } from "@/components/doc-actions";
import { Field, FormSection } from "@/components/form";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { billableJobs, billableQuotations } from "@/lib/invoices";
import { JOB_STATUS } from "@/lib/jobs";
import { salesFormOptions } from "@/lib/sales";
import { invoiceJobsAction, invoiceQuotationAction } from "../../actions";
import { BillJobsForm } from "./bill-jobs-form";

/** Bill without retyping (R0): a customer's open jobs, or an approved quotation that has no job. */
export default async function BillFromPage({ searchParams }: PageProps<"/invoices/new/from">) {
  await requirePermission("invoices", "create");
  const { customer } = await searchParams;
  const customerId = typeof customer === "string" ? Number(customer) : NaN;
  const { customers } = await salesFormOptions();
  const picked = customers.find((c) => c.id === customerId);
  const [jobs, quotations] = picked ? await Promise.all([billableJobs(picked.id), billableQuotations(picked.id)]) : [[], []];

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader back={{ href: "/invoices", label: "Invoices" }} title="Bill jobs" />
      <FormSection title="Customer">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field label="Customer" className="min-w-64 flex-1">
            <NativeSelect name="customer" defaultValue={picked ? String(picked.id) : ""} className="w-full">
              <NativeSelectOption value="">Pick the customer…</NativeSelectOption>
              {customers.map((c) => (
                <NativeSelectOption key={c.id} value={String(c.id)}>
                  {c.firmName ? `${c.name} · ${c.firmName}` : c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
      </FormSection>

      {picked && (
        <>
          <FormSection title="Jobs not billed yet" description="Not cancelled, not invoiced, on no other invoice.">
            {jobs.length ? (
              <BillJobsForm
                jobs={jobs.map((j) => ({ ...j, status: JOB_STATUS[j.status] }))}
                action={invoiceJobsAction}
              />
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </FormSection>
          <FormSection title="Approved quotations without a job" description="Bill straight from the quotation.">
            {quotations.length ? (
              <ul className="grid gap-2">
                {quotations.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium tabular-nums">{q.number}</span> · {formatDate(q.date)} · <Money paise={q.total} />
                    </span>
                    <ActionButton action={invoiceQuotationAction.bind(null, q.id)} label="Create draft invoice" done="Draft created." />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </FormSection>
        </>
      )}
    </div>
  );
}
