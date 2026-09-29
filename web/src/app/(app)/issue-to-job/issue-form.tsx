"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DateInput } from "@/components/date-input";
import { Field, FormActions, FormError, FormSection, useFormAction } from "@/components/form";
import { LineItemsGrid, type LineColumn, type LineRow } from "@/components/line-items";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { milliText, parseQty } from "@/lib/num";
import { cn } from "@/lib/utils";

type Kind = "issue" | "return";
export type IssueJob = { id: number; number: string; customer: string; cancelled: boolean };
/** An item with the qty in stock (issue) or with the job (return). No values: production uses this form. */
export type IssueItem = { id: number; name: string; unit: string; qty: bigint };

type Row = LineRow & { itemId: string; qty: string };
let seq = 0;
const blank = (): Row => ({ id: `si-${++seq}`, itemId: "", qty: "" });

const badQty = (v: string) => {
  try {
    return parseQty(v) <= 0n;
  } catch {
    return true;
  }
};

export function IssueForm({
  kind: startKind,
  jobId: startJob,
  today,
  jobs,
  items,
  returnable: startReturnable,
  action,
  loadReturnable,
}: {
  kind: Kind;
  jobId: string;
  today: string;
  jobs: IssueJob[];
  items: IssueItem[];
  returnable: IssueItem[];
  action: (state: FormState, form: FormData) => Promise<FormState>;
  loadReturnable: (jobId: number) => Promise<IssueItem[]>;
}) {
  const router = useRouter();
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) {
      toast.success(state.message ?? "Saved.");
      router.push("/issue-to-job");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new result arrives
  }, [state]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  const [kind, setKind] = useState<Kind>(startKind);
  const [jobId, setJobId] = useState(startJob);
  const [returnable, setReturnable] = useState(startReturnable);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const asked = useRef(0);

  // A return lists what the picked job holds: loaded from the server when the job or the kind changes.
  async function load(nextKind: Kind, nextJob: string) {
    const ticket = ++asked.current;
    const list = nextKind === "return" && nextJob ? await loadReturnable(Number(nextJob)) : [];
    if (ticket === asked.current) setReturnable(list);
  }
  function changeKind(next: Kind) {
    setKind(next);
    setRows([blank()]);
    if (next === "issue" && jobs.find((j) => String(j.id) === jobId)?.cancelled) setJobId("");
    void load(next, jobId);
  }
  function changeJob(next: string) {
    setJobId(next);
    if (kind === "return") {
      setRows([blank()]);
      void load(kind, next);
    }
  }

  const choices = kind === "issue" ? items : returnable;
  const columns: LineColumn[] = [
    {
      key: "itemId",
      label: "Item",
      placeholder: "Pick…",
      options: choices.map((i) => ({
        value: String(i.id),
        label: `${i.name} · ${milliText(i.qty)} ${i.unit} ${kind === "issue" ? "in stock" : "with the job"}`,
      })),
    },
    { key: "qty", label: "Qty", numeric: true, width: "w-28", invalid: badQty },
  ];
  const json = JSON.stringify(rows.map((r) => ({ itemId: r.itemId, qty: r.qty })));
  const pickable = jobs.filter((j) => kind === "return" || !j.cancelled);

  return (
    <form onSubmit={onSubmit} className="grid max-w-4xl grid-cols-1 gap-4">
      <input type="hidden" name="kind" value={kind} />
      <FormSection
        title={kind === "issue" ? "Issue to job" : "Return from job"}
        description={
          kind === "issue"
            ? "Materials taken out of stock for a job. Numbered SI/… when saved."
            : "Materials that come back from a job into stock. Numbered SI/… when saved."
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div role="radiogroup" aria-label="Kind" className="flex w-fit rounded-md border p-0.5 sm:col-span-2">
            {(["issue", "return"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => changeKind(k)}
                className={cn(
                  "h-8 rounded px-3 text-sm transition-colors",
                  kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k === "issue" ? "Issue" : "Return"}
              </button>
            ))}
          </div>
          <Field label="Job" error={error("jobId")}>
            <NativeSelect name="jobId" value={jobId} onChange={(e) => changeJob(e.target.value)} className="w-full" required>
              <NativeSelectOption value="">Pick the job…</NativeSelectOption>
              {pickable.map((j) => (
                <NativeSelectOption key={j.id} value={String(j.id)}>
                  {j.number} · {j.customer}
                  {j.cancelled ? " (cancelled)" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Date" error={error("date")}>
            <DateInput name="date" defaultValue={today} required />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Items" description={kind === "issue" ? "Each item once, with the qty going out." : "Each item once, with the qty coming back."}>
        <input type="hidden" name="lines" value={json} />
        {kind === "return" && jobId && returnable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing issued to this job is still with it.</p>
        ) : (
          <LineItemsGrid columns={columns} rows={rows} onChange={(next) => setRows(next as Row[])} newRow={blank} minWidth="min-w-[480px]" />
        )}
        {error("lines") && <p className="mt-2 text-sm text-destructive">{error("lines")}</p>}
      </FormSection>

      <FormSection title="Notes">
        <Field label="Notes" error={error("notes")}>
          <Textarea name="notes" rows={2} maxLength={500} />
        </Field>
      </FormSection>

      <FormError state={state} />
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : kind === "issue" ? "Save issue" : "Save return"}
        </Button>
      </FormActions>
    </form>
  );
}
