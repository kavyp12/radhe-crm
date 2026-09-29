"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { LineItemsGrid, TotalsPanel, type LineColumn, type LineRow } from "@/components/line-items";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { gstMode } from "@/lib/lines";
import { amountInWords, bpText, moneyText, parseMoney, parsePercent, parseQty } from "@/lib/num";
import { billTotals, blankOrderLine, ORDER_LINE_KEYS, readOrderLine, taxableOf, type OrderLineText } from "@/lib/purchase-lines";

export type OrderFormOptions = {
  vendors: { id: number; name: string; stateCode: string; registered: boolean }[];
  items: { id: number; name: string; unit: string; gstBp: number | null; lastRate: bigint | null }[];
  companyState: string;
};
export type OrderFormValues = { vendorId: string; date: string; notes: string; lines: OrderLineText[] };

type Row = LineRow & OrderLineText;
let seq = 0;
const blank = (): Row => ({ id: `po-${++seq}`, itemId: "", description: "", qty: "", rate: "", gst: "", requestLineId: "" });

const fails = (parse: (s: string) => unknown) => (v: string) => {
  try {
    parse(v);
    return false;
  } catch {
    return true;
  }
};

export function OrderForm({
  values: v,
  options,
  submitLabel,
  action,
}: {
  values: OrderFormValues;
  options: OrderFormOptions;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [vendorId, setVendorId] = useState(v.vendorId);
  const [rows, setRows] = useState<Row[]>(() => (v.lines.length ? v.lines.map((l) => ({ ...blank(), ...l })) : [blank()]));
  const vendor = options.vendors.find((x) => String(x.id) === vendorId);
  const mode = gstMode(vendor?.stateCode ?? options.companyState, options.companyState);

  const columns: LineColumn[] = [
    {
      key: "itemId",
      label: "Item",
      width: "w-56",
      placeholder: "Pick…",
      options: options.items.map((i) => ({ value: String(i.id), label: `${i.name} (${i.unit})` })),
    },
    { key: "description", label: "Description", placeholder: "Optional" },
    { key: "qty", label: "Qty", numeric: true, width: "w-20", invalid: fails(parseQty) },
    { key: "rate", label: "Rate ₹", numeric: true, width: "w-24", invalid: fails(parseMoney) },
    { key: "gst", label: "GST %", numeric: true, width: "w-16", invalid: fails(parsePercent) },
  ];

  // Picking an item fills its last purchase rate and GST % (0 for an unregistered vendor, as on bills). A line copied
  // from a request keeps its item (the server checks it too).
  function onChange(next: Row[]) {
    setRows(
      next.map((row) => {
        const before = rows.find((r) => r.id === row.id);
        if (!before || row.itemId === before.itemId) return row;
        const item = options.items.find((i) => String(i.id) === row.itemId);
        if (!item) return row;
        return {
          ...row,
          rate: item.lastRate === null ? row.rate : moneyText(item.lastRate),
          gst: vendor && !vendor.registered ? "0" : item.gstBp === null ? row.gst : bpText(item.gstBp),
        };
      }),
    );
  }

  const read = rows.filter((r) => !blankOrderLine(r)).map((r, i) => {
    try {
      return readOrderLine(r, i + 1);
    } catch {
      return null;
    }
  });
  const totals = read.length && read.every((l) => l !== null) ? billTotals(read.map((l) => l!), mode) : null;
  const json = JSON.stringify(rows.map((r) => Object.fromEntries(ORDER_LINE_KEYS.map((k) => [k, r[k]]))));

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection title="Order" description="Numbered when saved (PO/…). Orders don't post to the books.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Vendor" error={error("vendorId")} className="sm:col-span-2">
            <NativeSelect name="vendorId" value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full" required>
              <NativeSelectOption value="">Pick the vendor…</NativeSelectOption>
              {options.vendors.map((x) => (
                <NativeSelectOption key={x.id} value={String(x.id)}>
                  {x.name}
                  {x.registered ? "" : " (unregistered)"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Order date" error={error("date")}>
            <DateInput name="date" defaultValue={v.date} required />
          </Field>
        </div>
        {vendor && (
          <p className="mt-3 text-xs text-muted-foreground">
            {mode === "same_state" ? "Same state: CGST + SGST." : "Other state: IGST."}
            {!vendor.registered && " Unregistered vendor: GST % starts at 0."}
          </p>
        )}
      </FormSection>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <FormSection
          title="Lines"
          description="Rates start at the item's last purchase rate. Lines from a request keep their item; change the qty or remove them."
        >
          <input type="hidden" name="lines" value={json} />
          <LineItemsGrid
            columns={columns}
            rows={rows}
            onChange={(next) => onChange(next as Row[])}
            newRow={blank}
            minWidth="min-w-[760px]"
            locked={(row, key) => !!(row as Row).requestLineId && key === "itemId"}
            amount={(row) => {
              try {
                return <Money paise={taxableOf({ qtyMilli: parseQty((row as Row).qty), ratePaise: parseMoney((row as Row).rate) })} />;
              } catch {
                return "—";
              }
            }}
          />
          {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
        </FormSection>
        <div className="lg:sticky lg:top-4">
          {totals ? (
            <TotalsPanel
              rows={[
                { label: "Taxable value", paise: totals.taxable },
                ...(mode === "same_state"
                  ? [
                      { label: "CGST", paise: totals.cgst },
                      { label: "SGST", paise: totals.sgst },
                    ]
                  : [{ label: "IGST", paise: totals.igst }]),
                { label: "Round off", paise: totals.roundOff },
              ]}
              total={totals.total}
              words={amountInWords(totals.total < 0n ? 0n : totals.total)}
            />
          ) : (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Fill the lines to see totals.</div>
          )}
        </div>
      </div>

      <FormSection title="Notes" description="Internal: not printed on the order.">
        <Field label="Notes" error={error("notes")}>
          <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
        </Field>
      </FormSection>

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
