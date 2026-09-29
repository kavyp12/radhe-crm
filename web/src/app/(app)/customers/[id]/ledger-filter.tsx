"use client";

import Form from "next/form";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/** The ledger's date range: a preset (picking one shows it at once) or custom From / To (DD/MM/YYYY). */
export function LedgerFilter({
  action,
  periods,
  period,
  from,
  to,
}: {
  action: string;
  periods: [string, string][];
  period: string;
  from: string | null;
  to: string | null;
}) {
  const [picked, setPicked] = useState(period);
  return (
    <Form action={action} scroll={false} className="flex flex-wrap items-start gap-2">
      <input type="hidden" name="tab" value="ledger" />
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
          <DateInput name="from" aria-label="From date" defaultValue={from ?? undefined} className="w-32" />
          <DateInput name="to" aria-label="To date" defaultValue={to ?? undefined} className="w-32" />
          <Button type="submit" variant="outline">
            Show
          </Button>
        </>
      )}
    </Form>
  );
}
