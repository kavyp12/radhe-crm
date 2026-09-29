"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { milliText, parseQty } from "@/lib/num";
import { taxableOf } from "@/lib/purchase-lines";
import { cn } from "@/lib/utils";

export type ReceiveLine = { id: number; name: string; unit: string; rate: bigint; ordered: bigint; received: bigint; pending: bigint };

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5";

/** Qty as typed → thousandths; blank = 0; unreadable = null. */
function qtyOf(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseQty(text);
  } catch {
    return null;
  }
}

export function ReceiveForm({
  orderId,
  lines,
  today,
  action,
}: {
  orderId: number;
  lines: ReceiveLine[];
  today: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push("/material-receive");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  // Everything still to come, by default; change what actually arrived (blank / 0 = not this time).
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.pending > 0n ? milliText(l.pending) : ""])),
  );
  const values = lines.map((l) => qtyOf(qty[l.id] ?? ""));
  const total = lines.reduce((s, l, i) => s + (values[i] && values[i]! > 0n ? taxableOf({ qtyMilli: values[i]!, ratePaise: l.rate }) : 0n), 0n);
  const json = JSON.stringify(lines.map((l) => ({ orderLineId: String(l.id), qty: qty[l.id] ?? "" })));

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="lines" value={json} />
      <FormSection title="Received" description="Numbered GRN/… when saved; the stock comes in at the PO rate. Partial is fine.">
        <div className="grid gap-4">
          <Field label="Date received" error={error("date")} className="sm:max-w-60">
            <DateInput name="date" defaultValue={today} required />
          </Field>
          <div className="overflow-x-auto">
            <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Ordered</th>
                  <th className={`${th} text-right`}>Received before</th>
                  <th className={`${th} text-right`}>To come</th>
                  <th className={`${th} w-32 text-right`}>Received now</th>
                  <th className={`${th} text-right`}>Value (PO rate)</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const bad = values[i] === null || (values[i] ?? 0n) > l.pending;
                  return (
                    <tr key={l.id} className={l.pending <= 0n ? "text-muted-foreground" : undefined}>
                      <td className={`${td} font-medium`}>{l.name}</td>
                      <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                        {milliText(l.ordered)} {l.unit}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>{milliText(l.received)}</td>
                      <td className={`${td} text-right tabular-nums`}>{milliText(l.pending)}</td>
                      <td className="border-b px-2 py-1">
                        <Input
                          aria-label={`Received now: ${l.name}`}
                          aria-invalid={bad || undefined}
                          inputMode="decimal"
                          value={qty[l.id] ?? ""}
                          disabled={l.pending <= 0n}
                          onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
                          className={cn("h-8 text-right tabular-nums", bad && "border-destructive/60")}
                        />
                      </td>
                      <td className={`${td} text-right`}>
                        {values[i] && values[i]! > 0n ? <Money paise={taxableOf({ qtyMilli: values[i]!, ratePaise: l.rate })} /> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">Stock value in: </span>
            <Money paise={total} />
          </p>
          {error("lines") && <p className="text-sm text-destructive">{error("lines")}</p>}
        </div>
      </FormSection>
      <FormSection title="Notes">
        <Field label="Notes" hint="Challan no, vehicle, who checked it…" error={error("notes")}>
          <Textarea name="notes" rows={2} maxLength={1000} />
        </Field>
      </FormSection>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save GRN"}
        </Button>
      </FormActions>
    </form>
  );
}
