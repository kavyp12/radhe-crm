import { notFound } from "next/navigation";
import { DocLines } from "@/components/doc-lines";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { requirePermission } from "@/lib/auth";
import { staffOptions } from "@/lib/customers";
import { todayIST } from "@/lib/dates";
import { liveJobFor } from "@/lib/jobs";
import { getQuotation } from "@/lib/quotations";
import { salesFormOptions } from "@/lib/sales";
import { createJobAction } from "../actions";
import { JobForm, type JobFormValues } from "../job-form";

/** A blank job, or ?quotation=<id>: a job from that approved quotation (its lines are copied on the server). */
export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  await requirePermission("jobs", "create");
  const { quotation, customer } = await searchParams;
  const quotationId = typeof quotation === "string" ? Number(quotation) : null;
  const q = quotationId !== null && Number.isSafeInteger(quotationId) ? await getQuotation(quotationId) : undefined;
  if (quotationId !== null && (!q || q.status !== "approved" || (await liveJobFor(db, quotationId)))) notFound();
  const [options, staff] = await Promise.all([salesFormOptions(), staffOptions()]);
  const customerId = q ? String(q.customerId) : typeof customer === "string" ? customer : "";
  const salesPerson = q?.customer.salesPersonId ?? "";

  const values: JobFormValues = {
    customerId,
    date: todayIST(),
    targetDate: "",
    salesPersonId: salesPerson,
    siteAddress: "",
    siteReference: "",
    vehicleNo: "",
    notes: "",
    lines: [],
  };
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={q ? { href: `/quotations/${q.id}`, label: q.number } : { href: "/jobs", label: "Jobs" }}
        title={q ? `New job from ${q.number}` : "New job"}
        description={q ? (q.customer.firmName ? `${q.customer.name} · ${q.customer.firmName}` : q.customer.name) : undefined}
      />
      <JobForm
        values={values}
        {...options}
        staff={staff}
        preview={q ? <DocLines lines={q.lines} totals={q.totals} mode={q.mode} /> : undefined}
        submitLabel="Create job"
        action={createJobAction.bind(null, q ? q.id : null)}
      />
    </div>
  );
}
