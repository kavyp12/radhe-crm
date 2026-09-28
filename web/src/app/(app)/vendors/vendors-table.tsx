"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";

export type VendorRow = {
  id: number;
  name: string;
  mobile: string;
  gstin: string;
  active: boolean;
  outstanding: bigint; // AP balance, + = we owe them
};

const col = tableColumns<VendorRow>();
const columns = [
  col.accessor("name", {
    header: "Name",
    cell: (c) => (
      <span className={cn("font-medium", !c.row.original.active && "text-muted-foreground")}>
        {c.getValue()}
        {!c.row.original.active && <span className="ml-1.5 text-xs font-normal">(inactive)</span>}
      </span>
    ),
  }),
  col.accessor("mobile", { header: "Mobile", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("gstin", { header: "GSTIN", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("outstanding", {
    header: "We owe",
    enableGlobalFilter: false,
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
  }),
];

export function VendorsTable({ rows, newButton }: { rows: VendorRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      status={(r) => (r.active ? "Active" : "Inactive")}
      searchPlaceholder="Search name, mobile or GSTIN"
      onRowClick={(r) => router.push(`/vendors/${r.id}`)}
      empty={{ title: "No vendors yet.", action: newButton }}
    />
  );
}
