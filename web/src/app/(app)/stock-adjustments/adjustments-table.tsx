"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber } from "@/components/status-badge";
import { milliText } from "@/lib/num";

export type AdjustmentRow = {
  id: number;
  number: string;
  date: string;
  itemId: number;
  item: string;
  unit: string;
  qty: bigint;
  reason: string;
  /** can_view_cost users only. */
  value?: bigint;
};

const col = tableColumns<AdjustmentRow>();
const base = [
  col.accessor("number", { header: "Number", cell: (c) => <DocNumber number={c.getValue()} /> }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("item", { header: "Item" }),
  col.accessor("qty", {
    header: "Qty",
    enableGlobalFilter: false,
    cell: (c) => `${c.getValue() > 0n ? "+" : ""}${milliText(c.getValue())} ${c.row.original.unit}`,
    meta: { numeric: true },
  }),
  col.accessor("reason", { header: "Reason", cell: (c) => <span className="block max-w-80 truncate">{c.getValue()}</span> }),
];
const withCost = [
  ...base,
  col.accessor("value", {
    header: "Value",
    enableGlobalFilter: false,
    cell: (c) => <Money paise={c.getValue() ?? 0n} />,
    meta: { numeric: true, total: true },
  }),
];

export function AdjustmentsTable({ rows, cost, newButton }: { rows: AdjustmentRow[]; cost: boolean; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={cost ? withCost : base}
      date={(r) => r.date}
      searchPlaceholder="Search number, item or reason"
      onRowClick={(r) => router.push(`/items/${r.itemId}`)}
      empty={{ title: "No stock adjustments yet.", action: newButton }}
    />
  );
}
