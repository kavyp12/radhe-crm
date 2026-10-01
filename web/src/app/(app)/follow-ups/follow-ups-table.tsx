"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";

export type FollowUpRow = {
  id: number;
  customerId: number;
  customer: string;
  invoice: string;
  followUpDate: string;
  person: string;
  response: string;
  promiseDate: string | null;
  expected: bigint | null;
  promise: string;
  nextReminderDate: string | null;
};

const PROMISE_TONE: Record<string, string> = { Broken: "text-red-700 font-medium", "Due today": "text-amber-700 font-medium", Kept: "text-emerald-700" };

const col = tableColumns<FollowUpRow>();
const columns = [
  col.accessor("followUpDate", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  col.accessor("customer", { header: "Customer", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  col.accessor("invoice", { header: "Invoice" }),
  col.accessor("person", { header: "By" }),
  col.accessor("response", { header: "Response", cell: (c) => <span className="block max-w-72 truncate">{c.getValue()}</span> }),
  col.accessor("promiseDate", {
    header: "Promised for",
    cell: (c) => (c.getValue() ? <DateText date={c.getValue()!} /> : null),
    enableGlobalFilter: false,
  }),
  col.accessor("expected", {
    header: "Expected",
    cell: (c) => (c.getValue() === null ? null : <Money paise={c.getValue()!} />),
    meta: { numeric: true },
    enableGlobalFilter: false,
  }),
  col.accessor("promise", {
    header: "Promise",
    cell: (c) => <span className={PROMISE_TONE[c.getValue()]}>{c.getValue()}</span>,
    enableGlobalFilter: false,
  }),
  col.accessor("nextReminderDate", {
    header: "Next reminder",
    cell: (c) => (c.getValue() ? <DateText date={c.getValue()!} /> : null),
    enableGlobalFilter: false,
  }),
];

const FILTERS = [{ label: "By", value: (r: FollowUpRow) => r.person }];

export function FollowUpsTable({ rows, newButton }: { rows: FollowUpRow[]; newButton?: ReactNode }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={columns}
      date={(r) => r.followUpDate}
      status={(r) => r.promise}
      filters={FILTERS}
      searchPlaceholder="Search customer, invoice or response"
      onRowClick={(r) => router.push(`/outstanding?customer=${r.customerId}`)}
      empty={{ title: "No follow-ups yet.", action: newButton }}
    />
  );
}
