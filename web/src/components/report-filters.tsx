"use client";

import Form from "next/form";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { ReportPick } from "@/lib/reports";

/** A report's filters (S20): the period (picking a preset shows it at once; Custom asks for From / To) and pick-ones. */
export function ReportFilters({
  periods,
  period,
  from,
  to,
  picks = [],
}: {
  periods: [string, string][];
  period: string;
  from?: string;
  to?: string;
  picks?: ReportPick[];
}) {
  const [picked, setPicked] = useState(period);
  return (
    <Form action="" scroll={false} className="flex flex-wrap items-start gap-2">
      <NativeSelect
        name="period"
        aria-label="Period"
        value={picked}
        onChange={(e) => {
          setPicked(e.target.value);
          if (e.target.value !== "custom") e.currentTarget.form?.requestSubmit();
        }}
      >
        {periods.map(([value, label]) => (
          <NativeSelectOption key={value} value={value}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {picked === "custom" && (
        <>
          <DateInput name="from" aria-label="From date" defaultValue={from} className="w-32" />
          <DateInput name="to" aria-label="To date" defaultValue={to} className="w-32" />
          <Button type="submit" variant="outline">
            Show
          </Button>
        </>
      )}
      {picks.map((p) => (
        <NativeSelect
          key={p.name}
          name={p.name}
          aria-label={p.label}
          defaultValue={p.value}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          <NativeSelectOption value="">{p.empty ?? `All (${p.label.toLowerCase()})`}</NativeSelectOption>
          {p.options.map(([value, label]) => (
            <NativeSelectOption key={value} value={value}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ))}
    </Form>
  );
}
