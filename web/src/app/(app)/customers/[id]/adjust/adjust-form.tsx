"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";
import { fifo } from "@/lib/fifo";
import { moneyText, parseMoney } from "@/lib/num";
import { cn } from "@/lib/utils";

export type AdjustKind = "write_off" | "discount" | "refund";
const KINDS: [AdjustKind, string][] = [
  ["write_off", "Write-off (bad debt)"],
  ["discount", "Settlement discount"],
  ["refund", "Refund of customer credit"],
];

/** A line of either panel: an open invoice / debit note, or money on account (receipt / credit note). */
export type AdjustItem = { target: string; id: number; number: string; date: string; note: string; open: bigint };
type Row = AdjustItem & { amount: string };

function paise(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

/** D49 / D55: oldest first, each line up to what it has open. */
function fill(rows: Row[], amount: bigint): Row[] {
  const shares = fifo(amount, rows.map((r) => r.open));
  return rows.map((r, i) => ({ ...r, amount: shares[i] > 0n ? moneyText(shares[i]) : "" }));
}

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5";

export function AdjustForm({
  customerId,
  kind: startKind,
  today,
  owner,
  receivables,
  onAccount,
  accounts,
  back,
  action,
}: {
  customerId: number;
  kind: AdjustKind;
  today: string;
  owner: boolean;
  receivables: AdjustItem[];
  onAccount: AdjustItem[];
  accounts: { id: number; name: string; systemKey: string | null }[];
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

  const [kind, setKind] = useState<AdjustKind>(startKind);
  const [amount, setAmount] = useState("");
  const [rows, setRows] = useState<Row[]>(() => (startKind === "refund" ? onAccount : receivables).map((r) => ({ ...r, amount: "" })));
  // Once a line is typed in, changing the amount no longer refills them.
  const [manual, setManual] = useState(false);

  function changeKind(next: AdjustKind) {
    setKind(next);
    setManual(false);
    setRows(fill((next === "refund" ? onAccount : receivables).map((r) => ({ ...r, amount: "" })), paise(amount) ?? 0n));
  }
  function changeAmount(text: string) {
    setAmount(text);
    if (!manual) setRows((current) => fill(current, paise(text) ?? 0n));
  }
  function changeLine(key: string, text: string) {
    setManual(true);
    setRows((current) => current.map((r) => (`${r.target}:${r.id}` === key ? { ...r, amount: text } : r)));
  }

  const total = paise(amount);
  const shares = rows.map((r) => paise(r.amount));
  const allocated = shares.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const refund = kind === "refund";
  const available = onAccount.reduce((s, r) => s + r.open, 0n);
  const ready = total !== null && total > 0n && allocated === total && shares.every((s) => s !== null);
  const json = JSON.stringify(rows.map((r) => ({ target: r.target, id: String(r.id), amount: r.amount })));
  const cash = accounts.find((a) => a.systemKey === "cash");

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="allocations" value={json} />
      <FormSection
        title="Adjustment"
        description={`Posted as a journal voucher (JV/…).${owner ? "" : " It goes to the owner for approval first."}`}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Kind">
            <NativeSelect name="kind" value={kind} onChange={(e) => changeKind(e.target.value as AdjustKind)} className="w-full">
              {KINDS.map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={today} required />
          </Field>
          <Field
            label="Amount (₹)"
            hint={refund ? `Up to ${moneyText(available)} on account.` : undefined}
            error={error("amount")}
          >
            <Input name="amount" inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} required className="text-right tabular-nums" />
          </Field>
          {refund && (
            <Field label="Paid from" error={error("moneyAccountId")}>
              <NativeSelect name="moneyAccountId" defaultValue={cash ? String(cash.id) : ""} className="w-full">
                {accounts.map((a) => (
                  <NativeSelectOption key={a.id} value={String(a.id)}>
                    {a.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Narration" hint="Optional: why (the kind and customer are filled in when blank)." error={error("narration")} className={refund ? "sm:col-span-2" : "sm:col-span-2 lg:col-span-3"}>
            <Input name="narration" maxLength={500} />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title={refund ? "Pays back" : "Settles"}
        description={
          refund
            ? "The money on account it uses up, oldest first; change any line."
            : "The open invoices and debit notes it settles, oldest first; change any line. The whole amount must be allocated."
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{refund ? "Nothing on account to pay back." : "No open invoices or debit notes."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Document</th>
                  <th className={th}>Date</th>
                  <th className={th} />
                  <th className={`${th} text-right`}>{refund ? "On account" : "Open"}</th>
                  <th className={`${th} w-36 text-right`}>Amount ₹</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.target}:${r.id}`}>
                    <td className={`${td} font-medium tabular-nums`}>{r.number}</td>
                    <td className={td}>
                      <DateText date={r.date} />
                    </td>
                    <td className={`${td} text-muted-foreground`}>{r.note}</td>
                    <td className={`${td} text-right`}>
                      <Money paise={r.open} />
                    </td>
                    <td className="border-b px-2 py-1">
                      <Input
                        aria-label={`Amount for ${r.number}`}
                        aria-invalid={shares[i] === null || (shares[i] ?? 0n) > r.open || undefined}
                        inputMode="decimal"
                        value={r.amount}
                        onChange={(e) => changeLine(`${r.target}:${r.id}`, e.target.value)}
                        className="h-8 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Allocated</dt>
            <dd className={cn(total !== null && allocated !== total && "text-destructive")}>
              <Money paise={allocated} /> of <Money paise={total ?? 0n} />
            </dd>
          </div>
        </dl>
        {state?.field === "allocations" && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
      </FormSection>

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending || !ready}>
          {pending ? "Saving…" : owner ? "Save adjustment" : "Ask the owner"}
        </Button>
      </FormActions>
    </form>
  );
}
