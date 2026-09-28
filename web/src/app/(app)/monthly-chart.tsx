"use client";

import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthPoint } from "@/lib/dashboard";
import { formatMoney } from "@/lib/num";

const SERIES = [
  { key: "sales", label: "Sales", color: "var(--chart-1)" },
  { key: "collection", label: "Collection", color: "var(--chart-2)" },
  { key: "expense", label: "Expense", color: "var(--chart-3)" },
] as const;
type Series = (typeof SERIES)[number];

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 };

/** Monthly sales / collection / expense for the financial year so far. Sales users get the sales series only. */
export function MonthlyChart({ months }: { months: MonthPoint[] }) {
  const series = SERIES.filter((s) => months.some((m) => m[s.key] !== undefined));
  // Bar heights only: whole rupees as numbers. Every amount people read stays exact (formatMoney on paise).
  const data = months.map((m) => ({
    month: m.month,
    ...Object.fromEntries(series.map((s) => [s.key, Number((m[s.key] ?? 0n) / 100n)])),
  }));

  return (
    <figure className="grid gap-3">
      {series.length > 1 && (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <BarChart
        responsive
        accessibilityLayer
        data={data}
        barGap={2}
        barCategoryGap="28%"
        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        style={{ width: "100%", height: 240 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tick={axisTick} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={axisTick}
          width={52}
          tickFormatter={(value: number) => `₹${compact.format(value)}`}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          content={({ active, label }) => <ChartTooltip active={active} label={label} months={months} series={series} />}
        />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
      <table className="sr-only">
        <caption>Monthly figures</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{m.month}</th>
              {series.map((s) => (
                <td key={s.key}>{formatMoney(m[s.key] ?? 0n)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function ChartTooltip({
  active,
  label,
  months,
  series,
}: {
  active?: boolean;
  label?: string | number;
  months: MonthPoint[];
  series: Series[];
}) {
  const month = months.find((m) => m.month === label);
  if (!active || !month) return null;
  return (
    <div className="grid min-w-44 gap-1.5 rounded-md border bg-popover p-2.5 text-xs shadow-md">
      <p className="font-medium">{label}</p>
      {series.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="size-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="tabular-nums">{formatMoney(month[s.key] ?? 0n)}</span>
        </div>
      ))}
    </div>
  );
}
