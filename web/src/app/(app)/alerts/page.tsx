import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { ALERT_KINDS, alertsFor, type AlertKind } from "@/lib/alerts";
import { requireUser } from "@/lib/auth";

/** S25 / D22: what needs attention now, from live queries; only the areas this user can open. */
export default async function AlertsPage() {
  const user = await requireUser();
  const alerts = await alertsFor(user);
  const kinds = (Object.keys(ALERT_KINDS) as AlertKind[]).filter((k) => alerts.some((a) => a.kind === k));

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader title="Alerts" description="Payments due and overdue, promises, vendor bills, credit limits and approvals — as of now." />
      {alerts.length === 0 && <EmptyState title="Nothing needs attention." />}
      {kinds.map((kind) => {
        const list = alerts.filter((a) => a.kind === kind);
        return (
          <section key={kind} aria-label={ALERT_KINDS[kind]} className="rounded-lg border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-medium">
              {ALERT_KINDS[kind]} <span className="font-normal text-muted-foreground">({list.length})</span>
            </h2>
            <ul>
              {list.map((a) => (
                <li key={a.key} className="border-b last:border-b-0">
                  <Link href={a.href} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2.5 text-[13px] hover:bg-muted/40">
                    <span className="min-w-40 font-medium">{a.title}</span>
                    <span className="min-w-0 flex-1 text-muted-foreground">{a.detail}</span>
                    {a.amount !== undefined && <Money paise={a.amount} className="font-medium" />}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
