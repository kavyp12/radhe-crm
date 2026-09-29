"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

export type ExpenseRow = {
  id: number;
  number: string;
  date: string;
  category: string;
  vendor: string;
  job: string;
  account: string;
  status: "Active" | "Cancelled";
  amount: bigint;
};

const col = tableColumns<ExpenseRow>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("category", { header: "Category" }),
  col.accessor("vendor", { header: "Vendor" }),
  col.accessor("job", { header: "Job", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("account", { header: "Paid from" }),
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

/** Filters (S10 list): date preset + status built in; category, job and money account here. */
const FILTERS = [
  { label: "Category", value: (r: ExpenseRow) => r.category },
  { label: "Job", value: (r: ExpenseRow) => r.job },
  { label: "Account", value: (r: ExpenseRow) => r.account },
];

export function ExpensesTable({ rows, newButton }: { rows: ExpenseRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={FILTERS}
      searchPlaceholder="Search number, category, vendor or job"
      onRowClick={(r) => router.push(`/expenses/${r.id}`)}
      empty={{ title: "No expenses yet.", action: newButton }}
    />
  );
}
