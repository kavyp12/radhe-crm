import Link from "next/link";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { ActionButton, ActionDialog } from "@/components/doc-actions";
import { Field } from "@/components/form";
import { Money } from "@/components/money";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { BUCKET_LABEL, JOB_COST_BUCKETS } from "@/lib/cost-buckets";
import { todayIST } from "@/lib/dates";
import type { jobCosting } from "@/lib/job-costing";
import { bpText } from "@/lib/num";
import { cn } from "@/lib/utils";
import { addJobCostAction, removeJobCostAction } from "../actions";

type Card = NonNullable<Awaited<ReturnType<typeof jobCosting>>>;
const row = "flex items-center justify-between gap-4 border-b px-4 py-2";

/** S3 / S11: the job's P&L. The page renders it only when the loader returned it (can_view_cost). */
export function JobPnl({ jobId, card, canEnter }: { jobId: number; card: Card; canEnter: boolean }) {
  const { balance } = card;
  return (
    <section aria-label="Job P&L" className="overflow-hidden rounded-lg border bg-card text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Job P&amp;L</h2>
        {canEnter && (
          <ActionDialog
            action={addJobCostAction.bind(null, jobId)}
            label="Add cost"
            title="Add an internal cost"
            description="For costs no bill or expense carries (e.g. in-house printing). Never posted to the books."
            confirmLabel="Add cost"
            done="Cost added."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cost type">
                <NativeSelect name="bucket" required className="w-full" defaultValue="">
                  <NativeSelectOption value="">Pick…</NativeSelectOption>
                  {JOB_COST_BUCKETS.map((b) => (
                    <NativeSelectOption key={b} value={b}>
                      {BUCKET_LABEL[b]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Date">
                <DateInput name="date" defaultValue={todayIST()} required />
              </Field>
              <Field label="Amount (₹)">
                <Input name="amount" inputMode="decimal" required className="text-right tabular-nums" />
              </Field>
              <Field label="Note">
                <Input name="note" maxLength={200} />
              </Field>
            </div>
          </ActionDialog>
        )}
      </div>
      <div className="grid md:grid-cols-2 md:divide-x">
        <div>
          <div className={cn(row, "font-medium")}>
            <span>Sale (excl. GST)</span>
            <Money paise={card.sale} />
          </div>
          {JOB_COST_BUCKETS.map((b) => (
            <div key={b} className={cn(row, "text-muted-foreground")}>
              <span className="pl-3">{BUCKET_LABEL[b]}</span>
              <Money paise={card.cost[b]} className="text-foreground" />
            </div>
          ))}
          <div className={row}>
            <span>Total cost</span>
            <Money paise={card.totalCost} />
          </div>
          <div className={cn(row, "border-b-0 bg-muted/40 py-3 font-medium md:border-b-0")}>
            <span>
              Profit
              {card.marginBp !== null && <span className="ml-2 font-normal text-muted-foreground">margin {bpText(card.marginBp)}%</span>}
            </span>
            <Money paise={card.profit} className={card.profit < 0n ? "text-red-700" : "text-emerald-700"} />
          </div>
        </div>
        <div className="border-t md:border-t-0">
          <div className={row}>
            <span>Advance received</span>
            <Money paise={card.advance} />
          </div>
          <div className={cn(row, "font-medium")}>
            <span>
              Balance due
              {balance.invoice && (
                <span className="block text-xs font-normal text-muted-foreground">
                  Open on{" "}
                  <Link href={`/invoices/${balance.invoice.id}`} className="text-primary hover:underline">
                    {balance.invoice.number}
                  </Link>
                  {balance.invoice.shared && " (with its other lines)"}
                </span>
              )}
            </span>
            <Money paise={balance.amount} />
          </div>
          {card.expected && (
            <div aria-label="Estimate" className="border-b border-dashed bg-amber-50/60">
              <p className="px-4 pt-2 text-xs font-medium text-amber-800">Estimate — until the job is invoiced</p>
              <div className={cn(row, "border-b-0 text-muted-foreground")}>
                <span>Expected sale (excl. GST)</span>
                <Money paise={card.expected.sale} className="text-foreground" />
              </div>
              <div className={cn(row, "border-b-0 pt-0 text-muted-foreground")}>
                <span>Expected profit</span>
                <Money paise={card.expected.profit} className={card.expected.profit < 0n ? "text-red-700" : "text-foreground"} />
              </div>
            </div>
          )}
          {card.sale === 0n && <p className="px-4 py-2 text-xs text-muted-foreground">The sale counts once the job&apos;s invoice is issued.</p>}
          {card.entries.length > 0 && (
            <div className="px-4 py-2">
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Internal costs entered</h3>
              <ul className="grid gap-1">
                {card.entries.map((e) => (
                  <li key={e.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", !e.active && "text-muted-foreground line-through")}>
                    <DateText date={e.date} />
                    <span>{BUCKET_LABEL[e.bucket]}</span>
                    <span className="min-w-0 flex-1 truncate">{e.note}</span>
                    <Money paise={e.amount} />
                    {canEnter && e.active && (
                      <ActionButton action={removeJobCostAction.bind(null, jobId, e.id)} label="Remove" done="Cost removed." size="sm" />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
