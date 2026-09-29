"use client";

import { useRouter } from "next/navigation";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";

export type NoteRow = {
  href: string;
  number: string;
  kind: string;
  date: string;
  invoice: string;
  customer: string;
  reason: string;
  status: Status;
  /** Debit notes: Unpaid / Part Payment / Paid / Overdue (computed). */
  payment: Status | null;
  total: bigint;
};

const col = tableColumns<NoteRow>();
const columns = [
  col.accessor("number", { header: "Number", cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status} /> }),
  col.accessor("kind", { header: "Kind" }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("invoice", { header: "Invoice" }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("reason", { header: "Reason" }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("payment", {
    header: "Payment",
    cell: (c) => {
      const payment = c.getValue();
      return payment && payment !== "Cancelled" ? <StatusBadge status={payment} /> : null;
    },
    enableGlobalFilter: false,
  }),
  col.accessor("total", {
    header: "Total",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
];

export function NotesTable({ rows }: { rows: NoteRow[] }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.date}
      status={(r) => r.status}
      searchPlaceholder="Search number, invoice, customer or reason"
      onRowClick={(r) => router.push(r.href)}
      empty={{ title: "No credit or debit notes yet. Make one from an issued invoice." }}
    />
  );
}
