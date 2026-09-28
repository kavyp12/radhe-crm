import { ActionButton } from "@/components/doc-actions";
import { JOB_STATUS, PRODUCTION_STATUSES, type JobStatus } from "@/lib/jobs";
import { setJobStatusAction } from "./actions";

/** Move a job to another production status (detail page and board). */
export function StatusButtons({ id, status, size }: { id: number; status: JobStatus; size?: "sm" }) {
  if (!(PRODUCTION_STATUSES as readonly JobStatus[]).includes(status)) return null;
  return (
    <>
      {PRODUCTION_STATUSES.filter((s) => s !== status).map((s) => (
        <ActionButton
          key={s}
          action={setJobStatusAction.bind(null, id, s)}
          label={`→ ${JOB_STATUS[s]}`}
          done={`Moved to ${JOB_STATUS[s]}.`}
          size={size}
        />
      ))}
    </>
  );
}
