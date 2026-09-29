"use client";

import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFns,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { DateInput } from "@/components/date-input";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { periodRange, type Period } from "@/lib/dates";
import { cn } from "@/lib/utils";

// DESIGN.md "List": filter bar (search, date preset, status) → sortable table with sticky header, right-aligned
// money and a totals row → pagination. Filtering, sorting and paging run in the browser.
// ponytail: fine for a few thousand rows; switch the table to manual (server) paging when a list outgrows that.

type ColumnMeta = {
  /** Right-align (money, qty). */
  numeric?: boolean;
  /** Sum this column (bigint paise) in the totals row, over all filtered rows. */
  total?: boolean;
};

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<ColumnMeta>(),
});

type Features = typeof features;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns of one table hold different value types
export type DataTableColumn<T extends RowData> = ColumnDef<Features, T, any>;
/** Build columns for a DataTable: `const col = tableColumns<Invoice>()` → `col.accessor("number", {...})`. */
export const tableColumns = <T extends RowData>() => createColumnHelper<Features, T>();

const PRESETS: { value: Period | "custom"; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom…" },
];

type Props<T extends RowData> = {
  data: T[];
  columns: DataTableColumn<T>[];
  /** The row's business date ('YYYY-MM-DD'); turns on the date preset filter. */
  date?: (row: T) => string;
  /** The row's status; turns on the status filter. */
  status?: (row: T) => string;
  /** More pick-one filters (e.g. category, job): each lists the distinct values it finds. Keep the array stable. */
  filters?: { label: string; value: (row: T) => string }[];
  onRowClick?: (row: T) => void;
  searchPlaceholder?: string;
  pageSize?: number;
  /** Shown when there are no rows at all (not just none matching the filters). */
  empty?: { title: string; action?: ReactNode };
};

export function DataTable<T extends RowData>({
  data,
  columns,
  date,
  status,
  filters,
  onRowClick,
  searchPlaceholder = "Search",
  pageSize = 25,
  empty,
}: Props<T>) {
  const [preset, setPreset] = useState<Period | "custom" | "">("");
  const [custom, setCustom] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [statusFilter, setStatusFilter] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});

  const statuses = useMemo(() => (status ? [...new Set(data.map(status))].sort() : []), [data, status]);
  const choices = useMemo(
    () => (filters ?? []).map((f) => [...new Set(data.map(f.value))].filter(Boolean).sort()),
    [data, filters],
  );
  const rows = useMemo(() => {
    const range = preset === "custom" ? custom : preset ? periodRange(preset) : null;
    return data.filter(
      (row) =>
        (!range || !date || ((!range.from || date(row) >= range.from) && (!range.to || date(row) <= range.to))) &&
        (!statusFilter || !status || status(row) === statusFilter) &&
        (filters ?? []).every((f) => !picked[f.label] || f.value(row) === picked[f.label]),
    );
  }, [data, date, status, filters, preset, custom, statusFilter, picked]);

  const table = useTable({
    features,
    columns,
    data: rows,
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const filtered = table.getFilteredRowModel().rows;
  const leafColumns = table.getAllLeafColumns();
  const hasTotals = leafColumns.some((column) => column.columnDef.meta?.total);
  const { pageIndex } = table.state.pagination;
  const first = filtered.length ? pageIndex * pageSize + 1 : 0;
  const last = Math.min((pageIndex + 1) * pageSize, filtered.length);
  const filtersOn = !!(table.state.globalFilter || preset || statusFilter || Object.values(picked).some(Boolean));

  function clearFilters() {
    table.setGlobalFilter("");
    setPreset("");
    setCustom({ from: null, to: null });
    setStatusFilter("");
    setPicked({});
  }

  if (!data.length && empty) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState title={empty.title} action={empty.action} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search"
            placeholder={searchPlaceholder}
            value={String(table.state.globalFilter ?? "")}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
            className="pl-8"
          />
        </div>
        {date && (
          <NativeSelect
            aria-label="Date"
            value={preset}
            onChange={(e) => setPreset(e.target.value as Period | "custom" | "")}
          >
            <NativeSelectOption value="">All dates</NativeSelectOption>
            {PRESETS.map((p) => (
              <NativeSelectOption key={p.value} value={p.value}>
                {p.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {date && preset === "custom" && (
          <div className="flex items-start gap-2">
            <DateInput aria-label="From date" className="w-32" onValueChange={(from) => setCustom((c) => ({ ...c, from }))} />
            <DateInput aria-label="To date" className="w-32" onValueChange={(to) => setCustom((c) => ({ ...c, to }))} />
          </div>
        )}
        {status && (
          <NativeSelect aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {statuses.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {s}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {(filters ?? []).map((f, i) => (
          <NativeSelect
            key={f.label}
            aria-label={f.label}
            value={picked[f.label] ?? ""}
            onChange={(e) => setPicked((p) => ({ ...p, [f.label]: e.target.value }))}
          >
            <NativeSelectOption value="">{`All (${f.label.toLowerCase()})`}</NativeSelectOption>
            {choices[i].map((v) => (
              <NativeSelectOption key={v} value={v}>
                {v}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ))}
        {filtersOn && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      <div className="relative max-h-[calc(100svh-15rem)] min-h-40 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const numeric = header.column.columnDef.meta?.numeric;
                  const sorted = header.column.getIsSorted();
                  const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn(
                        "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground",
                        numeric && "text-right",
                      )}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded px-1 align-middle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                            numeric && "flex-row-reverse",
                            sorted && "text-foreground",
                          )}
                        >
                          <table.FlexRender header={header} />
                          <SortIcon aria-hidden className={cn("size-3.5", !sorted && "opacity-40")} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row.original);
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={cn(
                  "transition-colors duration-100 hover:bg-zinc-50",
                  onRowClick && "cursor-pointer outline-none focus-visible:bg-primary/[0.06]",
                )}
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(
                      "h-10 border-b px-3 whitespace-nowrap",
                      cell.column.columnDef.meta?.numeric && "text-right tabular-nums",
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={leafColumns.length}>
                  <EmptyState
                    icon={Search}
                    title="Nothing matches these filters."
                    action={
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
          {hasTotals && filtered.length > 0 && (
            <tfoot className="sticky bottom-0 bg-zinc-50 font-medium">
              <tr>
                {leafColumns.map((column, i) => (
                  <td
                    key={column.id}
                    className={cn(
                      "h-10 border-t px-3 whitespace-nowrap",
                      column.columnDef.meta?.numeric && "text-right tabular-nums",
                    )}
                  >
                    {column.columnDef.meta?.total ? (
                      <Money paise={filtered.reduce((sum, row) => sum + (row.getValue(column.id) as bigint), 0n)} />
                    ) : i === 0 ? (
                      `Total (${filtered.length} ${filtered.length === 1 ? "row" : "rows"})`
                    ) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {first}–{last} of {filtered.length}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
