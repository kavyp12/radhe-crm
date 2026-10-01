import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth";
import { loadDashboard, type Ranked, type Stat } from "@/lib/dashboard";
import { formatDateTime, todayIST } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { AutoRefresh } from "./auto-refresh";
import { MonthlyChart } from "./monthly-chart";

// R1 flows are this month's; the rest are balances right now.
const THIS_MONTH = new Set(["sales", "collection", "purchase", "expense", "profit"]);

export default async function DashboardPage() {
  const user = await requireUser();
  if (!can(user, "salesReports")) redirect("/jobs");
  const d = await loadDashboard(user);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Dashboard"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <DateText date={todayIST()} />
            <span className="text-xs">· updated {formatDateTime(new Date()).slice(11)} · refreshes every minute</span>
          </span>
        }
      />
      <AutoRefresh seconds={60} />

      <section
        aria-label="Main numbers"
        className={cn(
          "grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border",
          d.kpis.length > 2 && "lg:grid-cols-4",
        )}
      >
        {d.kpis.map((s) => (
          <Linked key={s.key} href={s.href} className="bg-card px-4 py-3.5">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <Money paise={s.paise} className="mt-1 block text-lg leading-7 font-medium tracking-tight sm:text-xl" />
            <p className="text-xs text-muted-foreground">{THIS_MONTH.has(s.key) ? "This month" : "Right now"}</p>
          </Linked>
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
                <dt className="text-muted-foreground">
                  {s.href ? (
                    <Link href={s.href} className="hover:text-foreground hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    s.label
                  )}
                </dt>
                <dd>
                  <Money paise={s.paise} className="font-medium" />
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div className={cn("grid grid-cols-1 gap-5", d.followUps ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
        <Panel title="Top customers this financial year">
          <RankedList items={d.topCustomers} />
        </Panel>
        <Panel title="Top services this financial year">
          <RankedList items={d.topServices} />
        </Panel>
        {d.followUps && (
          <Panel title="My follow-ups due">
            {d.followUps.length === 0 && <p className="text-sm text-muted-foreground">Nothing due today.</p>}
            <ul className="-my-2 divide-y">
              {d.followUps.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`/follow-ups?customer=${f.customerId}`}
                    className="-mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-zinc-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{f.customer}</p>
                      <p className="truncate text-xs text-muted-foreground">{[f.invoice, f.note].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="shrink-0 text-right text-xs">
                      {f.paise !== null && <Money paise={f.paise} className="block text-sm font-medium" />}
                      <span className="text-muted-foreground">
                        Reminder <DateText date={f.due} />
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
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

/** A figure that opens its source page, when this user may open it. */
function Linked({ href, className, children }: { href?: string; className?: string; children: ReactNode }) {
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link href={href} className={cn(className, "outline-none transition-colors hover:bg-zinc-50 focus-visible:bg-primary/[0.06]")}>
      {children}
    </Link>
  );
}

function Figures({ stats }: { stats: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
      {stats.map((s) => (
        <Linked key={s.key} href={s.href} className="-m-2 rounded-md p-2">
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd>
            <Money paise={s.paise} className="text-base font-medium" />
          </dd>
        </Linked>
      ))}
    </dl>
  );
}

function RankedList({ items }: { items: Ranked[] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No sales yet this financial year.</p>;
  const top = items[0].paise;
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
