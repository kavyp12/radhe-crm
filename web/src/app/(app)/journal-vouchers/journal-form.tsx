"use client";

import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";
import { parseMoney } from "@/lib/num";
import { cn } from "@/lib/utils";

type Option = { id: number; name: string };
export type JournalFormOptions = {
  accounts: (Option & { type: string })[];
  customers: Option[];
  vendors: Option[];
  jobs: Option[];
};

/** tag: "" | "c:<customer id>" | "v:<vendor id>" | "j:<job id>" — one optional sub-ledger per line. */
type Row = { key: number; accountId: string; tag: string; debit: string; credit: string };

const TYPES = [
  ["asset", "Assets"],
  ["liability", "Liabilities"],
  ["equity", "Equity"],
  ["income", "Income"],
  ["expense", "Expenses"],
] as const;

/** Typed rupees → paise; blank = 0, unreadable = null. */
function paise(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5";

export function JournalForm({
  options,
  today,
  owner,
  action,
}: {
  options: JournalFormOptions;
  today: string;
  owner: boolean;
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push("/journal-vouchers");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [rows, setRows] = useState<Row[]>(() => [1, 2].map((key) => ({ key, accountId: "", tag: "", debit: "", credit: "" })));
  const set = (key: number, patch: Partial<Row>) => setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => setRows((current) => [...current, { key: Math.max(0, ...current.map((r) => r.key)) + 1, accountId: "", tag: "", debit: "", credit: "" }]);
  const remove = (key: number) => setRows((current) => (current.length > 2 ? current.filter((r) => r.key !== key) : current));

  const sum = (side: "debit" | "credit") => rows.reduce((s, r) => s + (paise(r[side]) ?? 0n), 0n);
  const [debit, credit] = [sum("debit"), sum("credit")];
  const tagged = (r: Row, prefix: string) => (r.tag.startsWith(prefix) ? r.tag.slice(2) : "");
  const json = JSON.stringify(
    rows.map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit, customerId: tagged(r, "c:"), vendorId: tagged(r, "v:"), jobId: tagged(r, "j:") })),
  );
  const money = (r: Row, side: "debit" | "credit") => (
    <Input
      aria-label={side === "debit" ? "Debit" : "Credit"}
      aria-invalid={paise(r[side]) === null || undefined}
      inputMode="decimal"
      value={r[side]}
      onChange={(e) => set(r.key, { [side]: e.target.value })}
      className="h-8 text-right tabular-nums"
    />
  );

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <input type="hidden" name="kind" value="journal" />
      <input type="hidden" name="lines" value={json} />
      <FormSection
        title="Journal voucher"
        description={`Numbered when saved (JV/…) and posted exactly as entered.${owner ? "" : " It goes to the owner for approval first."}`}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={today} required />
          </Field>
          <Field label="Narration" hint="What the entry is for; the owner and the accountant read it." error={error("narration")} className="sm:col-span-2">
            <Input name="narration" maxLength={500} required />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Lines" description="Each line is a debit or a credit. Accounts Receivable needs the customer, Accounts Payable the vendor.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-180 border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Account</th>
                <th className={th}>Customer, vendor or job</th>
                <th className={`${th} w-32 text-right`}>Debit ₹</th>
                <th className={`${th} w-32 text-right`}>Credit ₹</th>
                <th className={`${th} w-10`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td className={td}>
                    <NativeSelect
                      aria-label={`Line ${i + 1} account`}
                      value={r.accountId}
                      onChange={(e) => set(r.key, { accountId: e.target.value })}
                      size="sm"
                      className="w-full"
                    >
                      <NativeSelectOption value="">Pick the account…</NativeSelectOption>
                      {TYPES.map(([type, label]) => (
                        <NativeSelectOptGroup key={type} label={label}>
                          {options.accounts
                            .filter((a) => a.type === type)
                            .map((a) => (
                              <NativeSelectOption key={a.id} value={String(a.id)}>
                                {a.name}
                              </NativeSelectOption>
                            ))}
                        </NativeSelectOptGroup>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className={td}>
                    <NativeSelect aria-label={`Line ${i + 1} customer, vendor or job`} value={r.tag} onChange={(e) => set(r.key, { tag: e.target.value })} size="sm" className="w-full">
                      <NativeSelectOption value="">—</NativeSelectOption>
                      {(
                        [
                          ["Customers", "c:", options.customers],
                          ["Vendors", "v:", options.vendors],
                          ["Jobs", "j:", options.jobs],
                        ] as const
                      ).map(([label, prefix, list]) => (
                        <NativeSelectOptGroup key={prefix} label={label}>
                          {list.map((x) => (
                            <NativeSelectOption key={x.id} value={`${prefix}${x.id}`}>
                              {x.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelectOptGroup>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className="border-b px-2 py-1">{money(r, "debit")}</td>
                  <td className="border-b px-2 py-1">{money(r, "credit")}</td>
                  <td className="border-b px-1 py-1 text-right">
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => remove(r.key)} disabled={rows.length <= 2}>
                      <X />
                    </Button>
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className={td}>
                  <Button type="button" variant="outline" size="sm" onClick={add}>
                    <Plus /> Add line
                  </Button>
                </td>
                <td className={`${td} text-right text-xs text-muted-foreground`}>Total</td>
                <td className={`${td} text-right`}>
                  <Money paise={debit} />
                </td>
                <td className={`${td} text-right`}>
                  <Money paise={credit} />
                </td>
                <td className={td} />
              </tr>
            </tbody>
          </table>
        </div>
        <p className={cn("mt-3 text-sm", debit === credit ? "text-muted-foreground" : "text-destructive")}>
          {debit === credit ? "Debits and credits match." : <>Difference <Money paise={debit - credit} />: debits and credits must match.</>}
        </p>
        {state?.field === "lines" && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
      </FormSection>

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending || debit !== credit || debit === 0n}>
          {pending ? "Saving…" : owner ? "Save journal voucher" : "Ask the owner"}
        </Button>
      </FormActions>
    </form>
  );
}
