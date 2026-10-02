import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { milliText, moneyText } from "@/lib/num";
import { getPrintJob, printFormOptions } from "@/lib/print-jobs";
import { createPrintJobAction } from "../actions";
import { PrintJobForm, type PrintJobValues } from "../print-job-form";

const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** ?customer= / ?job= prefill them; ?reprint=<id> copies that print job (P8: its own qty and amount, reprint_of). */
export default async function NewPrintJobPage({ searchParams }: PageProps<"/print-jobs/new">) {
  const user = await requirePermission("printJobs", "create");
  const { customer, job, reprint } = await searchParams;
  const from = typeof reprint === "string" ? await getPrintJob(user, Number(reprint)) : undefined;
  const options = await printFormOptions(user, { customerId: from?.customerId });
  const values: PrintJobValues = {
    customerId: from ? String(from.customerId) : typeof customer === "string" ? customer : "",
    jobId: from?.jobId ? String(from.jobId) : typeof job === "string" ? job : "",
    fileName: from?.fileName ?? "",
    filePath: from?.filePath ?? "",
    machineId: from ? String(from.machineId) : "",
    printingTypeId: from ? String(from.printingTypeId) : "",
    width: from ? milliText(from.widthMilli) : "",
    height: from ? milliText(from.heightMilli) : "",
    qty: from ? milliText(from.qtyMilli) : "1",
    rate: from?.mode === "sale" && from.ratePaise !== null ? moneyText(from.ratePaise) : "",
    notes: "",
    reprintOfId: from ? String(from.id) : "",
    date: todayIST(),
    time: IST_TIME.format(new Date()),
  };
  if (!from && values.jobId) {
    const j = options.jobs.find((x) => String(x.id) === values.jobId);
    if (j) values.customerId = String(j.customerId);
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/print-jobs", label: "Print jobs" }}
        title={from ? `Reprint ${from.number}` : "New print job"}
        description={from ? "A new print job of its own, linked to the one it reprints." : "The same fields as the print popup."}
      />
      <PrintJobForm values={values} options={options} operator={user.name} submitLabel="Save print job" action={createPrintJobAction} />
    </div>
  );
}
