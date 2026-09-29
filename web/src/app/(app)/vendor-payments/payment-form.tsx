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

/** A vendor's open bill (oldest first). */
export type OpenBill = { id: number; number: string; vendorBillNo: string; date: string; dueDate: string; total: bigint; open: bigint };
type Row = OpenBill & { amount: string };

export type PaymentFormValues = {
  vendorId: string;
  date: string;
  amount: string;
  mode: ReceiptMode;
  moneyAccountId: string;
  reference: string;
  chequeNo: string;
  chequeDate: string;
  notes: string;
  /** Bill id → amount as typed (an edit, or "Record payment" from a bill). Empty = FIFO fill. */
  allocated: Record<string, string>;
};

function paise(text: string): bigint | null {
  if (!text.trim()) return 0n;
  try {
    return parseMoney(text);
  } catch {
    return null;
  }
}

/** Oldest bills first (D49, D51). */
const fill = (rows: Row[], available: bigint): Row[] => {
  const shares = fifo(available, rows.map((r) => r.open));
  return rows.map((r, i) => ({ ...r, amount: shares[i] > 0n ? moneyText(shares[i]) : "" }));
};

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5";

export function PaymentForm({
  values: v,
  vendors,
  accounts,
  open,
  paymentId,
  askReason,
  submitLabel,
  action,
  loadOpen,
}: {
  values: PaymentFormValues;
  vendors: { id: number; name: string }[];
  accounts: { id: number; name: string; systemKey: string | null }[];
  open: OpenBill[];
  /** Set when editing: its own allocations count as open. */
  paymentId?: number;
  askReason?: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  loadOpen: (vendorId: number, exceptPaymentId?: number) => Promise<OpenBill[]>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push(paymentId ? `/vendor-payments/${paymentId}` : "/vendor-payments");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [vendorId, setVendorId] = useState(v.vendorId);
  const [amount, setAmount] = useState(v.amount);
  const [mode, setMode] = useState<ReceiptMode>(v.mode);
  const [accountId, setAccountId] = useState(v.moneyAccountId);
  const typed = paymentId !== undefined || Object.keys(v.allocated).length > 0;
  const [rows, setRows] = useState<Row[]>(() => {
    const start = open.map((b) => ({ ...b, amount: v.allocated[String(b.id)] ?? "" }));
    return typed ? start : fill(start, paise(v.amount) ?? 0n);
  });
  const [manual, setManual] = useState(typed);
  const request = useRef(0);

  async function pickVendor(id: string) {
    setVendorId(id);
    setManual(false);
    setRows([]);
    if (!id) return;
    const mine = ++request.current;
    const bills = await loadOpen(Number(id), paymentId);
    if (mine === request.current) setRows(fill(bills.map((b) => ({ ...b, amount: "" })), paise(amount) ?? 0n));
  }
  function changeAmount(text: string) {
    setAmount(text);
    if (!manual) setRows((current) => fill(current, paise(text) ?? 0n));
  }
  function changeMode(next: ReceiptMode) {
    setMode(next);
    const account = accounts.find((a) => a.systemKey === MODE_ACCOUNT[next]);
    if (account) setAccountId(String(account.id));
  }

  const total = paise(amount);
  const shares = rows.map((r) => paise(r.amount));
  const readable = shares.every((s) => s !== null);
  const allocated = shares.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const over = total !== null && allocated > total;
  const json = JSON.stringify(rows.map((r) => ({ id: String(r.id), amount: r.amount })));

  return (
    <form onSubmit={onSubmit} className="grid max-w-5xl grid-cols-1 gap-4">
      <FormSection title="Payment" description="Numbered when saved (VP/…) and posted to the books.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Vendor" error={error("vendorId")} className="sm:col-span-2 lg:col-span-1">
            <NativeSelect name="vendorId" value={vendorId} onChange={(e) => void pickVendor(e.target.value)} className="w-full">
              <NativeSelectOption value="">Pick the vendor…</NativeSelectOption>
              {vendors.map((x) => (
                <NativeSelectOption key={x.id} value={String(x.id)}>
                  {x.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={v.date} required />
          </Field>
          <Field label="Amount paid (₹)" error={error("amount")}>
            <Input name="amount" inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} required className="text-right tabular-nums" />
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
          <Field label="From account" hint="Set by the mode; change it if needed." error={error("moneyAccountId")}>
            <NativeSelect name="moneyAccountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full">
              {accounts.map((a) => (
                <NativeSelectOption key={a.id} value={String(a.id)}>
                  {a.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reference" hint="UTR / transaction id." error={error("reference")}>
            <Input name="reference" defaultValue={v.reference} maxLength={100} />
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
          <Field label="Notes" error={error("notes")} className="sm:col-span-2 lg:col-span-3">
            <Textarea name="notes" rows={2} defaultValue={v.notes} maxLength={2000} />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Allocation" description="Oldest bills are filled first; change any line. Whatever is left stays on account.">
        <input type="hidden" name="allocations" value={json} />
        {!vendorId ? (
          <p className="text-sm text-muted-foreground">Pick the vendor to see their open bills.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open bills.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Bill</th>
                  <th className={th}>Vendor bill no</th>
                  <th className={th}>Date</th>
                  <th className={th}>Due</th>
                  <th className={`${th} text-right`}>Total</th>
                  <th className={`${th} text-right`}>Open</th>
                  <th className={`${th} w-36 text-right`}>Allocate ₹</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className={`${td} font-medium tabular-nums`}>{r.number}</td>
                    <td className={td}>{r.vendorBillNo}</td>
                    <td className={td}>
                      <DateText date={r.date} />
                    </td>
                    <td className={td}>
                      <DateText date={r.dueDate} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={r.total} />
                    </td>
                    <td className={`${td} text-right`}>
                      <Money paise={r.open} />
                    </td>
                    <td className="border-b px-2 py-1">
                      <Input
                        aria-label={`Allocate to ${r.number}`}
                        aria-invalid={shares[i] === null || (shares[i] ?? 0n) > r.open || undefined}
                        inputMode="decimal"
                        value={r.amount}
                        onChange={(e) => {
                          setManual(true);
                          const text = e.target.value;
                          setRows((current) => current.map((x) => (x.id === r.id ? { ...x, amount: text } : x)));
                        }}
                        className="h-8 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
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
              <dt className="text-muted-foreground">On account</dt>
              <dd className={cn(over && "text-destructive")}>{total === null || !readable ? "—" : <Money paise={total - allocated} />}</dd>
            </div>
          </dl>
          {rows.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRows((current) => fill(current, total ?? 0n));
                setManual(false);
              }}
            >
              Fill oldest first
            </Button>
          )}
        </div>
        {over && <p className="mt-2 text-sm text-destructive">More is allocated than was paid.</p>}
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
