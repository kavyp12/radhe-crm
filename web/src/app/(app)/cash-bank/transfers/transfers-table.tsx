"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type TransferRow = {
  id: number;
  number: string;
  date: string;
  from: string;
  to: string;
  reference: string;
  status: "Active" | "Cancelled";
  amount: bigint;
};

const col = tableColumns<TransferRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("from", { header: "From" }),
  col.accessor("to", { header: "To" }),
  col.accessor("reference", { header: "Reference" }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => (c.getValue() === "Cancelled" ? <StatusBadge status="Cancelled" /> : "Active"),
    enableGlobalFilter: false,
  }),
  col.accessor("amount", {
    header: "Amount",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
];

const FILTERS = [
  { label: "From", value: (r: TransferRow) => r.from },
  { label: "To", value: (r: TransferRow) => r.to },
];

export function TransfersTable({ rows, newButton }: { rows: TransferRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={FILTERS}
      searchPlaceholder="Search number, account or reference"
      onRowClick={(r) => router.push(`/cash-bank/transfers/${r.id}`)}
      empty={{ title: "No transfers yet.", action: newButton }}
    />
  );
}
