"use client";

import { useRouter } from "next/navigation";
import { DataTable, tableColumns, type DataTableColumn } from "@/components/data-table";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { drCr, milliText } from "@/lib/num";
import { columnTotal, hasTotals, isNumeric, type ReportCell, type ReportColumn, type ReportRow, type ReportTable } from "@/lib/report";
import { cn } from "@/lib/utils";

const col = tableColumns<ReportRow>();

function columnsOf(table: ReportTable): DataTableColumn<ReportRow>[] {
  return table.columns.map((c) =>
    col.accessor((r) => r[c.key], {
      id: c.key,
      header: c.label,
      cell: (v) => cellOf(c, v.getValue()),
      meta: { numeric: isNumeric(c), total: c.total },
      enableGlobalFilter: !c.type || c.type === "text",
    }),
  );
}

function cellOf(c: ReportColumn, value: ReportCell | undefined) {
  if (value === null || value === undefined) return "—";
  if (c.type === "money") return <Money paise={value as bigint} />;
  if (c.type === "balance") return drCr(value as bigint);
  if (c.type === "qty") return milliText(value as bigint);
  if (c.type === "date") return <DateText date={value as string} />;
  return String(value);
}

/** A short totals block (e.g. totals by mode): a plain table, no search or paging. */
function Summary({ table }: { table: ReportTable }) {
  const num = (c: ReportColumn) => cn("h-9 border-b px-3 whitespace-nowrap", isNumeric(c) && "text-right tabular-nums");
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={cn(num(c), "text-xs font-medium text-muted-foreground", !isNumeric(c) && "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {table.columns.map((c) => (
                <td key={c.key} className={num(c)}>
                  {cellOf(c, r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals(table) && table.rows.length > 0 && (
          <tfoot className="bg-zinc-50 font-medium">
            <tr>
              {table.columns.map((c, i) => (
                <td key={c.key} className={cn(num(c), "border-b-0")}>
                  {c.total ? <Money paise={columnTotal(table, c.key)} /> : i === 0 ? "Total" : null}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * A report's tables on its page — the same rows and totals as its Excel / PDF (D59). The first is the report itself
 * (search, sort, totals; rows with an href open it); later ones are totals blocks.
 */
export function ReportView({ tables }: { tables: ReportTable[] }) {
  const router = useRouter();
  return tables.map((t, i) =>
    i > 0 && t.rows.length === 0 ? null : (
      <section key={i} aria-label={t.title ?? "Report"} className="grid gap-2">
        {t.title && <h2 className="text-sm font-medium">{t.title}</h2>}
        {i === 0 ? (
          <DataTable
            data={t.rows}
            columns={columnsOf(t)}
            pageSize={100}
            onRowClick={t.rows.some((r) => r.href) ? (r) => r.href && router.push(r.href) : undefined}
            empty={{ title: "Nothing in this period." }}
          />
        ) : (
          <Summary table={t} />
        )}
      </section>
    ),
  );
}
