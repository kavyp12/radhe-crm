"use client";

import { useCallback, useState } from "react";
import { DataTable, tableColumns, type DataTableColumn } from "@/components/data-table";
import { Field } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/action";
import { CategoryDialog, NameCell } from "../../categories/categories-tables";

type Action = (state: FormState, form: FormData) => Promise<FormState>;
/** Rates as form text ("" = not set); costRate undefined = the user may not see cost rates. */
export type MachineRow = { id: number; name: string; printers: string[]; saleRate: string; costRate?: string; active: boolean };
export type TypeRow = { id: number; name: string; categoryId: string; category: string; active: boolean };

const statusOf = (r: { active: boolean }) => (r.active ? "Active" : "Inactive");

function ActiveBox({ active, what }: { active: boolean; what: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="hidden" name="activeShown" value="1" />
      <input type="checkbox" name="active" defaultChecked={active} className="size-4 accent-primary" />
      Active (offered when {what})
    </label>
  );
}

const rateText = (text: string) => (text ? `₹${text}` : "Not set");

const machine = tableColumns<MachineRow>();
const machineBase: DataTableColumn<MachineRow>[] = [
  machine.accessor("name", { header: "Machine", cell: (c) => <NameCell name={c.getValue()} active={c.row.original.active} /> }),
  machine.accessor((r) => r.printers.join(", "), { id: "printers", header: "Windows printers", cell: (c) => c.getValue() || "—" }),
  machine.accessor("saleRate", { header: "Sale rate / sq ft", cell: (c) => rateText(c.getValue()), meta: { numeric: true }, enableGlobalFilter: false }),
];
const costColumn = machine.accessor((r) => r.costRate ?? "", {
  id: "costRate",
  header: "Cost rate / sq ft",
  cell: (c) => rateText(c.getValue()),
  meta: { numeric: true },
  enableGlobalFilter: false,
});

/** Machines (A§2, P2): the printer → machine map the agent uses, and the rates per sq ft (blank until Q7). */
export function Machines({ rows, action, cost }: { rows: MachineRow[]; action: Action; cost: boolean }) {
  const [editing, setEditing] = useState<MachineRow | "new" | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const row = editing === "new" ? null : editing;
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>New machine</Button>
      </div>
      <DataTable
        data={rows}
        columns={cost ? [...machineBase, costColumn] : machineBase}
        status={statusOf}
        searchPlaceholder="Search machines or printers"
        onRowClick={setEditing}
        pageSize={50}
        empty={{ title: "No machines yet." }}
      />
      {editing && (
        <CategoryDialog
          key={row?.id ?? "new"}
          title={row ? row.name : "New machine"}
          description="Print jobs take the sale rate for new prints and the cost rate for prints on an existing job."
          action={action}
          onClose={close}
          fields={(error) => (
            <>
              <input type="hidden" name="id" value={row?.id ?? ""} />
              <Field label="Name" error={error("name")}>
                <Input name="name" defaultValue={row?.name ?? ""} required maxLength={100} placeholder="UV Roll to Roll" />
              </Field>
              <Field label="Windows printer names" hint="One per line, as Windows shows them. Each printer feeds one machine." error={error("printerNames")}>
                <Textarea name="printerNames" rows={3} defaultValue={row?.printers.join("\n") ?? ""} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sale rate per sq ft (₹)" hint="Blank until it is decided." error={error("saleRate")}>
                  <Input name="saleRate" defaultValue={row?.saleRate ?? ""} inputMode="decimal" className="text-right tabular-nums" />
                </Field>
                {cost && (
                  <Field label="Cost rate per sq ft (₹)" hint="Internal: for prints on a job." error={error("costRate")}>
                    <Input name="costRate" defaultValue={row?.costRate ?? ""} inputMode="decimal" className="text-right tabular-nums" />
                  </Field>
                )}
              </div>
              {row && <ActiveBox active={row.active} what="printing" />}
            </>
          )}
        />
      )}
    </div>
  );
}

const type = tableColumns<TypeRow>();
const typeColumns = [
  type.accessor("name", { header: "Printing type", cell: (c) => <NameCell name={c.getValue()} active={c.row.original.active} /> }),
  type.accessor("category", { header: "Invoice category", cell: (c) => c.getValue() || "Picked when billing" }),
];

/** Printing types: the optional product category a billed print job's invoice line takes (D64). */
export function PrintingTypes({ rows, categories, action }: { rows: TypeRow[]; categories: { id: number; name: string }[]; action: Action }) {
  const [editing, setEditing] = useState<TypeRow | "new" | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const row = editing === "new" ? null : editing;
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>New printing type</Button>
      </div>
      <DataTable
        data={rows}
        columns={typeColumns}
        status={statusOf}
        searchPlaceholder="Search printing types"
        onRowClick={setEditing}
        pageSize={50}
        empty={{ title: "No printing types yet." }}
      />
      {editing && (
        <CategoryDialog
          key={row?.id ?? "new"}
          title={row ? row.name : "New printing type"}
          description="When print jobs are billed, their invoice lines take this category (else you pick one then)."
          action={action}
          onClose={close}
          fields={(error) => (
            <>
              <input type="hidden" name="id" value={row?.id ?? ""} />
              <Field label="Name" error={error("name")}>
                <Input name="name" defaultValue={row?.name ?? ""} required maxLength={100} placeholder="Flex, Vinyl, UV…" />
              </Field>
              <Field label="Invoice category" error={error("categoryId")}>
                <NativeSelect name="categoryId" defaultValue={row?.categoryId ?? ""} className="w-full">
                  <NativeSelectOption value="">None (pick when billing)</NativeSelectOption>
                  {categories.map((c) => (
                    <NativeSelectOption key={c.id} value={String(c.id)}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {row && <ActiveBox active={row.active} what="printing" />}
            </>
          )}
        />
      )}
    </div>
  );
}
