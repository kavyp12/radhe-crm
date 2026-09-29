"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type LineColumn = {
  key: string;
  label: string;
  numeric?: boolean;
  /** Tailwind width class for the column, e.g. "w-24". */
  width?: string;
  placeholder?: string;
  /** True when the text can't be read (e.g. parseQty throws); the cell turns red. */
  invalid?: (value: string) => boolean;
  /** A pick list instead of free text. */
  options?: { value: string; label: string }[];
  /** Free text with suggestions (a datalist). */
  suggestions?: string[];
};
export type LineRow = { id: string } & Record<string, string>;

type Props = {
  columns: LineColumn[];
  rows: LineRow[];
  onChange: (rows: LineRow[]) => void;
  newRow: () => LineRow;
  /** Read-only amount shown at the end of each line. */
  amount?: (row: LineRow) => ReactNode;
  /** Tailwind min-width for wide grids (scrolls sideways inside its card). */
  minWidth?: string;
  /** A cell that can't be changed on this row (e.g. a bill line's item and qty as received on a GRN). */
  locked?: (row: LineRow, key: string) => boolean;
};

/** Line-items grid (DESIGN.md "Form"): Tab moves across cells, Enter adds a line below. */
export function LineItemsGrid({ columns, rows, onChange, newRow, amount, minWidth = "min-w-[640px]", locked }: Props) {
  const grid = useRef<HTMLTableElement>(null);
  const listId = useId();
  const focusCell = (row: number, col: number) =>
    requestAnimationFrame(() => grid.current?.querySelector<HTMLInputElement>(`[data-cell="${row}:${col}"]`)?.focus());

  const set = (index: number, key: string, value: string) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  function addAfter(index: number) {
    onChange([...rows.slice(0, index + 1), newRow(), ...rows.slice(index + 1)]);
    focusCell(index + 1, 0);
  }
  const remove = (index: number) => onChange(rows.length > 1 ? rows.filter((_, i) => i !== index) : [newRow()]);

  const head = "h-9 border-b px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
  return (
    <div>
      {/* relative: keeps the sr-only header label inside the scroll area */}
      <div className="relative overflow-x-auto">
        <table ref={grid} className={cn("w-full border-separate border-spacing-0 text-[13px]", minWidth)}>
          <thead>
            <tr>
              <th scope="col" className={cn(head, "w-8 text-right")}>
                #
              </th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cn(head, column.width, column.numeric && "text-right")}>
                  {column.label}
                </th>
              ))}
              {amount && (
                <th scope="col" className={cn(head, "w-26 text-right")}>
                  Amount
                </th>
              )}
              <th scope="col" className={cn(head, "w-9")}>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id} className="group/line">
                <td className="border-b px-2 text-right text-muted-foreground tabular-nums">{i + 1}</td>
                {columns.map((column, j) => {
                  const value = row[column.key] ?? "";
                  const invalid = !!value && !!column.invalid?.(value);
                  const fixed = !!locked?.(row, column.key);
                  const cell = {
                    "data-cell": `${i}:${j}`,
                    "aria-label": `${column.label}, line ${i + 1}`,
                    "aria-invalid": invalid || undefined,
                    value,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAfter(i);
                      }
                    },
                    className: cn(
                      "h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 outline-none transition-colors duration-100",
                      "placeholder:text-muted-foreground/60 hover:border-input focus:border-ring focus:bg-card focus:ring-2 focus:ring-ring/25",
                      column.numeric && "text-right tabular-nums",
                      invalid && "border-destructive/60 bg-destructive/5 hover:border-destructive/60",
                      fixed && "text-muted-foreground hover:border-transparent",
                    ),
                  };
                  return (
                    <td key={column.key} className="border-b p-1">
                      {column.options ? (
                        <select {...cell} disabled={fixed} onChange={(e) => set(i, column.key, e.target.value)}>
                          <option value="">{column.placeholder ?? "—"}</option>
                          {column.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          {...cell}
                          readOnly={fixed}
                          placeholder={column.placeholder}
                          inputMode={column.numeric ? "decimal" : undefined}
                          list={column.suggestions ? `${listId}-${column.key}` : undefined}
                          onChange={(e) => set(i, column.key, e.target.value)}
                        />
                      )}
                    </td>
                  );
                })}
                {amount && <td className="border-b px-2 text-right whitespace-nowrap tabular-nums">{amount(row)}</td>}
                <td className="border-b px-1 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove line ${i + 1}`}
                    className="text-muted-foreground opacity-60 group-hover/line:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    onClick={() => remove(i)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {columns
        .filter((column) => column.suggestions)
        .map((column) => (
          <datalist key={column.key} id={`${listId}-${column.key}`}>
            {column.suggestions!.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        ))}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => addAfter(rows.length - 1)}>
          <Plus />
          Add line
        </Button>
        <p className="text-xs text-muted-foreground">Tab moves between cells. Enter adds a line.</p>
      </div>
    </div>
  );
}

/** The live totals block beside a form (below it on a phone). */
export function TotalsPanel({
  rows,
  total,
  words,
  after = [],
}: {
  rows: { label: string; paise: bigint }[];
  total: bigint;
  words?: string;
  /** Below the total, e.g. Advance adjusted and Balance (S5). */
  after?: { label: string; paise: bigint; strong?: boolean }[];
}) {
  return (
    <div className="rounded-lg border bg-card">
      <dl className="grid gap-2 p-4 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd>
              <Money paise={row.paise} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm font-medium">Total</span>
          <Money paise={total} className="text-xl font-medium tracking-tight" />
        </div>
        {words && <p className="mt-1 text-xs text-muted-foreground">{words}</p>}
      </div>
      {after.length > 0 && (
        <dl className="grid gap-2 border-t p-4 text-sm">
          {after.map((row) => (
            <div key={row.label} className={cn("flex items-center justify-between gap-4", row.strong && "font-medium")}>
              <dt className={row.strong ? undefined : "text-muted-foreground"}>{row.label}</dt>
              <dd>
                <Money paise={row.paise} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
