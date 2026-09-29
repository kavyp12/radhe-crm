"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { TotalsPanel } from "@/components/line-items";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { amountInWords, bpText, divRound, milliText, moneyText, noteTotals, parseMoney, parseQty, type GstMode } from "@/lib/num";

/** An invoice line and what a note of this kind can still take from it. */
export type NoteFormLine = {
  invoiceLineId: number;
  position: number;
  item: string;
  detail: string;
  unit: string;
  qty: bigint;
  taxable: bigint;
  qtyLeft: bigint;
  taxableLeft: bigint;
  gstBp: number;
};

type Props = {
  kind: "credit" | "debit";
  lines: NoteFormLine[];
  mode: GstMode;
  values: { date: string; reason: string; notes: string; lines: Record<number, { qty: string; amount: string }> };
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

const read = <T,>(parse: (s: string) => T, text: string): T | null | undefined => {
  if (!text.trim()) return undefined;
  try {
    return parse(text);
  } catch {
    return null;
  }
};

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5 align-top";

export function NoteForm({ kind, lines, mode, values: v, submitLabel, action }: Props) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [rows, setRows] = useState(() =>
    lines.map((l) => {
      const typed = v.lines[l.invoiceLineId];
      return { ...l, qtyText: typed?.qty ?? "", amountText: typed?.amount ?? "" };
    }),
  );

  /** A qty fills the amount pro rata (qty × the line's taxable ÷ its qty), never above what is left. */
  function changeQty(id: number, text: string) {
    setRows((current) =>
      current.map((r) => {
        if (r.invoiceLineId !== id) return r;
        const qty = read(parseQty, text);
        if (!qty || qty <= 0n) return { ...r, qtyText: text };
        const share = divRound(r.taxable * qty, r.qty);
        return { ...r, qtyText: text, amountText: moneyText(share < r.taxableLeft ? share : r.taxableLeft) };
      }),
    );
  }
  const changeAmount = (id: number, text: string) =>
    setRows((current) => current.map((r) => (r.invoiceLineId === id ? { ...r, amountText: text } : r)));

  const picked = rows.map((r) => ({ r, qty: read(parseQty, r.qtyText), amount: read(parseMoney, r.amountText) }));
  const readable = picked.every((p) => p.qty !== null && p.amount !== null);
  const totals = readable
    ? noteTotals(
        picked.filter((p) => p.amount && p.amount > 0n).map((p) => ({ taxable: p.amount!, gstBp: p.r.gstBp })),
        mode,
      )
    : null;
  const json = JSON.stringify(rows.map((r) => ({ invoiceLineId: String(r.invoiceLineId), qty: r.qtyText, amount: r.amountText })));

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="grid grid-cols-1 gap-4">
          <FormSection
            title={kind === "credit" ? "Credit note" : "Debit note"}
            description="Saved as a draft. The number comes when it is issued."
          >
            <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
              <Field label="Date" error={error("date")}>
                <DateInput name="date" defaultValue={v.date} required />
              </Field>
              <Field
                label="Reason"
                hint={kind === "credit" ? "Return, rate correction, discount …" : "Rate revised, extra work …"}
                error={error("reason")}
              >
                <Input name="reason" defaultValue={v.reason} maxLength={500} required />
              </Field>
            </div>
          </FormSection>
          <FormSection
            title="Lines from the invoice"
            description={`Enter a qty and / or the taxable amount on the lines to ${kind === "credit" ? "credit" : "charge"}. GST follows the invoice.`}
          >
            <input type="hidden" name="lines" value={json} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-180 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} w-8 text-right`}>#</th>
                    <th className={th}>Item</th>
                    <th className={`${th} text-right`}>Invoiced</th>
                    <th className={`${th} text-right`}>Left</th>
                    <th className={`${th} w-24 text-right`}>Qty</th>
                    <th className={`${th} w-32 text-right`}>Amount ₹</th>
                    {mode !== "estimate" && <th className={`${th} text-right`}>GST %</th>}
                  </tr>
                </thead>
                <tbody>
                  {picked.map(({ r, qty, amount }) => (
                    <tr key={r.invoiceLineId}>
                      <td className={`${td} text-right text-muted-foreground tabular-nums`}>{r.position}</td>
                      <td className={td}>
                        <div className="font-medium">{r.item}</div>
                        {r.detail && <div className="text-xs text-muted-foreground">{r.detail}</div>}
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <div className="tabular-nums">
                          {milliText(r.qty)} {r.unit}
                        </div>
                        <Money paise={r.taxable} className="text-xs text-muted-foreground" />
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <div className="tabular-nums">
                          {milliText(r.qtyLeft)} {r.unit}
                        </div>
                        <Money paise={r.taxableLeft} className="text-xs text-muted-foreground" />
                      </td>
                      <td className="border-b px-2 py-1">
                        <Input
                          aria-label={`Qty, line ${r.position}`}
                          aria-invalid={qty === null || (!!qty && qty > r.qtyLeft) || undefined}
                          inputMode="decimal"
                          value={r.qtyText}
                          onChange={(e) => changeQty(r.invoiceLineId, e.target.value)}
                          className="h-8 text-right tabular-nums"
                        />
                      </td>
                      <td className="border-b px-2 py-1">
                        <Input
                          aria-label={`Amount, line ${r.position}`}
                          aria-invalid={amount === null || (!!amount && amount > r.taxableLeft) || undefined}
                          inputMode="decimal"
                          value={r.amountText}
                          onChange={(e) => changeAmount(r.invoiceLineId, e.target.value)}
                          className="h-8 text-right tabular-nums"
                        />
                      </td>
                      {mode !== "estimate" && <td className={`${td} text-right tabular-nums`}>{bpText(r.gstBp)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
          </FormSection>
          <FormSection title="Notes">
            <Field label="Notes" hint="Internal, not printed." error={error("notes")}>
              <Textarea name="notes" rows={3} defaultValue={v.notes} maxLength={2000} />
            </Field>
          </FormSection>
        </div>
        <div className="lg:sticky lg:top-4">
          {totals ? (
            <TotalsPanel
              rows={[
                { label: mode === "estimate" ? "Sub total" : "Taxable value", paise: totals.taxable },
                ...(mode === "same_state"
                  ? [
                      { label: "CGST", paise: totals.cgst },
                      { label: "SGST", paise: totals.sgst },
                    ]
                  : mode === "other_state"
                    ? [{ label: "IGST", paise: totals.igst }]
                    : []),
              ]}
              total={totals.total}
              words={amountInWords(totals.total)}
            />
          ) : (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Fix the highlighted cells to see totals.</div>
          )}
        </div>
      </div>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
