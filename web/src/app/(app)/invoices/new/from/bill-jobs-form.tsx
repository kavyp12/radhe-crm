"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { DateText } from "@/components/date-text";
import { FormError, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { StatusBadge, type Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";

type Job = { id: number; number: string; date: string; status: Status; total: bigint };

/** Tick the jobs to bill on one invoice (their lines are copied on the server). */
export function BillJobsForm({ jobs, action }: { jobs: Job[]; action: (s: FormState, f: FormData) => Promise<FormState> }) {
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="h-9 w-10 border-b px-3" />
              <th className="h-9 border-b px-3 font-medium">Job</th>
              <th className="h-9 border-b px-3 font-medium">Date</th>
              <th className="h-9 border-b px-3 font-medium">Status</th>
              <th className="h-9 border-b px-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="border-b px-3 py-2">
                  <input
                    type="checkbox"
                    name="jobId"
                    value={j.id}
                    defaultChecked
                    aria-label={`Bill ${j.number}`}
                    className="size-4 accent-primary"
                  />
                </td>
                <td className="border-b px-3 py-2 font-medium tabular-nums">{j.number}</td>
                <td className="border-b px-3 py-2">
                  <DateText date={j.date} />
                </td>
                <td className="border-b px-3 py-2">
                  <StatusBadge status={j.status} />
                </td>
                <td className="border-b px-3 py-2 text-right">
                  <Money paise={j.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect name="kind" defaultValue="tax" aria-label="Kind" className="w-48">
          <NativeSelectOption value="tax">Tax Invoice</NativeSelectOption>
          <NativeSelectOption value="estimate">Estimate (no GST)</NativeSelectOption>
        </NativeSelect>
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : "Create draft invoice"}
        </Button>
      </div>
      <FormError state={state} />
    </form>
  );
}
