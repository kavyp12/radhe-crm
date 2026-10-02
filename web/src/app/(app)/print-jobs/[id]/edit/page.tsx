import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { milliText, moneyText } from "@/lib/num";
import { getPrintJob, printFormOptions } from "@/lib/print-jobs";
import { updatePrintJobAction } from "../../actions";
import { PrintJobForm } from "../../print-job-form";

/** Owner / accountant (D64): the print's details; money taken stays with it (see lib/print-jobs.ts updatePrintJob). */
export default async function EditPrintJobPage({ params }: PageProps<"/print-jobs/[id]/edit">) {
  const user = await requirePermission("printJobs", "edit");
  const id = Number((await params).id);
  const pj = await getPrintJob(user, id);
  if (!pj) notFound();
  if (pj.status !== "active" || pj.money?.invoice) redirect(`/print-jobs/${id}`);
  const options = await printFormOptions(user, {
    customerId: pj.customerId,
    jobId: pj.jobId,
    machineId: pj.machineId,
    printingTypeId: pj.printingTypeId,
  });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: `/print-jobs/${id}`, label: pj.number }} title={`Edit ${pj.number}`} />
      <PrintJobForm
        values={{
          customerId: String(pj.customerId),
          jobId: pj.jobId ? String(pj.jobId) : "",
          fileName: pj.fileName,
          filePath: pj.filePath ?? "",
          machineId: String(pj.machineId),
          printingTypeId: String(pj.printingTypeId),
          width: milliText(pj.widthMilli),
          height: milliText(pj.heightMilli),
          qty: milliText(pj.qtyMilli),
          rate: pj.mode === "sale" && pj.ratePaise !== null ? moneyText(pj.ratePaise) : "",
          notes: pj.notes ?? "",
          reprintOfId: "",
          date: pj.date,
          time: "",
        }}
        options={options}
        operator={pj.operator}
        editId={id}
        submitLabel="Save changes"
        action={updatePrintJobAction.bind(null, id)}
      />
    </div>
  );
}
