"use client";

import { useRouter } from "next/navigation";
import { DataTable, tableColumns } from "@/components/data-table";
import { StatusBadge, type Status } from "@/components/status-badge";

export type RequestRow = {
  id: number;
  date: string; // requested on, 'YYYY-MM-DD' (IST), for the date filter
  at: string; // requested at, as shown
  summary: string;
  requestedBy: string;
  reason: string;
  status: Status;
  decidedBy: string;
};

const col = tableColumns<RequestRow>();
const pendingColumns = [
  col.accessor("at", { header: "Requested", enableSorting: false, enableGlobalFilter: false }),
  col.accessor("summary", { header: "Request", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  col.accessor("requestedBy", { header: "By" }),
  col.accessor("reason", { header: "Reason" }),
];
const decidedColumns = [
  ...pendingColumns,
  col.accessor("status", {
    header: "Decision",
    enableGlobalFilter: false,
    cell: (c) => <StatusBadge status={c.getValue()} />,
  }),
  col.accessor("decidedBy", { header: "Decided by" }),
];

export function ApprovalsTable({ rows, decided, empty }: { rows: RequestRow[]; decided?: boolean; empty: string }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={decided ? decidedColumns : pendingColumns}
      date={(r) => r.date}
      status={decided ? (r) => r.status : undefined}
      searchPlaceholder="Search request, person or reason"
      onRowClick={(r) => router.push(`/approvals/${r.id}`)}
      empty={{ title: empty }}
    />
  );
}
