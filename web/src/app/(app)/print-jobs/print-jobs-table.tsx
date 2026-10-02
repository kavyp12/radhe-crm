"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns, type DataTableColumn } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type PrintJobListRow = {
  id: number;
  number: string;
  date: string;
  printedAt: Date;
  customer: string;
  fileName: string;
  machine: string;
  type: string;
  size: string;
  qty: string;
  sqft: string;
  operator: string;
  job: string;
  /** Billed / Unbilled / On a job / Cancelled */
  billing: string;
  invoice: string;
  /** null = no money for this user (production), or a job print's cost without can_view_cost */
  amount: bigint | null;
  received: bigint | null;
  balance: bigint | null;
  /** the payment status (A§5); without money just Active / Cancelled */
  status: Status | "Active";
};

const col = tableColumns<PrintJobListRow>();
const head: DataTableColumn<PrintJobListRow>[] = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status === "Cancelled" ? "Cancelled" : undefined} />,
  }),
  col.accessor("printedAt", { header: "Printed", cell: (c) => <DateText at={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("fileName", { header: "File", cell: (c) => <span className="block max-w-48 truncate">{c.getValue()}</span> }),
  col.accessor("machine", { header: "Machine" }),
  col.accessor((r) => `${r.size} ft × ${r.qty}`, { id: "size", header: "Size × qty", enableGlobalFilter: false }),
  col.accessor("sqft", { header: "Sq ft", meta: { numeric: true }, enableGlobalFilter: false }),
];
const tail: DataTableColumn<PrintJobListRow>[] = [
  col.accessor("job", { header: "Job", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  col.accessor("operator", { header: "Operator" }),
];
const money: DataTableColumn<PrintJobListRow>[] = [
  col.accessor("amount", {
    header: "Amount",
    cell: (c) => (c.getValue() === null ? "—" : <Money paise={c.getValue()!} />),
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
  col.accessor("received", {
    header: "Received",
    cell: (c) => (c.getValue() === null ? "—" : <Money paise={c.getValue()!} />),
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
  col.accessor("balance", {
    header: "Balance",
    cell: (c) => (c.getValue() === null ? "—" : <Money paise={c.getValue()!} />),
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
  col.accessor("status", {
    header: "Payment",
    cell: (c) => <StatusBadge status={c.getValue() as Status} />,
    enableGlobalFilter: false,
  }),
  col.accessor("invoice", { header: "Invoice", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
];

const FILTERS = [
  { label: "Machine", value: (r: PrintJobListRow) => r.machine },
  { label: "Billing", value: (r: PrintJobListRow) => r.billing },
];
const PLAIN_FILTERS = [{ label: "Machine", value: (r: PrintJobListRow) => r.machine }];

/** P6 list: date / status / machine / billed-unbilled filters run in the browser; production sees no money (A§8). */
export function PrintJobsTable({ rows, showMoney, newButton }: { rows: PrintJobListRow[]; showMoney: boolean; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={showMoney ? [...head, ...money, ...tail] : [...head, ...tail]}
      date={(r) => r.date}
      status={(r) => r.status}
      filters={showMoney ? FILTERS : PLAIN_FILTERS}
      searchPlaceholder="Search number, customer, file, job or operator"
      onRowClick={(r) => router.push(`/print-jobs/${r.id}`)}
      empty={{ title: "No print jobs yet.", action: newButton }}
    />
  );
}
