"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type BillRow = {
  id: number;
  number: string;
  vendorBillNo: string;
  date: string;
  dueDate: string;
  vendor: string;
  status: Status | "Active";
  total: bigint;
};

const col = tableColumns<BillRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("vendorBillNo", { header: "Vendor bill no" }),
  col.accessor("date", { header: "Bill date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("vendor", { header: "Vendor" }),
  col.accessor("dueDate", { header: "Due", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => (c.getValue() === "Active" ? "Active" : <StatusBadge status={c.getValue() as Status} />),
    enableGlobalFilter: false,
  }),
  col.accessor("total", {
    header: "Total",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
];

export function BillsTable({ rows, newButton }: { rows: BillRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search number, vendor bill no or vendor"
      onRowClick={(r) => router.push(`/purchase-bills/${r.id}`)}
      empty={{ title: "No purchase bills yet.", action: newButton }}
    />
  );
}
