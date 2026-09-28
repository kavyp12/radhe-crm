import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APPROVAL_STATUS, decidedRequests, pendingRequests } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDateTime, todayIST } from "@/lib/dates";
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
  const [pending, decided] = await Promise.all([pendingRequests(), decidedRequests()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Approvals" description="Changes by staff that wait for you. Nothing is changed until you approve." />
      <Tabs defaultValue="pending" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">
          <ApprovalsTable rows={pending.map(row)} empty="Nothing is waiting for approval." />
        </TabsContent>
        <TabsContent value="history">
          <ApprovalsTable rows={decided.map(row)} decided empty="No decisions yet." />
        </TabsContent>
      </Tabs>
    </div>
  );
}
