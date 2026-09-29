import Link from "next/link";
import { DateText } from "@/components/date-text";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APPROVAL_STATUS, decidedRequests, pendingRequests } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDateTime, todayIST } from "@/lib/dates";
import { listRequests } from "@/lib/material-requests";
import { ApprovalsTable, type RequestRow } from "./approvals-table";

type Request = Awaited<ReturnType<typeof pendingRequests>>[number];

const row = (r: Request): RequestRow => ({
  id: r.id,
  date: todayIST(r.requestedAt),
  at: formatDateTime(r.requestedAt),
  summary: r.summary,
  requestedBy: r.requestedBy,
  reason: r.reason ?? "",
  status: APPROVAL_STATUS[r.status],
  decidedBy: r.decidedBy ?? "",
});

export default async function ApprovalsPage() {
  await requirePermission("approvals", "view");
  const [pending, decided, materials] = await Promise.all([pendingRequests(), decidedRequests(), listRequests("pending")]);
  const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
  const td = "border-b px-3 py-2";

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Approvals" description="Changes by staff that wait for you. Nothing is changed until you approve." />
      <Tabs defaultValue="pending" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="pending">Pending ({pending.length + materials.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="grid grid-cols-1 gap-4">
          {materials.length > 0 && (
            <section aria-label="Material requests" className="overflow-x-auto rounded-lg border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-medium">
                Material requests ({materials.length})
                <span className="ml-2 text-xs font-normal text-muted-foreground">Open one to approve or reject it.</span>
              </h2>
              <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Request</th>
                    <th className={th}>Asked by</th>
                    <th className={th}>Needed by</th>
                    <th className={th}>Job</th>
                    <th className={th}>Items</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((m) => (
                    <tr key={m.id}>
                      <td className={`${td} font-medium whitespace-nowrap tabular-nums`}>
                        <Link href={`/material-requests/${m.id}`} className="text-primary hover:underline">
                          {m.number}
                        </Link>
                      </td>
                      <td className={td}>{m.requestedBy}</td>
                      <td className={td}>
                        <DateText date={m.neededBy} />
                      </td>
                      <td className={`${td} tabular-nums`}>{m.job}</td>
                      <td className={td}>{m.items}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <ApprovalsTable rows={pending.map(row)} empty={materials.length ? "No other changes are waiting." : "Nothing is waiting for approval."} />
        </TabsContent>
        <TabsContent value="history">
          <ApprovalsTable rows={decided.map(row)} decided empty="No decisions yet." />
        </TabsContent>
      </Tabs>
    </div>
  );
}
