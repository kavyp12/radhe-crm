"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { Money } from "@/components/money";
import { milliText } from "@/lib/num";
import { cn } from "@/lib/utils";

export type ItemRow = {
  id: number;
  name: string;
  category: string;
  unit: string;
  active: boolean;
  qty: bigint;
  /** can_view_cost users only (the loader leaves it out otherwise). */
  value?: bigint;
  average?: bigint | null;
};

const col = tableColumns<ItemRow>();
const base = [
  col.accessor("name", {
    header: "Item",
    cell: (c) => (
      <span className={cn("font-medium", !c.row.original.active && "text-muted-foreground")}>
        {c.getValue()}
        {!c.row.original.active && <span className="ml-1.5 text-xs font-normal">(inactive)</span>}
      </span>
    ),
  }),
  col.accessor("category", { header: "Category" }),
  col.accessor("qty", {
    header: "In stock",
    enableGlobalFilter: false,
    cell: (c) => (
      <span className={cn(c.getValue() <= 0n && "text-muted-foreground")}>
        {milliText(c.getValue())} {c.row.original.unit}
      </span>
    ),
    meta: { numeric: true },
  }),
];
const withCost = [
  ...base,
  col.accessor("average", {
    header: "Average cost",
    enableGlobalFilter: false,
    cell: (c) => {
      const v = c.getValue();
      return v === null || v === undefined ? "—" : <><Money paise={v} /> <span className="text-xs text-muted-foreground">/ {c.row.original.unit}</span></>;
    },
    meta: { numeric: true },
  }),
  col.accessor("value", {
    header: "Stock value",
    enableGlobalFilter: false,
    cell: (c) => <Money paise={c.getValue() ?? 0n} />,
    meta: { numeric: true, total: true },
  }),
];

export function ItemsTable({ rows, cost, newButton }: { rows: ItemRow[]; cost: boolean; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={cost ? withCost : base}
      status={(r) => (r.active ? "Active" : "Inactive")}
      searchPlaceholder="Search item or category"
      onRowClick={(r) => router.push(`/items/${r.id}`)}
      empty={{ title: "No stock items yet.", action: newButton }}
    />
  );
}
