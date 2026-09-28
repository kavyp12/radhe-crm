"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable, tableColumns } from "@/components/data-table";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { FormActions, FormSection } from "@/components/form";
import { LineItemsGrid, TotalsPanel, type LineRow } from "@/components/line-items";
import { Money } from "@/components/money";
import { DocNumber, StatusBadge, type Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { addDays } from "@/lib/dates";
import { amountInWords, invoiceTotals, lineCalc, parseMoney, parseQty, type GstMode, type LineInput } from "@/lib/num";

// Sample data for the UI kit only.

type Invoice = { number: string; date: string; customer: string; status: Status; total: bigint; balance: bigint };

const CUSTOMERS = ["Shree Ganesh Traders", "Om Sai Hospital", "Patel Motors", "Krishna Sweets", "Ambica Textiles"];
const INVOICE_STATUSES: Status[] = ["Paid", "Part Payment", "Unpaid", "Overdue", "Paid", "Cancelled", "Paid", "Draft"];

function sampleInvoices(today: string): Invoice[] {
  return Array.from({ length: 64 }, (_, i) => {
    const status = INVOICE_STATUSES[i % INVOICE_STATUSES.length];
    const total = BigInt(((i * 7919) % 90_000) + 4_500) * 100n + BigInt((i * 37) % 100);
    const balance =
      status === "Paid" || status === "Cancelled" ? 0n : status === "Part Payment" ? total / 2n : total;
    return {
      number: status === "Draft" ? "Draft" : `RDS/26-27/${String(160 - i).padStart(4, "0")}`,
      date: addDays(today, -Math.floor(i * 0.7)),
      customer: CUSTOMERS[(i * 3) % CUSTOMERS.length],
      status,
      total,
      balance,
    };
  });
}

const col = tableColumns<Invoice>();
const columns = [
  col.accessor("number", {
    header: "Number",
    cell: (c) => <DocNumber number={c.getValue()} status={c.row.original.status} />,
  }),
  col.accessor("date", { header: "Date", cell: (c) => <DateText date={c.getValue()} /> }),
  col.accessor("customer", { header: "Customer" }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => <StatusBadge status={c.getValue()} />,
    enableGlobalFilter: false,
  }),
  col.accessor("total", {
    header: "Amount",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
  col.accessor("balance", {
    header: "Balance",
    cell: (c) => <Money paise={c.getValue()} />,
    meta: { numeric: true, total: true },
    enableGlobalFilter: false,
  }),
];

export function KitTable({ today }: { today: string }) {
  const data = useMemo(() => sampleInvoices(today), [today]);
  return (
    <DataTable
      data={data}
      columns={columns}
      date={(row) => row.date}
      status={(row) => row.status}
      searchPlaceholder="Search number or customer"
      pageSize={10}
      onRowClick={(row) => toast(`Opens ${row.number === "Draft" ? "the draft" : row.number}`)}
    />
  );
}

const MODES: { value: GstMode; label: string }[] = [
  { value: "same_state", label: "Gujarat customer (CGST + SGST)" },
  { value: "other_state", label: "Other state (IGST)" },
  { value: "estimate", label: "Estimate (no GST)" },
];

const lineColumns = [
  { key: "description", label: "Description", placeholder: "e.g. LED sign board 6 × 3 ft" },
  { key: "qty", label: "Qty", numeric: true, width: "w-18", invalid: bad(parseQty) },
  { key: "rate", label: "Rate ₹", numeric: true, width: "w-24", invalid: bad(parseMoney) },
  { key: "discount", label: "Discount ₹", numeric: true, width: "w-22", invalid: bad(parseMoney) },
  { key: "gst", label: "GST %", numeric: true, width: "w-16", invalid: bad(parseMoney) },
];

function bad(parse: (text: string) => bigint) {
  return (text: string) => {
    try {
      parse(text);
      return false;
    } catch {
      return true;
    }
  };
}

const newLine = (): LineRow => ({ id: crypto.randomUUID(), description: "", qty: "1", rate: "", discount: "", gst: "18" });

/** A line the grid can price, or null while any number in it is missing or unreadable. */
function priced(row: LineRow): LineInput | null {
  try {
    if (!row.rate) return null;
    return {
      qty: parseQty(row.qty),
      rate: parseMoney(row.rate),
      discount: row.discount ? parseMoney(row.discount) : 0n,
      gstBp: Number(parseMoney(row.gst || "0")), // "18" → 1800 bp: same two-decimal parse as money
    };
  } catch {
    return null;
  }
}

export function KitForm({ today }: { today: string }) {
  const [mode, setMode] = useState<GstMode>("same_state");
  const [rows, setRows] = useState<LineRow[]>(() => [
    { id: "a", description: "LED sign board 6 × 3 ft", qty: "1", rate: "18500", discount: "500", gst: "18" },
    { id: "b", description: "Installation", qty: "1", rate: "1500", discount: "", gst: "18" },
    { id: "c", description: "Flex banner (sq ft)", qty: "24.5", rate: "18.75", discount: "", gst: "18" },
  ]);

  const lines = rows.map(priced);
  let totals: ReturnType<typeof invoiceTotals> | null = null;
  try {
    totals = invoiceTotals(lines.filter((line) => line !== null), mode);
  } catch {
    totals = null; // a discount larger than its line: that line's amount shows the problem
  }

  const amount = (row: LineRow) => {
    const line = priced(row);
    if (!line) return <span className="text-muted-foreground">—</span>;
    try {
      return <Money paise={lineCalc(line, mode).taxable} />;
    } catch {
      return <span className="text-destructive">Discount too big</span>;
    }
  };

  const taxRows = totals
    ? [
        { label: "Taxable value", paise: totals.taxable },
        ...(mode === "same_state"
          ? [
              { label: "CGST", paise: totals.cgst },
              { label: "SGST", paise: totals.sgst },
            ]
          : mode === "other_state"
            ? [{ label: "IGST", paise: totals.igst }]
            : []),
        { label: "Round off", paise: totals.roundOff },
      ]
    : [];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        toast.success("Invoice issued (sample).");
      }}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="grid grid-cols-1 gap-4">
          <FormSection title="Customer and dates">
            <div className="grid gap-4 sm:grid-cols-2">
              <Label className="grid gap-1.5">
                Customer
                <Input name="customer" placeholder="Search customer" defaultValue="Om Sai Hospital" />
              </Label>
              <Label className="grid gap-1.5">
                Tax type
                <NativeSelect className="w-full" value={mode} onChange={(e) => setMode(e.target.value as GstMode)}>
                  {MODES.map((m) => (
                    <NativeSelectOption key={m.value} value={m.value}>
                      {m.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label className="grid gap-1.5">
                Invoice date
                <DateInput name="date" defaultValue={today} />
              </Label>
              <Label className="grid gap-1.5">
                Due date
                <DateInput name="dueDate" defaultValue={addDays(today, 15)} />
              </Label>
            </div>
          </FormSection>
          <FormSection title="Items" description="Qty accepts 3 decimals; rates and discounts 2.">
            <LineItemsGrid columns={lineColumns} rows={rows} onChange={setRows} newRow={newLine} amount={amount} />
          </FormSection>
        </div>
        <div className="lg:sticky lg:top-4">
          {totals ? (
            <TotalsPanel rows={taxRows} total={totals.total} words={amountInWords(totals.total)} />
          ) : (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              Fix the highlighted line to see totals.
            </div>
          )}
        </div>
      </div>
      <FormActions>
        <Button type="button" variant="outline" onClick={() => toast("Saved as draft (sample).")}>
          Save draft
        </Button>
        <Button type="submit">Issue invoice</Button>
      </FormActions>
    </form>
  );
}

export function KitToasts() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast.success("Receipt saved.")}>
        Success toast
      </Button>
      <Button variant="outline" onClick={() => toast.error("Couldn't save: the amount is more than the balance.")}>
        Error toast
      </Button>
      <Button variant="outline" onClick={() => toast("Reminder set for 30/09/2026.")}>
        Plain toast
      </Button>
    </div>
  );
}
