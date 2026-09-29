"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type OrderRow = { id: number; number: string; date: string; vendor: string; status: Status; total: bigint };

const col = tableColumns<OrderRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("vendor", { header: "Vendor" }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("total", {
    header: "Total",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
];

export function OrdersTable({ rows, newButton }: { rows: OrderRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={[{ label: "Vendor", value: (r: OrderRow) => r.vendor }]}
      searchPlaceholder="Search number or vendor"
      onRowClick={(r) => router.push(`/purchase-orders/${r.id}`)}
      empty={{ title: "No purchase orders yet.", action: newButton }}
    />
  );
}
