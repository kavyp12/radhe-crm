import { eq } from "drizzle-orm";
import Link from "next/link";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { followUps } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { listFollowUps, myFollowUpsDue } from "@/lib/follow-ups";
import { can } from "@/lib/permissions";
import { FollowUpsTable } from "./follow-ups-table";

/** S8: my follow-ups due today, then every follow-up (?customer= narrows to one customer, e.g. from an alert). */
export default async function FollowUpsPage({ searchParams }: PageProps<"/follow-ups">) {
  const user = await requirePermission("followUps", "view");
  const q = await searchParams;
  const customerId = typeof q.customer === "string" ? Number(q.customer) : NaN;
  const one = Number.isSafeInteger(customerId);
  const today = todayIST();
  const [mine, rows] = await Promise.all([myFollowUpsDue(user, today), listFollowUps(one ? eq(followUps.customerId, customerId) : undefined, today)]);
  const newButton = can(user, "followUps", "create") ? (
    <Button asChild>
      <Link href={one ? `/follow-ups/new?customer=${customerId}` : "/follow-ups/new"}>New follow-up</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={one && rows[0] ? `Follow-ups · ${rows[0].customer}` : "Follow-ups"}
        back={one ? { href: "/follow-ups", label: "All follow-ups" } : undefined}
        description="Payment follow-ups: what the customer said, promises to pay, and the next reminder."
        action={newButton}
      />

      {!one && (
        <section aria-label="My follow-ups due" className="rounded-lg border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-medium">
            My follow-ups due <span className="font-normal text-muted-foreground">({mine.length})</span>
          </h2>
          {mine.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Nothing due today.</p>
          ) : (
            <ul>
              {mine.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 text-[13px] last:border-b-0">
                  <span className="min-w-40 font-medium">{f.customer}</span>
                  <span className={f.nextReminderDate! < today ? "text-red-700" : "text-muted-foreground"}>
                    Reminder <DateText date={f.nextReminderDate!} />
                  </span>
                  {f.promise && f.promise !== "Kept" && (
                    <span className="text-muted-foreground">
                      Promised <Money paise={f.expected!} /> for <DateText date={f.promiseDate!} /> · {f.promise}
                    </span>
                  )}
                  <span className="min-w-0 basis-full truncate text-muted-foreground sm:flex-1">{f.response}</span>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/follow-ups/new?customer=${f.customerId}`}>Log follow-up</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <FollowUpsTable
        rows={rows.map((r) => ({
          id: r.id,
          customerId: r.customerId,
          customer: r.customer,
          invoice: r.invoice ?? "",
          followUpDate: r.followUpDate,
          person: r.person,
          response: r.response ?? "",
          promiseDate: r.promiseDate,
          expected: r.expected,
          promise: r.promise ?? "No promise",
          nextReminderDate: r.nextReminderDate,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
