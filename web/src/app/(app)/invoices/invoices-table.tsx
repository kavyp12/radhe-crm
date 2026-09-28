"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type InvoiceRow = {
  id: number;
  number: string;
  kind: string;
  date: string;
  dueDate: string;
  customer: string;
  status: Status;
  total: bigint;
};

const col = tableColumns<InvoiceRow>();
const columns = [
  col.accessor("number", { header: "Number", cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status} /> }),
  col.accessor("kind", { header: "Kind" }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("dueDate", { header: "Due", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("total", {
    header: "Total",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
];

export function InvoicesTable({ rows, newButton }: { rows: InvoiceRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search number, kind or customer"
      onRowClick={(r) => router.push(`/invoices/${r.id}`)}
      empty={{ title: "No invoices yet.", action: newButton }}
    />
  );
}
