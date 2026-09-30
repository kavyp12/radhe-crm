"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type JournalRow = {
  id: number;
  number: string;
  date: string;
  kind: string;
  customer: string;
  narration: string;
  status: "Active" | "Cancelled";
  amount: bigint;
};

const col = tableColumns<JournalRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("kind", { header: "Kind" }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("narration", { header: "Narration", cell: (c) => <span className="block max-w-80 truncate">{c.getValue()}</span> }),
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

const FILTERS = [{ label: "Kind", value: (r: JournalRow) => r.kind }];

export function JournalTable({ rows, newButton }: { rows: JournalRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={FILTERS}
      searchPlaceholder="Search number, customer or narration"
      onRowClick={(r) => router.push(`/journal-vouchers/${r.id}`)}
      empty={{ title: "No journal vouchers yet.", action: newButton }}
    />
  );
}
