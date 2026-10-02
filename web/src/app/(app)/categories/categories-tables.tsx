"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DataTable, tableColumns } from "@/components/data-table";
import { Field, useFormAction } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FormState } from "@/lib/action";
import { BUCKET_LABEL, COST_BUCKETS, type CostBucket } from "@/lib/cost-buckets";
import { cn } from "@/lib/utils";

type Action = (state: FormState, form: FormData) => Promise<FormState>;
export type ProductRow = { id: number; name: string; hsnSac: string; gstPercent: string; active: boolean };
export type ExpenseRow = { id: number; name: string; accountCode: string; costBucket: CostBucket; active: boolean };

const statusOf = (r: { active: boolean }) => (r.active ? "Active" : "Inactive");

export function NameCell({ name, active }: { name: string; active: boolean }) {
  return (
    <span className={cn("font-medium", !active && "text-muted-foreground")}>
      {name}
      {!active && <span className="ml-1.5 text-xs font-normal">(inactive)</span>}
    </span>
  );
}

function ActiveBox({ active }: { active: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="hidden" name="activeShown" value="1" />
      <input type="checkbox" name="active" defaultChecked={active} className="size-4 accent-primary" />
      Active (offered when picking a category)
    </label>
  );
}

/** Add / edit dialog. Mounted per row (key), closed after a successful save. */
export function CategoryDialog(props: {
  title: string;
  description: string;
  action: Action;
  onClose: () => void;
  fields: (error: (field: string) => string | undefined) => ReactNode;
}) {
  const { title, description, action, onClose, fields } = props;
  const { state, onSubmit, pending } = useFormAction(action);
  useEffect(() => {
    if (state?.ok) {
      toast.success("Saved.");
      onClose();
    } else if (state?.error) toast.error(state.error);
  }, [state, onClose]);
  const error = (field: string) => (state?.field === field ? state.error : undefined);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          {fields(error)}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const product = tableColumns<ProductRow>();
const productColumns = [
  product.accessor("name", { header: "Category", cell: (c) => <NameCell name={c.getValue()} active={c.row.original.active} /> }),
  product.accessor("hsnSac", { header: "HSN / SAC", cell: (c) => <span className="tabular-nums">{c.getValue() || "—"}</span> }),
  product.accessor("gstPercent", {
    header: "GST %",
    enableGlobalFilter: false,
    cell: (c) => `${c.getValue()}%`,
    meta: { numeric: true },
  }),
];

export function ProductCategories({ rows, action }: { rows: ProductRow[]; action: Action }) {
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const row = editing === "new" ? null : editing;
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>New product category</Button>
      </div>
      <DataTable
        data={rows}
        columns={productColumns}
        status={statusOf}
        searchPlaceholder="Search categories or HSN / SAC"
        onRowClick={setEditing}
        pageSize={50}
      />
      {editing && (
        <CategoryDialog
          key={row?.id ?? "new"}
          title={row ? row.name : "New product category"}
          description="HSN / SAC and GST % are printed on quotation and invoice lines."
          action={action}
          onClose={close}
          fields={(error) => (
            <>
              <input type="hidden" name="id" value={row?.id ?? ""} />
              {!row && (
                <Field label="Name" error={error("name")}>
                  <Input name="name" required maxLength={100} />
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="HSN / SAC" hint="Blank until the CA confirms it." error={error("hsnSac")}>
                  <Input name="hsnSac" defaultValue={row?.hsnSac ?? ""} inputMode="numeric" maxLength={11} />
                </Field>
                <Field label="GST %" error={error("gstPercent")}>
                  <Input name="gstPercent" defaultValue={row?.gstPercent ?? "18"} inputMode="decimal" required />
                </Field>
              </div>
              {row && <ActiveBox active={row.active} />}
            </>
          )}
        />
      )}
    </div>
  );
}

const expense = tableColumns<ExpenseRow>();
const expenseColumns = [
  expense.accessor("name", { header: "Category", cell: (c) => <NameCell name={c.getValue()} active={c.row.original.active} /> }),
  expense.accessor("accountCode", { header: "Account", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
  expense.accessor((r) => BUCKET_LABEL[r.costBucket], { id: "bucket", header: "Cost bucket" }),
];

export function ExpenseCategories({ rows, action }: { rows: ExpenseRow[]; action: Action }) {
  const [editing, setEditing] = useState<ExpenseRow | "new" | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const row = editing === "new" ? null : editing;
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>New expense category</Button>
      </div>
      <DataTable
        data={rows}
        columns={expenseColumns}
        status={statusOf}
        searchPlaceholder="Search categories"
        onRowClick={setEditing}
        pageSize={50}
      />
      {editing && (
        <CategoryDialog
          key={row?.id ?? "new"}
          title={row ? row.name : "New expense category"}
          description={
            row
              ? `Posts to its own expense account ${row.accountCode}. The bucket decides where job-tagged amounts count in job costing.`
              : "Gets its own expense account. The bucket decides where job-tagged amounts count in job costing."
          }
          action={action}
          onClose={close}
          fields={(error) => (
            <>
              <input type="hidden" name="id" value={row?.id ?? ""} />
              {!row && (
                <Field label="Name" error={error("name")}>
                  <Input name="name" required maxLength={100} />
                </Field>
              )}
              <Field label="Cost bucket" error={error("costBucket")}>
                <NativeSelect name="costBucket" defaultValue={row?.costBucket ?? "none"} className="w-full">
                  {COST_BUCKETS.map((b) => (
                    <NativeSelectOption key={b} value={b}>
                      {BUCKET_LABEL[b]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {row && <ActiveBox active={row.active} />}
            </>
          )}
        />
      )}
    </div>
  );
}
