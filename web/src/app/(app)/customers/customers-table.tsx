"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";

export type CustomerRow = {
  id: number;
  name: string;
  firmName: string;
  mobile: string;
  gstin: string;
  active: boolean;
  outstanding: bigint; // AR balance, + = they owe us
};

const col = tableColumns<CustomerRow>();
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
  col.accessor("firmName", { header: "Firm" }),
  col.accessor("mobile", { header: "Mobile", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("gstin", { header: "GSTIN", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("outstanding", {
    header: "Outstanding",
    enableGlobalFilter: false,
    cell: (c) => <Money paise={c.getValue()} drcr />,
    meta: { numeric: true, total: true },
  }),
];

export function CustomersTable({ rows, newButton }: { rows: CustomerRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      status={(r) => (r.active ? "Active" : "Inactive")}
      searchPlaceholder="Search name, firm, mobile or GSTIN"
      onRowClick={(r) => router.push(`/customers/${r.id}`)}
      empty={{ title: "No customers yet.", action: newButton }}
    />
  );
}
