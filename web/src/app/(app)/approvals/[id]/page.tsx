import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { FormSection } from "@/components/form";
import { PageHeader } from "@/components/page-header";
import { APPROVAL_STATUS, getRequest } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { decideAction } from "../actions";
import { DecisionForm } from "./decision-form";

export default async function ApprovalPage({ params }: PageProps<"/approvals/[id]">) {
  await requirePermission("approvals", "view");
  const id = Number((await params).id);
  const req = Number.isSafeInteger(id) ? await getRequest(id) : undefined;
  if (!req) notFound();
  const decided =
    req.status === "pending"
      ? null
      : {
          text: [req.status === "approved" ? "Approved by" : "Rejected by", req.decidedBy ?? "—"].join(" ") +
            (req.decidedAt ? `, ${formatDateTime(req.decidedAt)}` : ""),
          note: req.decisionNote,
        };

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/approvals", label: "Approvals" }}
        title={req.summary}
        status={APPROVAL_STATUS[req.status]}
        description={
          <>
            Requested by {req.requestedBy}, <DateText at={req.requestedAt} />
          </>
        }
      />

      <FormSection title="What changes" description="As it was when the request was made.">
        {req.changes.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Field</th>
                  <th className="py-2 pr-4 font-medium">Before</th>
                  <th className="py-2 font-medium">After approval</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {req.changes.map((c) => (
                  <tr key={c.label} className="align-top">
                    <td className="py-2 pr-4 text-muted-foreground">{c.label}</td>
                    <td className="py-2 pr-4 break-words whitespace-pre-line">{c.old ?? "—"}</td>
                    <td className="py-2 font-medium break-words whitespace-pre-line">{c.new ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No field changes to show.</p>
        )}
        {req.reason && (
          <p className="mt-4 text-sm whitespace-pre-line">
            <span className="text-muted-foreground">Reason: </span>
            {req.reason}
          </p>
        )}
      </FormSection>

      <FormSection
        title="Decision"
        description={decided ? undefined : "Approving makes the change now, recorded as done by you."}
      >
        <DecisionForm action={decideAction.bind(null, req.id)} decided={decided} />
      </FormSection>
    </div>
  );
}
