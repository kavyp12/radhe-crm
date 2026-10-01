"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formAction, type FormState } from "@/lib/action";
import { requireCostPermission, requirePermission } from "@/lib/auth";
import { addJobCost, deactivateJobCost } from "@/lib/job-costing";
import {
  cancelJob,
  createJob,
  createJobFromQuotation,
  setJobStatus,
  updateJob,
  type JobHeaderInput,
  type JobInput,
} from "@/lib/jobs";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");
const headerInput = (form: FormData): JobHeaderInput => ({
  date: text(form, "date"),
  siteAddress: text(form, "siteAddress"),
  siteReference: text(form, "siteReference"),
  vehicleNo: text(form, "vehicleNo"),
  salesPersonId: text(form, "salesPersonId"),
  targetDate: text(form, "targetDate"),
  notes: text(form, "notes"),
});
const input = (form: FormData): JobInput => ({
  ...headerInput(form),
  customerId: text(form, "customerId"),
  lines: text(form, "lines"),
});

const checkId = (id: number) => {
  if (!Number.isSafeInteger(id)) throw new Error("Bad id");
};

/** quotationId = null: a blank job. */
export async function createJobAction(quotationId: number | null, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("jobs", "create");
  if (quotationId !== null) checkId(quotationId);
  return formAction(async () => {
    const id =
      quotationId === null
        ? await createJob(actor, input(form))
        : await createJobFromQuotation(actor, quotationId, headerInput(form));
    redirect(`/jobs/${id}`);
  });
}

export async function updateJobAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requirePermission("jobs", "edit");
  checkId(id);
  return formAction(async () => {
    await updateJob(actor, id, input(form));
    redirect(`/jobs/${id}`);
  });
}

export async function setJobStatusAction(id: number, status: string): Promise<FormState> {
  const actor = await requirePermission("jobs", "status");
  checkId(id);
  const state = await formAction(() => setJobStatus(actor, id, String(status)));
  revalidatePath("/jobs", "layout");
  return state;
}

export async function cancelJobAction(id: number): Promise<FormState> {
  const actor = await requirePermission("jobs", "cancel");
  checkId(id);
  const state = await formAction(() => cancelJob(actor, id));
  revalidatePath(`/jobs/${id}`);
  return state;
}

/** Manual internal cost on the job's P&L (T27): owner / accountant with can_view_cost (checked again in the lib). */
export async function addJobCostAction(id: number, _: FormState, form: FormData): Promise<FormState> {
  const actor = await requireCostPermission("jobCosts", "create");
  checkId(id);
  const state = await formAction(() =>
    addJobCost(actor, id, { bucket: text(form, "bucket"), date: text(form, "date"), amount: text(form, "amount"), note: text(form, "note") }),
  );
  revalidatePath(`/jobs/${id}`);
  return state;
}

export async function removeJobCostAction(jobId: number, entryId: number): Promise<FormState> {
  const actor = await requireCostPermission("jobCosts", "cancel");
  checkId(jobId);
  checkId(entryId);
  const state = await formAction(() => deactivateJobCost(actor, entryId));
  revalidatePath(`/jobs/${jobId}`);
  return state;
}
