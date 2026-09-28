"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type QuotationRow = { id: number; number: string; date: string; customer: string; status: Status; total: bigint };

const col = tableColumns<QuotationRow>();
const columns = [
  col.accessor("number", { header: "Number", cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status} /> }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("total", {
    header: "Total",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
];

export function QuotationsTable({ rows, newButton }: { rows: QuotationRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search number or customer"
      onRowClick={(r) => router.push(`/quotations/${r.id}`)}
      empty={{ title: "No quotations yet.", action: newButton }}
    />
  );
}
