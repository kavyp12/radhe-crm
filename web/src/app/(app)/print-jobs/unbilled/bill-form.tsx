"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateText } from "@/components/date-text";
import { Field, FormError, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { StatusBadge, type Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";

export type Unbilled = {
  id: number;
  number: string;
  date: string;
  customer: string;
  fileName: string;
  type: string;
  /** the printing type has no invoice category: the one picked below is used */
  needsCategory: boolean;
  sqft: string;
  amount: bigint;
  received: bigint;
  status: Status;
  checked: boolean;
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

/** Tick print jobs → one draft invoice / estimate per customer (D64); what was received moves to it at Issue. */
export function BillPrintJobsForm({
  rows,
  categories,
  action,
}: {
  rows: Unbilled[];
  categories: { id: number; name: string }[];
  action: (s: FormState, f: FormData) => Promise<FormState>;
}) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  const [picked, setPicked] = useState(() => new Set(rows.filter((r) => r.checked).map((r) => r.id)));
  const chosen = rows.filter((r) => picked.has(r.id));
  const needsCategory = chosen.some((r) => r.needsCategory);
  const customers = new Set(chosen.map((r) => r.customer)).size;
  const toggle = (id: number) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="max-h-[calc(100svh-18rem)] overflow-auto rounded-lg border bg-card">
        <table className="w-full min-w-200 border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className={`${th} w-10`} />
              <th className={th}>Print job</th>
              <th className={th}>Date</th>
              <th className={th}>Customer</th>
              <th className={th}>File</th>
              <th className={th}>Type</th>
              <th className={`${th} text-right`}>Sq ft</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={`${th} text-right`}>Received</th>
              <th className={th}>Payment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <input
                    type="checkbox"
                    name="printJobId"
                    value={r.id}
                    checked={picked.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Bill ${r.number}`}
                    className="size-4 accent-primary"
                  />
                </td>
                <td className={`${td} font-medium tabular-nums`}>{r.number}</td>
                <td className={td}>
                  <DateText date={r.date} />
                </td>
                <td className={td}>{r.customer}</td>
                <td className={`${td} max-w-56 truncate`}>{r.fileName}</td>
                <td className={td}>{r.type}</td>
                <td className={`${td} text-right tabular-nums`}>{r.sqft}</td>
                <td className={`${td} text-right`}>
                  <Money paise={r.amount} />
                </td>
                <td className={`${td} text-right`}>
                  <Money paise={r.received} />
                </td>
                <td className={td}>
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Bill as">
          <NativeSelect name="kind" defaultValue="tax" className="w-48">
            <NativeSelectOption value="tax">Tax Invoice</NativeSelectOption>
            <NativeSelectOption value="estimate">Estimate (no GST)</NativeSelectOption>
          </NativeSelect>
        </Field>
        {needsCategory && (
          <Field label="Category (types without one)">
            <NativeSelect name="categoryId" defaultValue="" required className="w-56">
              <NativeSelectOption value="">Pick the category…</NativeSelectOption>
              {categories.map((c) => (
                <NativeSelectOption key={c.id} value={String(c.id)}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Button type="submit" disabled={pending || !chosen.length}>
          {pending ? "Working…" : customers > 1 ? `Create ${customers} drafts` : "Create draft"}
        </Button>
      </div>
      <FormError state={state} />
    </form>
  );
}
