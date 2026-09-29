"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { LineItemsGrid, type LineColumn, type LineRow } from "@/components/line-items";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { milliText, parseQty } from "@/lib/num";

/** Items with their qty in stock (no values: production raises requests). */
export type RequestItem = { id: number; name: string; unit: string; qty: bigint };
export type RequestJob = { id: number; number: string; customer: string };

type Row = LineRow & { itemId: string; qty: string };
let seq = 0;
const blank = (): Row => ({ id: `mr-${++seq}`, itemId: "", qty: "" });
const badQty = (v: string) => {
  try {
    return parseQty(v) <= 0n;
  } catch {
    return true;
  }
};

export function RequestForm({
  items,
  jobs,
  jobId,
  today,
  action,
}: {
  items: RequestItem[];
  jobs: RequestJob[];
  jobId: string;
  today: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const columns: LineColumn[] = [
    {
      key: "itemId",
      label: "Item",
      placeholder: "Pick…",
      options: items.map((i) => ({ value: String(i.id), label: `${i.name} · ${milliText(i.qty)} ${i.unit} in stock` })),
    },
    { key: "qty", label: "Qty needed", numeric: true, width: "w-28", invalid: badQty },
  ];

  return (
    <form onSubmit={onSubmit} className="grid max-w-4xl grid-cols-1 gap-4">
      <FormSection title="Request" description="Numbered MR/… when saved; the owner approves it before anything is ordered.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Needed by" error={error("neededBy")}>
            <DateInput name="neededBy" defaultValue={today} required />
          </Field>
          <Field label="Job (optional)" error={error("jobId")}>
            <NativeSelect name="jobId" defaultValue={jobId} className="w-full">
              <NativeSelectOption value="">No job: for stock</NativeSelectOption>
              {jobs.map((j) => (
                <NativeSelectOption key={j.id} value={String(j.id)}>
                  {j.number} · {j.customer}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </FormSection>
      <FormSection title="Items" description="Each item once, with the qty needed.">
        <input type="hidden" name="lines" value={JSON.stringify(rows.map((r) => ({ itemId: r.itemId, qty: r.qty })))} />
        <LineItemsGrid columns={columns} rows={rows} onChange={(next) => setRows(next as Row[])} newRow={blank} minWidth="min-w-[480px]" />
        {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
      </FormSection>
      <FormSection title="Note">
        <Field label="Note" error={error("notes")}>
          <Textarea name="notes" rows={2} maxLength={1000} placeholder="Size, colour, brand…" />
        </Field>
      </FormSection>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Send request"}
        </Button>
      </FormActions>
    </form>
  );
}
