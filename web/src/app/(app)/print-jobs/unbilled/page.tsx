import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { requirePermission } from "@/lib/auth";
import { listPrintJobs, listPrintingTypes, printFormOptions } from "@/lib/print-jobs";
import { milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { billPrintJobsAction } from "../actions";
import { BillPrintJobsForm } from "./bill-form";

/**
 * Unbilled print jobs (T37 / T38): new (sale) ones, active, on no live invoice. ?customer= narrows to one customer,
 * ?pick= ticks one print job (else a customer's are all ticked).
 */
export default async function UnbilledPrintJobsPage({ searchParams }: PageProps<"/print-jobs/unbilled">) {
  const user = await requirePermission("invoices", "create");
  if (!can(user, "printJobs", "edit")) redirect("/print-jobs");
  const { customer, pick } = await searchParams;
  const [all, types, { categories }] = await Promise.all([listPrintJobs(user), listPrintingTypes(), printFormOptions(user)]);
  const unbilled = all.filter(
    (r) => r.status === "active" && r.mode === "sale" && !r.money?.invoice && (typeof customer !== "string" || String(r.customerId) === customer),
  );
  const noCategory = new Set(types.filter((t) => t.categoryId === null).map((t) => t.id));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/print-jobs", label: "Print jobs" }}
        title="Bill print jobs"
        description="New prints not on any invoice yet. Tick them: each customer gets one draft invoice or estimate."
      />
      {unbilled.length ? (
        <BillPrintJobsForm
          rows={unbilled.reverse().map((r) => ({
            id: r.id,
            number: r.number,
            date: r.date,
            customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
            fileName: r.fileName,
            type: r.type,
            needsCategory: noCategory.has(r.printingTypeId),
            sqft: milliText(r.sqftMilli),
            amount: r.amountPaise ?? 0n,
            received: r.money?.received ?? 0n,
            status: r.money?.payment ?? "Unpaid",
            checked: typeof pick === "string" ? String(r.id) === pick : typeof customer === "string",
          }))}
          categories={categories}
          action={billPrintJobsAction}
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <EmptyState title="No unbilled print jobs." />
        </div>
      )}
    </div>
  );
}
