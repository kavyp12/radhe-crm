"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type RequestRow = {
  id: number;
  number: string;
  date: string;
  neededBy: string;
  job: string;
  requestedBy: string;
  items: string;
  status: Status;
};

const col = tableColumns<RequestRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("neededBy", { header: "Needed by", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("job", { header: "Job", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("requestedBy", { header: "Asked by" }),
  col.accessor("items", { header: "Items", cell: (c) => <span className="block max-w-96 truncate">{c.getValue()}</span> }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
];

export function RequestsTable({ rows, newButton }: { rows: RequestRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={[{ label: "Asked by", value: (r: RequestRow) => r.requestedBy }]}
      searchPlaceholder="Search number, job or item"
      onRowClick={(r) => router.push(`/material-requests/${r.id}`)}
      empty={{ title: "No material requests yet.", action: newButton }}
    />
  );
}
