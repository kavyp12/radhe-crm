import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth";
import { loadDashboard, type Ranked, type Stat } from "@/lib/dashboard";
import { todayIST } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { MonthlyChart } from "./monthly-chart";

// R1 flows are this month's; the rest are balances right now.
const THIS_MONTH = new Set(["sales", "collection", "purchase", "expense", "profit"]);

export default async function DashboardPage() {
  const user = await requireUser();
  if (!can(user, "salesReports")) redirect("/jobs");
  const d = loadDashboard(user);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Dashboard"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <DateText date={todayIST()} />
            <span className="rounded border border-dashed border-zinc-300 px-1.5 text-xs leading-5">Sample figures</span>
          </span>
        }
      />

      <section
        aria-label="Main numbers"
        className={cn(
          "grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border",
          d.kpis.length > 2 && "lg:grid-cols-4",
        )}
      >
        {d.kpis.map((s) => (
          <div key={s.key} className="bg-card px-4 py-3.5">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <Money paise={s.paise} className="mt-1 block text-lg leading-7 font-medium tracking-tight sm:text-xl" />
            <p className="text-xs text-muted-foreground">{THIS_MONTH.has(s.key) ? "This month" : "Right now"}</p>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Today">
          <Figures stats={d.today} />
        </Panel>
        <Panel title="Current position">
          <Figures stats={d.current} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="This financial year" className="lg:col-span-2">
          <MonthlyChart months={d.months} />
        </Panel>
        <Panel title="Performance this month">
          <dl className="grid gap-3">
            {d.performance.map((s) => (
              <div key={s.key} className="flex items-baseline justify-between gap-4 text-sm">
                <dt className="text-muted-foreground">{s.label}</dt>
                <dd>
                  <Money paise={s.paise} className="font-medium" />
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Top customers this month">
          <RankedList items={d.topCustomers} />
        </Panel>
        <Panel title="Top services this month">
          <RankedList items={d.topServices} />
        </Panel>
        <Panel title="Follow-ups due">
          <ul className="-my-2 divide-y">
            {d.followUps.map((f) => (
              <li key={f.invoice} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{f.customer}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="tabular-nums">{f.invoice}</span>, {f.note.toLowerCase()}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <Money paise={f.paise} className="block text-sm font-medium" />
                  <span className="text-muted-foreground">
                    Due <DateText date={f.due} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <h2 className="border-b px-4 py-3 text-sm font-medium">{title}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Figures({ stats }: { stats: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
      {stats.map((s) => (
        <div key={s.key}>
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd>
            <Money paise={s.paise} className="text-base font-medium" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RankedList({ items }: { items: Ranked[] }) {
  const top = items[0]?.paise || 1n;
  return (
    <ol className="grid gap-2.5">
      {items.map((item) => (
        <li key={item.name} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{item.name}</span>
            <Money paise={item.paise} className="text-muted-foreground" />
          </div>
          <div aria-hidden className="h-1 overflow-hidden rounded-full bg-zinc-100">
            {/* bar length only; the amount above is exact */}
            <div className="h-full rounded-full bg-primary/70" style={{ width: `${Number((item.paise * 100n) / top)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
