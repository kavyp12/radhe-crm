"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { Money } from "@/components/money";
import { StatusBadge, type Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { fifo } from "@/lib/fifo";
import { moneyText, parseMoney } from "@/lib/num";
import { MODE_ACCOUNT, RECEIPT_MODE, RECEIPT_MODES, type ReceiptMode } from "@/lib/receipt-modes";
import { cn } from "@/lib/utils";

/** An open receivable: an invoice or a debit note (T16). */
export type OpenInvoice = {
  target: "invoice" | "debit_note";
  id: number;
  number: string;
  date: string;
  dueDate: string;
  total: bigint;
  open: bigint;
};
/** A job that can take an advance (S12); `advance` = what it already holds from other receipts. */
export type OpenJob = { id: number; number: string; date: string; status: Status; total: bigint; advance: bigint };
export type OpenItems = { invoices: OpenInvoice[]; jobs: OpenJob[] };

type InvoiceRow = OpenInvoice & { amount: string };
type JobRow = OpenJob & { amount: string };

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
  /** "invoice:12" / "job:4" → amount as typed (an edit, or "Record payment" from an invoice). Empty = FIFO fill. */
  allocated: Record<string, string>;
};

type Props = {
  values: ReceiptFormValues;
  customers: { id: number; name: string; firmName: string | null }[];
  accounts: { id: number; name: string; systemKey: string | null }[];
  staff: { id: string; name: string }[];
  /** The starting customer's open invoices and jobs. */
  open: OpenItems;
  /** Set when editing: its own allocations count as open, and after saving we go back to it. */
  receiptId?: number;
  /** "Record advance" from a job page: the amount goes to this job's line instead of the invoices. */
  advanceFor?: number;
  askReason?: boolean;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  loadOpen: (customerId: number, exceptReceiptId?: number) => Promise<OpenItems>;
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

/** FIFO (D49): what isn't typed on jobs goes to the oldest open invoices first. */
function fill(rows: InvoiceRow[], available: bigint): InvoiceRow[] {
  const shares = fifo(available, rows.map((r) => r.open));
  return rows.map((r, i) => ({ ...r, amount: shares[i] > 0n ? moneyText(shares[i]) : "" }));
}

const th = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-2 py-1.5";

export function ReceiptForm({
  values: v,
  customers,
  accounts,
  staff,
  open,
  receiptId,
  advanceFor,
  askReason,
  submitLabel,
  action,
  loadOpen,
}: Props) {
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
  const typed = receiptId !== undefined || advanceFor !== undefined || Object.keys(v.allocated).length > 0;
  const [invoiceRows, setInvoiceRows] = useState<InvoiceRow[]>(() => {
    const start = open.invoices.map((o) => ({ ...o, amount: v.allocated[`${o.target}:${o.id}`] ?? "" }));
    return typed ? start : fill(start, paise(v.amount) ?? 0n);
  });
  const [jobRows, setJobRows] = useState<JobRow[]>(() => open.jobs.map((j) => ({ ...j, amount: v.allocated[`job:${j.id}`] ?? "" })));
  // Once an invoice line is typed in, changing the amount no longer refills them.
  const [manual, setManual] = useState(typed);
  const request = useRef(0);

  async function pickCustomer(id: string) {
    setCustomerId(id);
    setManual(false);
    setInvoiceRows([]);
    setJobRows([]);
    if (!id) return;
    const mine = ++request.current;
    const items = await loadOpen(Number(id), receiptId);
    if (mine !== request.current) return;
    setInvoiceRows(fill(items.invoices.map((i) => ({ ...i, amount: "" })), paise(amount) ?? 0n));
    setJobRows(items.jobs.map((j) => ({ ...j, amount: "" })));
  }
  const jobTotal = jobRows.reduce((s, r) => s + (paise(r.amount) ?? 0n), 0n);
  function changeAmount(text: string) {
    setAmount(text);
    if (advanceFor !== undefined && customerId === v.customerId) {
      setJobRows((rows) => rows.map((r) => (r.id === advanceFor ? { ...r, amount: text } : r)));
    } else if (!manual) setInvoiceRows((current) => fill(current, (paise(text) ?? 0n) - jobTotal));
  }
  function changeMode(next: ReceiptMode) {
    setMode(next);
    const account = accounts.find((a) => a.systemKey === MODE_ACCOUNT[next]);
    if (account) setAccountId(String(account.id));
  }

  const total = paise(amount);
  const invoiceShares = invoiceRows.map((r) => paise(r.amount));
  const jobShares = jobRows.map((r) => paise(r.amount));
  const shares = [...invoiceShares, ...jobShares];
  const readable = shares.every((s) => s !== null);
  const allocated = shares.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const over = total !== null && allocated > total;
  const json = JSON.stringify([
    ...invoiceRows.map((r) => ({ target: r.target, id: String(r.id), amount: r.amount })),
    ...jobRows.map((r) => ({ target: "job", id: String(r.id), amount: r.amount })),
  ]);
  const amountInput = (label: string, value: string, bad: boolean, onChange: (text: string) => void) => (
    <Input
      aria-label={label}
      aria-invalid={bad || undefined}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-right tabular-nums"
    />
  );

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
        description="Oldest invoices are filled first; change any line. An amount on a job is an advance for it and moves to its invoice when that is issued. Whatever is left stays on account."
      >
        <input type="hidden" name="allocations" value={json} />
        {!customerId ? (
          <p className="text-sm text-muted-foreground">Pick the customer to see their open invoices and jobs.</p>
        ) : (
          <div className="grid gap-4">
            {invoiceRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open invoices or debit notes.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr>
                      <th className={th}>Invoice / debit note</th>
                      <th className={th}>Date</th>
                      <th className={th}>Due</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} text-right`}>Open</th>
                      <th className={`${th} w-36 text-right`}>Allocate ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceRows.map((r, i) => (
                      <tr key={`${r.target}:${r.id}`}>
                        <td className={`${td} font-medium tabular-nums`}>{r.number}</td>
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
                          {amountInput(
                            `Allocate to ${r.number}`,
                            r.amount,
                            invoiceShares[i] === null || (invoiceShares[i] ?? 0n) > r.open,
                            (text) => {
                              setManual(true);
                              setInvoiceRows((rows) => rows.map((x) => (x.id === r.id && x.target === r.target ? { ...x, amount: text } : x)));
                            },
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {jobRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr>
                      <th className={th}>Job (advance)</th>
                      <th className={th}>Date</th>
                      <th className={th}>Status</th>
                      <th className={`${th} text-right`}>Job total</th>
                      <th className={`${th} text-right`}>Advance so far</th>
                      <th className={`${th} w-36 text-right`}>Advance ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobRows.map((r, i) => (
                      <tr key={r.id}>
                        <td className={`${td} font-medium tabular-nums`}>{r.number}</td>
                        <td className={td}>
                          <DateText date={r.date} />
                        </td>
                        <td className={td}>
                          <StatusBadge status={r.status} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={r.total} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={r.advance} />
                        </td>
                        <td className="border-b px-2 py-1">
                          {amountInput(`Advance for ${r.number}`, r.amount, jobShares[i] === null, (text) =>
                            setJobRows((rows) => rows.map((x) => (x.id === r.id ? { ...x, amount: text } : x))),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
              <dd className={cn(over && "text-destructive")}>
                {total === null || !readable ? "—" : <Money paise={total - allocated} />}
              </dd>
            </div>
          </dl>
          {invoiceRows.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setInvoiceRows((current) => fill(current, (total ?? 0n) - jobTotal));
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
