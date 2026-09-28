"use client";

import { useState } from "react";
import { LineItemsGrid, TotalsPanel, type LineColumn } from "@/components/line-items";
import { Money } from "@/components/money";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { isSqFt, LINE_KEYS, lineTotals, readLine, sqFt, UNITS, type LineText } from "@/lib/lines";
import { amountInWords, bpText, divRound, milliText, parseMoney, parsePercent, parseQty, type GstMode } from "@/lib/num";

// The editable lines of a quotation / job / invoice (A§2, D46) and their live totals. Values are checked with the
// same lib/lines.ts functions the server uses when saving.

export type CategoryOption = { id: number; name: string; hsnSac: string | null; gstBp: number };
export type CustomerOption = { id: number; name: string; firmName: string | null; stateCode: string };
type Row = LineText & { id: string };

let seq = 0;
const key = () => `line-${++seq}`;
const blank = (): Row => ({
  id: key(),
  lineId: "",
  categoryId: "",
  description: "",
  hsnSac: "",
  width: "",
  height: "",
  qty: "1",
  unit: "Nos",
  rate: "",
  discount: "",
  gst: "",
});

export function useLineRows(initial: LineText[]) {
  return useState<Row[]>(() => (initial.length ? initial.map((l) => ({ ...l, id: key() })) : [blank()]));
}

const fails = (parse: (s: string) => unknown) => (v: string) => {
  try {
    parse(v);
    return false;
  } catch {
    return true;
  }
};

/** A line's values with the category's HSN / GST filled in, or null while it can't be read. */
function priced(row: Row, categories: CategoryOption[]) {
  try {
    const l = readLine(row, 1);
    const category = categories.find((c) => c.id === l.categoryId);
    return { ...l, gstBp: l.gstBp ?? category?.gstBp ?? 0 };
  } catch {
    return null;
  }
}

/** The lines grid; posts them as JSON in the hidden "lines" field. */
export function LinesEditor({
  rows,
  setRows,
  categories,
}: {
  rows: Row[];
  setRows: (rows: Row[]) => void;
  categories: CategoryOption[];
}) {
  const columns: LineColumn[] = [
    {
      key: "categoryId",
      label: "Category",
      width: "w-44",
      placeholder: "Pick…",
      options: categories.map((c) => ({ value: String(c.id), label: c.name })),
    },
    { key: "description", label: "Description", placeholder: "What exactly" },
    { key: "hsnSac", label: "HSN/SAC", width: "w-24" },
    { key: "width", label: "W ft", numeric: true, width: "w-16", invalid: fails(parseQty) },
    { key: "height", label: "H ft", numeric: true, width: "w-16", invalid: fails(parseQty) },
    { key: "qty", label: "Qty", numeric: true, width: "w-20", invalid: fails(parseQty) },
    { key: "unit", label: "Unit", width: "w-20", suggestions: UNITS },
    { key: "rate", label: "Rate ₹", numeric: true, width: "w-24", invalid: fails(parseMoney) },
    { key: "discount", label: "Disc. ₹", numeric: true, width: "w-20", invalid: fails(parseMoney) },
    { key: "gst", label: "GST %", numeric: true, width: "w-16", invalid: fails(parsePercent) },
  ];

  // Category → its HSN/SAC and GST %; W / H / unit changed on a Sq Ft line → qty = W × H (D46), still editable.
  function onChange(next: Row[]) {
    setRows(
      next.map((row) => {
        const before = rows.find((r) => r.id === row.id);
        if (!before) return row;
        let r = row;
        if (r.categoryId !== before.categoryId) {
          const c = categories.find((c) => String(c.id) === r.categoryId);
          if (c) r = { ...r, hsnSac: c.hsnSac ?? "", gst: bpText(c.gstBp) };
        }
        if ((r.width !== before.width || r.height !== before.height || r.unit !== before.unit) && isSqFt(r.unit)) {
          try {
            r = { ...r, qty: milliText(sqFt(parseQty(r.width), parseQty(r.height))) };
          } catch {
            // sizes not both readable yet
          }
        }
        return r;
      }),
    );
  }

  return (
    <>
      <input type="hidden" name="lines" value={JSON.stringify(rows.map((r) => Object.fromEntries(LINE_KEYS.map((k) => [k, r[k]]))))} />
      <LineItemsGrid
        columns={columns}
        rows={rows}
        onChange={(next) => onChange(next as Row[])}
        newRow={blank}
        minWidth="min-w-[1080px]"
        amount={(row) => {
          const l = priced(row as Row, categories);
          return l ? <Money paise={divRound(l.qtyMilli * l.ratePaise, 1000n) - l.discountPaise} /> : "—";
        }}
      />
    </>
  );
}

/** Live totals beside the form: CGST + SGST, IGST or none (estimate), round-off, words. */
export function LinesTotals({ rows, categories, mode }: { rows: Row[]; categories: CategoryOption[]; mode: GstMode }) {
  const lines = rows.map((r) => priced(r, categories));
  if (lines.some((l) => !l)) {
    return <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Fix the highlighted lines to see totals.</div>;
  }
  let t;
  try {
    t = lineTotals(lines.map((l) => l!), mode);
  } catch {
    return null;
  }
  const rowsShown = [
    { label: mode === "estimate" ? "Sub total" : "Taxable value", paise: t.taxable },
    ...(mode === "same_state"
      ? [
          { label: "CGST", paise: t.cgst },
          { label: "SGST", paise: t.sgst },
        ]
      : mode === "other_state"
        ? [{ label: "IGST", paise: t.igst }]
        : []),
    { label: "Round off", paise: t.roundOff },
  ];
  return <TotalsPanel rows={rowsShown} total={t.total} words={amountInWords(t.total < 0n ? 0n : t.total)} />;
}

export function CustomerSelect({
  customers,
  value,
  onChange,
  disabled,
}: {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <NativeSelect name="customerId" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-full">
      <NativeSelectOption value="">Pick the customer…</NativeSelectOption>
      {customers.map((c) => (
        <NativeSelectOption key={c.id} value={String(c.id)}>
          {c.firmName ? `${c.name} · ${c.firmName}` : c.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
