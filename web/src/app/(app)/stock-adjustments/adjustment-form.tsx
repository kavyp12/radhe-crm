"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { milliText } from "@/lib/num";

export type AdjustItem = { id: number; name: string; unit: string; qty: bigint; average?: bigint | null };

export function AdjustmentForm({
  items,
  today,
  itemId,
  cost,
  owner,
  action,
}: {
  items: AdjustItem[];
  today: string;
  itemId: string;
  /** can_view_cost: shows the average and the rate field. */
  cost: boolean;
  owner: boolean;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push("/stock-adjustments");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [picked, setPicked] = useState(itemId);
  const item = items.find((i) => String(i.id) === picked);

  return (
    <form onSubmit={onSubmit} className="grid max-w-3xl grid-cols-1 gap-4">
      <FormSection
        title="Adjustment"
        description="Plus = found more than the books show; minus = short, damaged or wasted. Valued at the average cost."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Item" error={error("itemId")} className="sm:col-span-2">
            <NativeSelect name="itemId" value={picked} onChange={(e) => setPicked(e.target.value)} className="w-full" required>
              <NativeSelectOption value="">Pick the item…</NativeSelectOption>
              {items.map((i) => (
                <NativeSelectOption key={i.id} value={String(i.id)}>
                  {i.name} · {milliText(i.qty)} {i.unit} in stock
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {item && cost && item.average !== undefined && (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Average cost: {item.average === null ? "none yet (no stock)" : <Money paise={item.average} />} / {item.unit}
            </p>
          )}
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={today} required />
          </Field>
          <Field label={`Qty${item ? ` (${item.unit})` : ""}`} hint="5 adds stock, -5 takes it off." error={error("qty")}>
            <Input name="qty" inputMode="decimal" required className="text-right tabular-nums" />
          </Field>
          {cost && (
            <Field label="Rate per unit (₹)" hint="Only used when the item has no stock (no average yet)." error={error("rate")}>
              <Input name="rate" inputMode="decimal" className="text-right tabular-nums" />
            </Field>
          )}
          <Field label="Reason" error={error("reason")} className="sm:col-span-2">
            <Textarea name="reason" rows={2} maxLength={500} required />
          </Field>
        </div>
      </FormSection>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : owner ? "Save adjustment" : "Ask the owner"}
        </Button>
      </FormActions>
    </form>
  );
}
