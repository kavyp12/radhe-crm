"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { LineItemsGrid, TotalsPanel, type LineColumn, type LineRow } from "@/components/line-items";
import { Money } from "@/components/money";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { gstMode } from "@/lib/lines";
import { amountInWords, bpText, parseMoney, parsePercent, parseQty } from "@/lib/num";
import { billTotals, blankLine, PURCHASE_LINE_KEYS, readPurchaseLine, taxableOf, type PurchaseLineText } from "@/lib/purchase-lines";

export type BillFormOptions = {
  vendors: { id: number; name: string; stateCode: string; registered: boolean; creditDays: number | null }[];
  items: { id: number; name: string; unit: string; gstBp: number | null }[];
  categories: { id: number; name: string }[];
  jobs: { id: number; number: string; customer: string }[];
  companyState: string;
};

export type BillFormValues = {
  vendorId: string;
  vendorBillNo: string;
  date: string;
  roundOff: string;
  notes: string;
  lines: PurchaseLineText[];
};

type Row = LineRow & PurchaseLineText;
let seq = 0;
const blank = (): Row => ({ id: `pl-${++seq}`, what: "", description: "", qty: "", rate: "", gst: "", jobId: "", grnLineId: "" });
/** A line billing a GRN line keeps the item and qty as received (T23); the rate and GST % are the vendor's. */
const fromGrn = (row: LineRow, key: string) => !!(row as Row).grnLineId && ["what", "qty", "jobId"].includes(key);

const fails = (parse: (s: string) => unknown) => (v: string) => {
  try {
    parse(v);
    return false;
  } catch {
    return true;
  }
};

/** Typed rupees → paise; blank = null (auto), unreadable = undefined. */
function typedPaise(text: string): bigint | null | undefined {
  if (!text.trim()) return null;
  try {
    return parseMoney(text);
  } catch {
    return undefined;
  }
}

export function BillForm({
  values: v,
  options,
  askReason,
  submitLabel,
  back,
  action,
}: {
  values: BillFormValues;
  options: BillFormOptions;
  askReason?: boolean;
  submitLabel: string;
  back: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push(back);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [vendorId, setVendorId] = useState(v.vendorId);
  const [rows, setRows] = useState<Row[]>(() => (v.lines.length ? v.lines.map((l) => ({ ...blank(), ...l })) : [blank()]));
  const [roundOff, setRoundOff] = useState(v.roundOff);
  const vendor = options.vendors.find((x) => String(x.id) === vendorId);
  const mode = gstMode(vendor?.stateCode ?? options.companyState, options.companyState);

  const columns: LineColumn[] = [
    {
      key: "what",
      label: "Item / expense",
      width: "w-56",
      placeholder: "Pick…",
      options: [
        ...options.items.map((i) => ({ value: `item:${i.id}`, label: `${i.name} (${i.unit})` })),
        ...options.categories.map((c) => ({ value: `cat:${c.id}`, label: `Expense · ${c.name}` })),
      ],
    },
    { key: "description", label: "Description", placeholder: "Optional" },
    { key: "qty", label: "Qty", numeric: true, width: "w-20", invalid: fails(parseQty) },
    { key: "rate", label: "Rate ₹", numeric: true, width: "w-24", invalid: fails(parseMoney) },
    { key: "gst", label: "GST %", numeric: true, width: "w-16", invalid: fails(parsePercent) },
    {
      key: "jobId",
      label: "Job (expense lines)",
      width: "w-48",
      placeholder: "—",
      options: options.jobs.map((j) => ({ value: String(j.id), label: `${j.number} · ${j.customer}` })),
    },
  ];

  // Picking an item fills its GST % (0 for an unregistered vendor, D51); a stock line takes no job (D51).
  function onChange(next: Row[]) {
    setRows(
      next.map((row) => {
        const before = rows.find((r) => r.id === row.id);
        if (!before || row.what === before.what) return row;
        let r = row;
        if (r.what.startsWith("item:")) r = { ...r, jobId: "" };
        const item = options.items.find((i) => `item:${i.id}` === r.what);
        if (vendor && !vendor.registered) r = { ...r, gst: "0" };
        else if (item?.gstBp != null) r = { ...r, gst: bpText(item.gstBp) };
        return r;
      }),
    );
  }

  const read = rows.filter((r) => !blankLine(r)).map((r, i) => {
    try {
      return readPurchaseLine(r, i + 1);
    } catch {
      return null;
    }
  });
  const typed = typedPaise(roundOff);
  let totals: ReturnType<typeof billTotals> | null = null;
  let roundOffError: string | null = typed === undefined ? "Enter an amount like 0.40 or -0.60." : null;
  if (read.length && read.every((l) => l !== null)) {
    try {
      totals = billTotals(read.map((l) => l!), mode, typed ?? null);
    } catch (e) {
      roundOffError = (e as Error).message;
      totals = billTotals(read.map((l) => l!), mode);
    }
  }
  const json = JSON.stringify(rows.map((r) => Object.fromEntries(PURCHASE_LINE_KEYS.map((k) => [k, r[k]]))));

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <FormSection title="Vendor bill" description="Numbered when saved (PB/…), posted to the books, and stock items are taken into stock.">
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
          <Field label="Vendor's bill no" error={error("vendorBillNo")}>
            <Input name="vendorBillNo" defaultValue={v.vendorBillNo} maxLength={50} required />
          </Field>
          <Field
            label="Bill date"
            hint={vendor ? `Due ${vendor.creditDays ?? 0} days after (vendor's credit days).` : undefined}
            error={error("date")}
          >
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
          description={
            rows.some((r) => r.grnLineId)
              ? "Lines from a GRN keep the item and qty as received: enter the vendor's rate (the difference goes to price variance). Add freight etc. as expense lines."
              : "A stock item, or an expense category (with its job, if it is for one)."
          }
        >
          <input type="hidden" name="lines" value={json} />
          <LineItemsGrid
            columns={columns}
            rows={rows}
            onChange={(next) => onChange(next as Row[])}
            newRow={blank}
            minWidth="min-w-[980px]"
            locked={fromGrn}
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
        <div className="grid gap-4 lg:sticky lg:top-4">
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
          <Field label="Round off (₹)" hint="Blank = to the nearest rupee. Change it (±1) to match the vendor's total." error={error("roundOff") ?? roundOffError ?? undefined}>
            <Input name="roundOff" value={roundOff} onChange={(e) => setRoundOff(e.target.value)} inputMode="decimal" className="text-right tabular-nums" />
          </Field>
        </div>
      </div>

      <FormSection title="Notes">
        <Field label="Notes" error={error("notes")}>
          <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
        </Field>
      </FormSection>

      {askReason && (
        <FormSection title="Reason" description="The owner approves the change; say why.">
          <Textarea name="reason" rows={2} maxLength={500} aria-label="Reason" />
        </FormSection>
      )}

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
