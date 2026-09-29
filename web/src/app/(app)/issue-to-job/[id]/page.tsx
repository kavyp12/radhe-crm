import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { milliText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getStockIssue, ISSUE_KIND } from "@/lib/stock-issues";
import { cancelIssueAction } from "../actions";

const LABELS = { number: "Number", kind: "Kind", date: "Date", job_id: "Job", notes: "Notes", status: "Status" };

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function StockIssuePage({ params }: PageProps<"/issue-to-job/[id]">) {
  const user = await requirePermission("stockIssue", "view");
  const id = Number((await params).id);
  const d = Number.isSafeInteger(id) ? await getStockIssue(user, id) : undefined;
  if (!d) notFound();
  const active = d.status === "active";
  const isOwner = can(user, "approvals", "approve");
  const cost = d.cost ?? null;
  const job = can(user, "jobs", "view") ? (
    <Link key="j" href={`/jobs/${d.jobId}`} className="text-primary hover:underline">
      {d.job}
    </Link>
  ) : (
    d.job
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/issue-to-job", label: "Issue to job" }}
        title={d.number}
        status={active ? undefined : "Cancelled"}
        description={`${d.kind === "issue" ? "Issue to" : "Return from"} job ${d.job} · ${d.customer}`}
      />
      {active && can(user, "stockIssue", "cancel") && (
        <div className="flex flex-wrap gap-2">
          <ActionDialog
            action={cancelIssueAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${d.number}?`}
            description={
              <>
                Its stock moves and journal entry are reversed on its date ({formatDate(d.date)}); the number stays.
                {d.kind === "issue"
                  ? " Refused if the job has returned any of these items since (cancel that return first)."
                  : " Refused once any of these items has been used or issued since (use a stock adjustment then)."}
                {!isOwner && " A backdated one goes to the owner for approval."}
              </>
            }
            confirmLabel="Cancel it"
            done="Cancelled."
            reason
            variant="destructive"
          />
        </div>
      )}

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Kind", ISSUE_KIND[d.kind]],
              ["Job", job],
              ["Customer", d.customer],
              ["Date", <DateText key="d" date={d.date} />],
              ["Notes", d.notes],
            ]}
          />
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} w-8 text-right`}>#</th>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Qty</th>
                  {cost && <th className={`${th} text-right`}>{d.kind === "issue" ? "Value (average)" : "Value (job's issue average)"}</th>}
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.itemId}>
                    <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.position}</td>
                    <td className={`${td} font-medium`}>
                      {can(user, "stockItems", "view") ? (
                        <Link href={`/items/${l.itemId}`} className="text-primary hover:underline">
                          {l.name}
                        </Link>
                      ) : (
                        l.name
                      )}
                    </td>
                    <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                      {milliText(l.qty)} {l.unit}
                    </td>
                    {l.cost && (
                      <td className={`${td} text-right`}>
                        <Money paise={l.cost.value} />
                      </td>
                    )}
                  </tr>
                ))}
                {cost && (
                  <tr className="font-medium">
                    <td className={td} />
                    <td className={td}>Total</td>
                    <td className={td} />
                    <td className={`${td} text-right`}>
                      <Money paise={cost.total} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <History
            table="stock_issues"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              job_id: (v) => (v === d.jobId ? d.job : String(v)), // never changes: no edit
              kind: (v) => ISSUE_KIND[v as "issue" | "return"] ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
