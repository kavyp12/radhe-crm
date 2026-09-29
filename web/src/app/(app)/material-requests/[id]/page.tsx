import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { Field } from "@/components/form";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";
import { PurchaseChain } from "@/components/purchase-chain";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { requirePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { getRequest, REQUEST_STATUS } from "@/lib/material-requests";
import { milliText } from "@/lib/num";
import { can, canViewCost } from "@/lib/permissions";
import { cancelRequestAction, decideRequestAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  needed_by: "Needed by",
  job_id: "Job",
  notes: "Note",
  status: "Status",
  decided_by: "Decided by",
  decided_at: "Decided at",
  decision_note: "Decision note",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function MaterialRequestPage({ params }: PageProps<"/material-requests/[id]">) {
  const user = await requirePermission("materialRequests", "view");
  const id = Number((await params).id);
  const r = Number.isSafeInteger(id) ? await getRequest(id) : undefined;
  if (!r) notFound();
  const pending = r.status === "pending";
  const buying = can(user, "purchaseOrders", "create") && canViewCost(user); // purchase rates (D36, D53)
  const note = (
    <Field label="Note (optional)">
      <Textarea name="note" rows={2} maxLength={1000} />
    </Field>
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/material-requests", label: "Material requests" }}
        title={r.number}
        status={REQUEST_STATUS[r.status]}
        description={`Asked by ${r.requestedBy ?? "—"}`}
      />
      <div className="flex flex-wrap gap-2">
        {pending && can(user, "materialRequests", "approve") && (
          <>
            <ActionDialog
              action={decideRequestAction.bind(null, id, "approve")}
              label="Approve"
              title={`Approve ${r.number}?`}
              description="It can then be ordered from a vendor."
              confirmLabel="Approve"
              done="Approved."
              variant="default"
            >
              {note}
            </ActionDialog>
            <ActionDialog
              action={decideRequestAction.bind(null, id, "reject")}
              label="Reject"
              title={`Reject ${r.number}?`}
              description="It stays on record as Rejected and can't be ordered."
              confirmLabel="Reject"
              done="Rejected."
              variant="destructive"
            >
              {note}
            </ActionDialog>
          </>
        )}
        {r.status === "approved" && buying && (
          <Button asChild>
            <Link href={`/purchase-orders/new?mr=${id}`}>Create purchase order</Link>
          </Button>
        )}
        {pending && r.createdBy === user.id && (
          <ActionDialog
            action={cancelRequestAction.bind(null, id)}
            label="Cancel request"
            title={`Cancel ${r.number}?`}
            description="It stays on record as Cancelled."
            confirmLabel="Cancel request"
            done="Cancelled."
            variant="destructive"
          />
        )}
      </div>

      <PurchaseChain user={user} step="request" id={id} />

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={r.date} />],
              ["Needed by", <DateText key="n" date={r.neededBy} />],
              [
                "Job",
                r.jobId !== null && can(user, "jobs", "view") ? (
                  <Link key="j" href={`/jobs/${r.jobId}`} className="text-primary hover:underline">
                    {r.job}
                  </Link>
                ) : (
                  r.job
                ),
              ],
              ["Note", r.notes],
              ...(r.decidedAt
                ? ([
                    [r.status === "rejected" ? "Rejected by" : "Approved by", `${r.decidedByName ?? "—"} · ${formatDateTime(r.decidedAt)}`],
                    ["Decision note", r.decisionNote],
                  ] as [string, string | null][])
                : []),
            ]}
          />
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-100 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} w-8 text-right`}>#</th>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Qty needed</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td className={`${td} text-right text-muted-foreground tabular-nums`}>{l.position}</td>
                    <td className={`${td} font-medium`}>
                      <Link href={`/items/${l.itemId}`} className="text-primary hover:underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                      {milliText(l.qty)} {l.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <History
            table="material_requests"
            rowId={id}
            labels={LABELS}
            hide={["created_by", "decided_by"]}
            display={{
              job_id: (v) => (v === r.jobId ? (r.job ?? "") : String(v)),
              status: (v) => REQUEST_STATUS[v as keyof typeof REQUEST_STATUS] ?? String(v),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
