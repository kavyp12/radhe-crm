"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type IssueRow = {
  id: number;
  number: string;
  date: string;
  kind: "Issue" | "Return";
  job: string;
  customer: string;
  items: string;
  status: "Active" | "Cancelled";
  /** can_view_cost users only. */
  value?: bigint;
};

const col = tableColumns<IssueRow>();
const base = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("kind", { header: "Kind" }),
  col.accessor("job", { header: "Job", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("items", { header: "Items", cell: (c) => <span className="block max-w-80 truncate">{c.getValue()}</span> }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => (c.getValue() === "Cancelled" ? <StatusBadge status="Cancelled" /> : "Active"),
    enableGlobalFilter: false,
  }),
];
const withCost = [
  ...base,
  col.accessor("value", {
    header: "Value",
    enableGlobalFilter: false,
    cell: (c) => <Money paise={c.getValue() ?? 0n} />,
    meta: { numeric: true },
  }),
];

const FILTERS = [
  { label: "Kind", value: (r: IssueRow) => r.kind },
  { label: "Job", value: (r: IssueRow) => r.job },
];

export function IssuesTable({ rows, cost, newButton }: { rows: IssueRow[]; cost: boolean; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={cost ? withCost : base}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={FILTERS}
      searchPlaceholder="Search number, job, customer or item"
      onRowClick={(r) => router.push(`/issue-to-job/${r.id}`)}
      empty={{ title: "Nothing issued to jobs yet.", action: newButton }}
    />
  );
}
