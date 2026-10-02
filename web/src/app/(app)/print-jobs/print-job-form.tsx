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
import { milliText, moneyText, parseMoney, parseQty, printAmount, printSqFt } from "@/lib/num";
import { cn } from "@/lib/utils";

export type PrintFormOptions = {
  customers: { id: number; name: string; firmName: string | null; mobile: string | null }[];
  jobs: { id: number; number: string; customerId: number }[];
  /** costRatePaise: only for can_view_cost users (null otherwise, or not set yet). */
  machines: { id: number; name: string; saleRatePaise: bigint | null; costRatePaise: bigint | null }[];
  types: { id: number; name: string }[];
};

export type PrintJobValues = {
  customerId: string;
  jobId: string;
  fileName: string;
  filePath: string;
  machineId: string;
  printingTypeId: string;
  width: string;
  height: string;
  qty: string;
  rate: string;
  notes: string;
  reprintOfId: string;
  date: string; // 'YYYY-MM-DD'
  time: string; // HH:MM
};

type Props = {
  values: PrintJobValues;
  options: PrintFormOptions;
  operator: string;
  /** Set when editing: no payment, date or quick-add customer (A§11: an edit changes the print, not the money). */
  editId?: number;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
};

const label = (c: PrintFormOptions["customers"][number]) => [c.name, c.firmName, c.mobile].filter(Boolean).join(" · ");
const qty = (text: string) => {
  try {
    const v = parseQty(text);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};
const money = (text: string) => {
  if (!text.trim()) return null;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
};

/** P2's popup as a form: the same fields, sq ft and amount worked out as you type (D64). */
export function PrintJobForm({ values: v, options, operator, editId, submitLabel, action }: Props) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      if (editId) router.push(`/print-jobs/${editId}`);
      else router.push("/print-jobs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const start = options.customers.find((c) => String(c.id) === v.customerId);
  const [customerText, setCustomerText] = useState(start ? label(start) : "");
  const customer = options.customers.find((c) => label(c) === customerText);
  const quickAdd = !editId && !customer && customerText.trim() !== "";
  const [jobId, setJobId] = useState(v.jobId);
  const jobs = customer ? options.jobs.filter((j) => j.customerId === customer.id) : [];
  const onJob = jobId !== "" && jobs.some((j) => String(j.id) === jobId);

  const [machineId, setMachineId] = useState(v.machineId);
  const machine = options.machines.find((m) => String(m.id) === machineId);
  const [rate, setRate] = useState(v.rate);
  const [width, setWidth] = useState(v.width);
  const [height, setHeight] = useState(v.height);
  const [count, setCount] = useState(v.qty);
  const [payment, setPayment] = useState<"paid" | "unpaid" | "credit">("paid");
  const [advance, setAdvance] = useState("");

  const [w, h, q] = [qty(width), qty(height), qty(count)];
  const sqft = w && h && q ? printSqFt(w, h, q) : null;
  const ratePaise = onJob ? (machine?.costRatePaise ?? null) : money(rate) ?? (rate.trim() ? null : (machine?.saleRatePaise ?? null));
  const amount = sqft !== null && ratePaise !== null ? printAmount(sqft, ratePaise) : null;
  const received = payment === "paid" ? amount : payment === "unpaid" ? money(advance) ?? 0n : 0n;

  function pickMachine(id: string) {
    setMachineId(id);
    const next = options.machines.find((m) => String(m.id) === id);
    // The machine's sale rate, unless a rate was typed for this print.
    if (!rate.trim() || rate === (machine?.saleRatePaise != null ? moneyText(machine.saleRatePaise) : "")) {
      setRate(next?.saleRatePaise != null ? moneyText(next.saleRatePaise) : "");
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <input type="hidden" name="reprintOfId" value={v.reprintOfId} />
      <FormSection title="Print" description={editId ? "Saved changes are kept in History." : "Numbered PJ/… when saved."}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Customer"
            hint={quickAdd ? "Not in the list: added as a new customer (an existing mobile picks that customer)." : "Type to search name, firm or mobile."}
            error={error("customerId")}
            className="sm:col-span-2 lg:col-span-1"
          >
            <Input
              list="print-customers"
              value={customerText}
              onChange={(e) => {
                setCustomerText(e.target.value);
                setJobId("");
              }}
              autoComplete="off"
              required
            />
          </Field>
          <datalist id="print-customers">
            {options.customers.map((c) => (
              <option key={c.id} value={label(c)} />
            ))}
          </datalist>
          <input type="hidden" name="customerId" value={customer ? String(customer.id) : ""} />
          {quickAdd && (
            <>
              <input type="hidden" name="newCustomerName" value={customerText.trim()} />
              <Field label="New customer's mobile" error={error("newCustomerMobile")}>
                <Input name="newCustomerMobile" inputMode="tel" maxLength={20} required />
              </Field>
            </>
          )}
          <Field label="Job" hint="An existing job takes the print as its cost; New is a sale, billed later." error={error("jobId")}>
            <NativeSelect name="jobId" value={onJob ? jobId : ""} onChange={(e) => setJobId(e.target.value)} className="w-full">
              <NativeSelectOption value="">New print (sale)</NativeSelectOption>
              {jobs.map((j) => (
                <NativeSelectOption key={j.id} value={String(j.id)}>
                  {j.number}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="File name" error={error("fileName")}>
            <Input name="fileName" defaultValue={v.fileName} maxLength={260} required placeholder="ABC_FRONT_BOARD.cdr" />
          </Field>
          <Field label="File location" hint="Full path, for Open File." error={error("filePath")} className="sm:col-span-2">
            <Input name="filePath" defaultValue={v.filePath} maxLength={1000} placeholder="D:\RADHE JOBS\ABC\ABC_FRONT_BOARD.cdr" />
          </Field>
          <Field label="Machine" error={error("machineId")}>
            <NativeSelect name="machineId" value={machineId} onChange={(e) => pickMachine(e.target.value)} required className="w-full">
              <NativeSelectOption value="">Pick the machine…</NativeSelectOption>
              {options.machines.map((m) => (
                <NativeSelectOption key={m.id} value={String(m.id)}>
                  {m.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Printing type" error={error("printingTypeId")}>
            <NativeSelect name="printingTypeId" defaultValue={v.printingTypeId} required className="w-full">
              <NativeSelectOption value="">Pick the type…</NativeSelectOption>
              {options.types.map((t) => (
                <NativeSelectOption key={t.id} value={String(t.id)}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </FormSection>

      <FormSection title="Size and amount" description="Sq ft = width × height × qty; amount = sq ft × rate.">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Field label="Width (ft)" error={error("width")}>
            <Input name="width" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} required className="text-right tabular-nums" />
          </Field>
          <Field label="Height (ft)" error={error("height")}>
            <Input name="height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} required className="text-right tabular-nums" />
          </Field>
          <Field label="Qty" error={error("qty")}>
            <Input name="qty" inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} required className="text-right tabular-nums" />
          </Field>
          {onJob ? (
            <input type="hidden" name="rate" value="" />
          ) : (
            <Field
              label="Rate per sq ft (₹)"
              hint={machine && machine.saleRatePaise === null ? "No sale rate set for this machine yet." : undefined}
              error={error("rate")}
            >
              <Input name="rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required className="text-right tabular-nums" />
            </Field>
          )}
        </div>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Sq ft</dt>
            <dd className="font-medium tabular-nums">{sqft === null ? "—" : milliText(sqft)}</dd>
          </div>
          {onJob ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Cost to the job</dt>
              <dd className="font-medium">
                {amount === null ? "at the machine's cost rate" : <Money paise={amount} />}
              </dd>
            </div>
          ) : (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Amount</dt>
              <dd className="font-medium">{amount === null ? "—" : <Money paise={amount} />}</dd>
            </div>
          )}
        </dl>
      </FormSection>

      {!editId && !onJob && (
        <FormSection title="Payment" description="Money taken now is a receipt for this print job.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">Payment</legend>
              <div className="flex flex-wrap gap-2">
                {(["paid", "unpaid", "credit"] as const).map((p) => (
                  <label
                    key={p}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm",
                      payment === p && "border-primary bg-primary/5",
                    )}
                  >
                    <input type="radio" name="payment" value={p} checked={payment === p} onChange={() => setPayment(p)} className="accent-primary" />
                    {p === "paid" ? "Paid" : p === "unpaid" ? "Unpaid" : "Credit"}
                  </label>
                ))}
              </div>
              {error("payment") && <p className="text-xs text-destructive">{error("payment")}</p>}
            </fieldset>
            {payment === "unpaid" && (
              <Field label="Advance received (₹)" hint="Blank if nothing was paid." error={error("received")}>
                <Input name="received" inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value)} className="text-right tabular-nums" />
              </Field>
            )}
            {(received ?? 0n) > 0n && (
              <Field label="Mode" error={error("receiptMode")}>
                <NativeSelect name="receiptMode" defaultValue="cash" className="w-full">
                  <NativeSelectOption value="cash">Cash</NativeSelectOption>
                  <NativeSelectOption value="upi">UPI</NativeSelectOption>
                </NativeSelect>
              </Field>
            )}
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Received</dt>
              <dd className="font-medium">{received === null ? "—" : <Money paise={received} />}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Balance</dt>
              <dd className="font-medium">{amount === null || received === null ? "—" : <Money paise={amount - received} />}</dd>
            </div>
          </dl>
        </FormSection>
      )}

      <FormSection title="Who and when">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Operator">
            <Input value={operator} readOnly disabled />
          </Field>
          {!editId && (
            <>
              <Field label="Date" error={error("date")}>
                <DateInput name="date" defaultValue={v.date} required />
              </Field>
              <Field label="Time" error={error("time")}>
                <Input name="time" type="time" defaultValue={v.time} required />
              </Field>
            </>
          )}
          <Field label="Notes" error={error("notes")} className="sm:col-span-2 lg:col-span-3">
            <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={1000} />
          </Field>
        </div>
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
