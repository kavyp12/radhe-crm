"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns, type DataTableColumn } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

// total is absent for users who may not see money (production): the loader never read it.
export type JobRow = {
  id: number;
  number: string;
  date: string;
  customer: string;
  status: Status;
  targetDate: string;
  total?: bigint;
};

const col = tableColumns<JobRow>();
const base: DataTableColumn<JobRow>[] = [
  col.accessor("number", { header: "Job no", cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status} /> }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("targetDate", {
    header: "Target",
    cell: (c) => (c.getValue() ? <DateText date={c.getValue()} /> : "—"),
    enableGlobalFilter: false,
  }),
];
const money = col.accessor("total", {
  header: "Total",
  cell: (c) => <Money paise={c.getValue() ?? 0n} />,
  meta: { numeric: true, total: true },
  enableGlobalFilter: false,
});

export function JobsTable({ rows, showMoney, newButton }: { rows: JobRow[]; showMoney: boolean; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={showMoney ? [...base, money] : base}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search job no or customer"
      onRowClick={(r) => router.push(`/jobs/${r.id}`)}
      empty={{ title: "No jobs yet.", action: newButton }}
    />
  );
}
