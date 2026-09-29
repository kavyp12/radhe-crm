"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { fifo } from "@/lib/fifo";
import { moneyText, parseMoney } from "@/lib/num";
import { MODE_ACCOUNT, RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";
import { cn } from "@/lib/utils";

export type OpenItem = { id: number; number: string; date: string; dueDate: string; total: bigint; open: bigint };
type Row = OpenItem & { amount: string };

export type ReceiptFormValues = {
  customerId: string;
  date: string;
  amount: string;
  mode: ReceiptMode;
  moneyAccountId: string;
  reference: string;
  chequeNo: string;
  chequeDate: string;
  receivedBy: string;
  notes: string;
  /** Invoice id → amount as typed (an edit, or "Record payment" from an invoice). Empty = FIFO fill. */
  allocated: Record<number, string>;
};

type Props = {
  values: ReceiptFormValues;
  customers: { id: number; name: string; firmName: string | null }[];
  accounts: { id: number; name: string; systemKey: string | null }[];
  staff: { id: string; name: string }[];
  /** The starting customer's open invoices. */
  open: OpenItem[];
  /** Set when editing: its own allocations count as open, and after saving we go back to it. */
  receiptId?: number;
  askReason?: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  loadOpen: (customerId: number, exceptReceiptId?: number) => Promise<{ invoices: OpenItem[] }>;
};

/** Typed rupees → paise; blank = 0, unreadable = null. */
function paise(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

/** FIFO (D49): the amount goes to the oldest open invoices first. */
function fill(rows: Row[], amount: string): Row[] {
  const shares = fifo(paise(amount) ?? 0n, rows.map((r) => r.open));
  return rows.map((r, i) => ({ ...r, amount: shares[i] > 0n ? moneyText(shares[i]) : "" }));
}

export function ReceiptForm({ values: v, customers, accounts, staff, open, receiptId, askReason, submitLabel, action, loadOpen }: Props) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push(receiptId ? `/receipts/${receiptId}` : "/receipts");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [customerId, setCustomerId] = useState(v.customerId);
  const [amount, setAmount] = useState(v.amount);
  const [mode, setMode] = useState<ReceiptMode>(v.mode);
  const [accountId, setAccountId] = useState(v.moneyAccountId);
  // An edit starts from what is saved (even nothing), never from a fresh fill.
  const typed = receiptId !== undefined || Object.keys(v.allocated).length > 0;
  const [rows, setRows] = useState<Row[]>(() => {
    const start = open.map((o) => ({ ...o, amount: v.allocated[o.id] ?? "" }));
    return typed ? start : fill(start, v.amount);
  });
  // Once a line is typed in, changing the amount no longer refills the lines.
  const [manual, setManual] = useState(typed);
  const request = useRef(0);

  async function pickCustomer(id: string) {
    setCustomerId(id);
    setManual(false);
    setRows([]);
    if (!id) return;
    const mine = ++request.current;
    const { invoices } = await loadOpen(Number(id), receiptId);
    if (mine === request.current) setRows(fill(invoices.map((i) => ({ ...i, amount: "" })), amount));
  }
  function changeAmount(text: string) {
    setAmount(text);
    if (!manual) setRows((current) => fill(current, text));
  }
  function changeMode(next: ReceiptMode) {
    setMode(next);
    const account = accounts.find((a) => a.systemKey === MODE_ACCOUNT[next]);
    if (account) setAccountId(String(account.id));
  }
  function changeLine(id: number, text: string) {
    setManual(true);
    setRows((current) => current.map((r) => (r.id === id ? { ...r, amount: text } : r)));
  }

  const total = paise(amount);
  const shares = rows.map((r) => paise(r.amount));
  const readable = shares.every((s) => s !== null);
  const allocated = shares.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const over = total !== null && allocated > total;
  const json = JSON.stringify(rows.map((r) => ({ target: "invoice", id: String(r.id), amount: r.amount })));

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <FormSection title="Receipt" description="Numbered when saved (RC/…) and posted to the books.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Customer" error={error("customerId")} className="sm:col-span-2 lg:col-span-1">
            <NativeSelect name="customerId" value={customerId} onChange={(e) => void pickCustomer(e.target.value)} className="w-full">
              <NativeSelectOption value="">Pick the customer…</NativeSelectOption>
              {customers.map((c) => (
                <NativeSelectOption key={c.id} value={String(c.id)}>
                  {c.firmName ? `${c.name} · ${c.firmName}` : c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={v.date} required />
          </Field>
          <Field label="Amount received (₹)" error={error("amount")}>
            <Input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => changeAmount(e.target.value)}
              required
              className="text-right tabular-nums"
            />
          </Field>
          <Field label="Mode" error={error("mode")}>
            <NativeSelect name="mode" value={mode} onChange={(e) => changeMode(e.target.value as ReceiptMode)} className="w-full">
              {RECEIPT_MODES.map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {RECEIPT_MODE[m]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Into account" hint="Set by the mode; change it if needed." error={error("moneyAccountId")}>
            <NativeSelect name="moneyAccountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full">
              {accounts.map((a) => (
                <NativeSelectOption key={a.id} value={String(a.id)}>
                  {a.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Received by" error={error("receivedBy")}>
            <NativeSelect name="receivedBy" defaultValue={v.receivedBy} className="w-full">
              <NativeSelectOption value="">—</NativeSelectOption>
              {staff.map((u) => (
                <NativeSelectOption key={u.id} value={u.id}>
                  {u.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {mode === "cheque" && (
            <>
              <Field label="Cheque no" error={error("chequeNo")}>
                <Input name="chequeNo" defaultValue={v.chequeNo} maxLength={30} required />
              </Field>
              <Field label="Cheque date" error={error("chequeDate")}>
                <DateInput name="chequeDate" defaultValue={v.chequeDate || undefined} />
              </Field>
            </>
          )}
          <Field label="Reference" hint="UTR / transaction id." error={error("reference")}>
            <Input name="reference" defaultValue={v.reference} maxLength={100} />
          </Field>
          <Field label="Notes" error={error("notes")} className="sm:col-span-2 lg:col-span-3">
            <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="Allocation"
        description="Oldest invoices are filled first; change any line. Whatever is left stays on account as an advance."
      >
        <input type="hidden" name="allocations" value={json} />
        {!customerId ? (
          <p className="text-sm text-muted-foreground">Pick the customer to see their open invoices.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open invoices: the whole amount stays on account.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="h-9 border-b px-2 font-medium">Invoice</th>
                  <th className="h-9 border-b px-2 font-medium">Date</th>
                  <th className="h-9 border-b px-2 font-medium">Due</th>
                  <th className="h-9 border-b px-2 text-right font-medium">Total</th>
                  <th className="h-9 border-b px-2 text-right font-medium">Open</th>
                  <th className="h-9 w-36 border-b px-2 text-right font-medium">Allocate ₹</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const bad = shares[i] === null || (shares[i] ?? 0n) > r.open;
                  return (
                    <tr key={r.id}>
                      <td className="border-b px-2 py-1.5 font-medium tabular-nums">{r.number}</td>
                      <td className="border-b px-2 py-1.5">
                        <DateText date={r.date} />
                      </td>
                      <td className="border-b px-2 py-1.5">
                        <DateText date={r.dueDate} />
                      </td>
                      <td className="border-b px-2 py-1.5 text-right">
                        <Money paise={r.total} />
                      </td>
                      <td className="border-b px-2 py-1.5 text-right">
                        <Money paise={r.open} />
                      </td>
                      <td className="border-b px-2 py-1">
                        <Input
                          aria-label={`Allocate to ${r.number}`}
                          aria-invalid={bad || undefined}
                          inputMode="decimal"
                          value={r.amount}
                          onChange={(e) => changeLine(r.id, e.target.value)}
                          className="h-8 text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Allocated</dt>
              <dd>
                <Money paise={allocated} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">On account (advance)</dt>
              <dd className={cn(over && "text-destructive")}>
                {total === null || !readable ? "—" : <Money paise={total - allocated} />}
              </dd>
            </div>
          </dl>
          {rows.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRows((current) => fill(current, amount));
                setManual(false);
              }}
            >
              Fill oldest first
            </Button>
          )}
        </div>
        {over && <p className="mt-2 text-sm text-destructive">More is allocated than was received.</p>}
        {error("allocations") && <p className="mt-2 text-sm text-destructive">{error("allocations")}</p>}
      </FormSection>

      {askReason && (
        <FormSection title="Reason" description="The owner approves the change; say why.">
          <Textarea name="reason" rows={2} maxLength={500} aria-label="Reason" />
        </FormSection>
      )}

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending || over}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
