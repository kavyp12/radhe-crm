import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { issueFormOptions, returnableItems } from "@/lib/stock-issues";
import { createIssueAction, returnableAction } from "../actions";
import { IssueForm } from "../issue-form";

/** ?job= picks the job (from its page); ?kind=return starts a return. */
export default async function NewIssuePage({ searchParams }: PageProps<"/issue-to-job/new">) {
  const user = await requirePermission("stockIssue", "create");
  const { job, kind: asked } = await searchParams;
  const kind = asked === "return" ? "return" : "issue";
  const options = await issueFormOptions(user);
  const picked = options.jobs.find((j) => String(j.id) === job && (kind === "return" || !j.cancelled));
  const returnable = picked && kind === "return" ? await returnableItems(picked.id) : [];

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/issue-to-job", label: "Issue to job" }} title={kind === "issue" ? "Issue to job" : "Return from job"} />
      <IssueForm
        kind={kind}
        jobId={picked ? String(picked.id) : ""}
        today={todayIST()}
        jobs={options.jobs}
        items={options.items}
        returnable={returnable}
        action={createIssueAction}
        loadReturnable={returnableAction}
      />
    </div>
  );
}
