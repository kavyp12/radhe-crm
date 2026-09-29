"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type ReceiptRow = {
  id: number;
  number: string;
  date: string;
  order: string;
  vendor: string;
  bills: string;
  status: "Active" | "Cancelled";
  value: bigint;
};

const col = tableColumns<ReceiptRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("order", { header: "Purchase order", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("vendor", { header: "Vendor" }),
  col.accessor("bills", { header: "Billed on", cell: (c) => c.getValue() || <span className="text-muted-foreground">Not billed</span> }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => (c.getValue() === "Cancelled" ? <StatusBadge status="Cancelled" /> : "Active"),
    enableGlobalFilter: false,
  }),
  col.accessor("value", { header: "Value (PO rate)", cell: (c) => <Money paise={c.getValue()} />, meta: { numeric: true }, enableGlobalFilter: false }),
];

export function ReceiptsTable({ rows, newButton }: { rows: ReceiptRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={[{ label: "Vendor", value: (r: ReceiptRow) => r.vendor }]}
      searchPlaceholder="Search number, order or vendor"
      onRowClick={(r) => router.push(`/material-receive/${r.id}`)}
      empty={{ title: "No material received yet.", action: newButton }}
    />
  );
}
