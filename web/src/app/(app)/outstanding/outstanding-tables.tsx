"use client";

import { useRouter } from "next/navigation";
import { DataTable, tableColumns, type DataTableColumn } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge } from "@/components/status-badge";

// The /outstanding tables (T28). Rows arrive flat from the server page; every money column has a totals row.

/** Totals, flat: the aging buckets, the opening / on-account rest, the total (= AR), due today and overdue. */
export type Figures = {
  d0_7: bigint;
  d8_15: bigint;
  d16_30: bigint;
  d31_60: bigint;
  d60: bigint;
  onAccount: bigint;
  total: bigint;
  dueToday: bigint;
  overdue: bigint;
};
export type CustomerRow = Figures & { id: number; name: string; salesPerson: string; collectionPerson: string; href: string };
export type PersonRow = Figures & { id: string; name: string; customers: number; href: string };
export type DocRow = {
  key: string;
  number: string;
  kind: string;
  customer: string;
  date: string;
  dueDate: string;
  age: number;
  bucket: string;
  due: "Due today" | "Overdue" | "Not due";
  open: bigint;
  href: string;
};

function moneyColumns<T extends Figures>(withDue: boolean): DataTableColumn<T>[] {
  const col = tableColumns<T>();
  const money = (key: keyof Figures & string, header: string) =>
    col.accessor((r) => r[key], {
      id: key,
      header,
      cell: (c) => <Money paise={c.getValue() as bigint} />,
      meta: { numeric: true, total: true },
      enableGlobalFilter: false,
    });
  return [
    money("d0_7", "0–7 days"),
    money("d8_15", "8–15"),
    money("d16_30", "16–30"),
    money("d31_60", "31–60"),
    money("d60", "60+"),
    money("onAccount", "Opening / on account"),
    money("total", "Total"),
    ...(withDue ? [money("overdue", "Overdue")] : []),
  ];
}

const customerCol = tableColumns<CustomerRow>();
const customerColumns: DataTableColumn<CustomerRow>[] = [
  customerCol.accessor("name", { header: "Customer", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  customerCol.accessor("salesPerson", { header: "Sales person" }),
  customerCol.accessor("collectionPerson", { header: "Collection" }),
  ...moneyColumns<CustomerRow>(true),
];
const CUSTOMER_FILTERS = [
  { label: "Sales person", value: (r: CustomerRow) => r.salesPerson },
  { label: "Collection person", value: (r: CustomerRow) => r.collectionPerson },
];

export function CustomerTable({ rows }: { rows: CustomerRow[] }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={customerColumns}
      filters={CUSTOMER_FILTERS}
      searchPlaceholder="Search customer"
      onRowClick={(r) => router.push(r.href)}
      empty={{ title: "Nobody owes anything." }}
    />
  );
}

const personCol = tableColumns<PersonRow>();
const personColumns: DataTableColumn<PersonRow>[] = [
  personCol.accessor("name", { header: "Person", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  personCol.accessor("customers", { header: "Customers", meta: { numeric: true }, enableGlobalFilter: false }),
  ...moneyColumns<PersonRow>(true),
];

export function PersonTable({ rows }: { rows: PersonRow[] }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={personColumns}
      searchPlaceholder="Search person"
      onRowClick={(r) => router.push(r.href)}
      empty={{ title: "Nobody owes anything." }}
    />
  );
}

const docCol = tableColumns<DocRow>();
const [docNumber, docKind] = [
  docCol.accessor("number", { header: "Number", cell: (c) => <DocNumber number={c.getValue()} /> }),
  docCol.accessor("kind", { header: "Kind" }),
];
const docRest: DataTableColumn<DocRow>[] = [
  docCol.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  docCol.accessor("dueDate", { header: "Due", cell: (c) => <DateText date={c.getValue()} />, enableGlobalFilter: false }),
  docCol.accessor("age", { header: "Days", meta: { numeric: true }, enableGlobalFilter: false }),
  docCol.accessor("due", {
    header: "Status",
    cell: (c) => (c.getValue() === "Overdue" ? <StatusBadge status="Overdue" /> : c.getValue()),
    enableGlobalFilter: false,
  }),
  docCol.accessor("open", { header: "Open", cell: (c) => <Money paise={c.getValue()} />, meta: { numeric: true, total: true }, enableGlobalFilter: false }),
];
const docColumns = [docNumber, docKind, docCol.accessor("customer", { header: "Customer" }), ...docRest];
const customerDocColumns = [docNumber, docKind, ...docRest];
const DOC_FILTERS = [{ label: "Aging", value: (r: DocRow) => r.bucket }];

export function DocTable({ rows, showCustomer = true }: { rows: DocRow[]; showCustomer?: boolean }) {
  const router = useRouter();
  return (
    <DataTable
      data={rows}
      columns={showCustomer ? docColumns : customerDocColumns}
      status={(r) => r.due}
      filters={DOC_FILTERS}
      searchPlaceholder="Search number or customer"
      onRowClick={(r) => router.push(r.href)}
      empty={{ title: "No open invoices or debit notes." }}
    />
  );
}
