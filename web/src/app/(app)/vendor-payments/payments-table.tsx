"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type PaymentRow = {
  id: number;
  number: string;
  date: string;
  vendor: string;
  mode: string;
  status: "Active" | "Cancelled";
  amount: bigint;
  allocated: bigint;
  onAccount: bigint;
};

const col = tableColumns<PaymentRow>();
const money = (key: "amount" | "allocated" | "onAccount", header: string) =>
  col.accessor(key, { header, cell: (c) => <Money paise={c.getValue()} />, meta: { numeric: true, total: true }, enableGlobalFilter: false });
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("vendor", { header: "Vendor" }),
  col.accessor("mode", { header: "Mode" }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => (c.getValue() === "Cancelled" ? <StatusBadge status="Cancelled" /> : "Active"),
    enableGlobalFilter: false,
  }),
  money("amount", "Amount"),
  money("allocated", "Allocated"),
  money("onAccount", "On account"),
];

export function PaymentsTable({ rows, newButton }: { rows: PaymentRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search number, vendor or mode"
      onRowClick={(r) => router.push(`/vendor-payments/${r.id}`)}
      empty={{ title: "No vendor payments yet.", action: newButton }}
    />
  );
}
