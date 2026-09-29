"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DateText } from "@/components/date-text";
import { FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/action";
import { fifo } from "@/lib/fifo";
import { moneyText, parseMoney } from "@/lib/num";
import { cn } from "@/lib/utils";
import type { OpenItems } from "../../../receipts/receipt-form";

type Row = { key: string; target: "invoice" | "debit_note" | "job"; id: number; open: bigint | null; amount: string };

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

/**
 * D50: spreads what a receipt / credit note has on account over the open invoices (oldest first, editable) and jobs.
 * `vendor`: a vendor payment's rest over the vendor's open bills (D52; bills come in as `open.invoices`, no jobs).
 */
export function ApplyForm({
  available,
  open,
  back,
  action,
  vendor,
}: {
  available: bigint;
  open: OpenItems;
  back: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  vendor?: boolean;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Applied.");
      router.push(back);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);

  const [rows, setRows] = useState<Row[]>(() => {
    const shares = fifo(available, open.invoices.map((i) => i.open));
    return [
      ...open.invoices.map((i, n) => ({ key: `${i.target}:${i.id}`, target: i.target, id: i.id, open: i.open, amount: shares[n] > 0n ? moneyText(shares[n]) : "" })),
      ...open.jobs.map((j) => ({ key: `job:${j.id}`, target: "job" as const, id: j.id, open: null, amount: "" })),
    ];
  });
  const shares = rows.map((r) => paise(r.amount));
  const applied = shares.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const over = applied > available;
  const set = (key: string, amount: string) => setRows((current) => current.map((r) => (r.key === key ? { ...r, amount } : r)));
  const input = (r: Row, i: number, label: string) => (
    <Input
      aria-label={label}
      aria-invalid={shares[i] === null || (r.open !== null && (shares[i] ?? 0n) > r.open) || undefined}
      inputMode="decimal"
      value={r.amount}
      onChange={(e) => set(r.key, e.target.value)}
      className="h-8 text-right tabular-nums"
    />
  );
  const json = JSON.stringify(rows.map((r) => ({ target: r.target, id: String(r.id), amount: r.amount })));
  const nInvoices = open.invoices.length;

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <input type="hidden" name="allocations" value={json} />
      <FormSection
        title="Apply to"
        description={
          vendor
            ? "Oldest bills are filled first; change any line. Whatever is left stays on account."
            : "Oldest invoices are filled first; change any line. An amount on a job is an advance for it. Whatever is left stays on account."
        }
      >
        <div className="grid gap-4">
          {nInvoices === 0 ? (
            <p className="text-sm text-muted-foreground">{vendor ? "No open bills." : "No open invoices or debit notes."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>{vendor ? "Bill" : "Invoice / debit note"}</th>
                    <th className={th}>Date</th>
                    <th className={th}>Due</th>
                    <th className={`${th} text-right`}>Open</th>
                    <th className={`${th} w-36 text-right`}>Apply ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {open.invoices.map((inv, i) => (
                    <tr key={rows[i].key}>
                      <td className={`${td} font-medium tabular-nums`}>{inv.number}</td>
                      <td className={td}>
                        <DateText date={inv.date} />
                      </td>
                      <td className={td}>
                        <DateText date={inv.dueDate} />
                      </td>
                      <td className={`${td} text-right`}>
                        <Money paise={inv.open} />
                      </td>
                      <td className="border-b px-2 py-1">{input(rows[i], i, `Apply to ${inv.number}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {open.jobs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Job (advance)</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Job total</th>
                    <th className={`${th} text-right`}>Advance so far</th>
                    <th className={`${th} w-36 text-right`}>Advance ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {open.jobs.map((j, n) => {
                    const i = nInvoices + n;
                    return (
                      <tr key={rows[i].key}>
                        <td className={`${td} font-medium tabular-nums`}>{j.number}</td>
                        <td className={td}>
                          <StatusBadge status={j.status} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={j.total} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={j.advance} />
                        </td>
                        <td className="border-b px-2 py-1">{input(rows[i], i, `Advance for ${j.number}`)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Applying</dt>
            <dd>
              <Money paise={applied} />
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Left on account</dt>
            <dd className={cn(over && "text-destructive")}>
              <Money paise={available - applied} />
            </dd>
          </div>
        </dl>
        {over && <p className="mt-2 text-sm text-destructive">More is applied than there is on account.</p>}
        {state?.field === "allocations" && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
      </FormSection>
      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending || over || applied === 0n}>
          {pending ? "Saving…" : "Apply"}
        </Button>
      </FormActions>
    </form>
  );
}
