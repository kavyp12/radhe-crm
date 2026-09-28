import Link from "next/link";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { JOB_STATUS, jobBoard, PRODUCTION_STATUSES } from "@/lib/jobs";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { StatusButtons } from "../status-buttons";

/** Production board (T11): In Production / Ready / Delivered, earliest target first, overdue in red. */
export default async function BoardPage() {
  const user = await requirePermission("jobs", "view");
  const rows = await jobBoard(user);
  const today = todayIST();
  const canMove = can(user, "jobs", "status");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/jobs", label: "Jobs" }}
        title="Production board"
        description="Jobs not yet invoiced. Invoiced and cancelled jobs leave the board."
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {PRODUCTION_STATUSES.map((status) => {
          const cards = rows.filter((r) => r.status === status);
          return (
            <section key={status} aria-label={JOB_STATUS[status]} className="grid content-start gap-2 rounded-lg border bg-muted/40 p-2">
              <h2 className="flex items-center justify-between px-1 py-1 text-sm font-medium">
                <StatusBadge status={JOB_STATUS[status]} />
                <span className="text-xs text-muted-foreground tabular-nums">{cards.length}</span>
              </h2>
              {cards.map((job) => {
                const overdue = status !== "delivered" && !!job.targetDate && job.targetDate < today;
                return (
                  <article
                    key={job.id}
                    className={cn("grid gap-1.5 rounded-md border bg-card p-3 text-sm", overdue && "border-red-300 bg-red-50/50")}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <Link href={`/jobs/${job.id}`} className="font-medium tabular-nums hover:underline">
                        {job.number}
                      </Link>
                      {"total" in job && <Money paise={job.total} className="text-xs text-muted-foreground" />}
                    </div>
                    <p className="truncate">{job.firmName ?? job.customer}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{job.items.join(" · ")}</p>
                    <p className={cn("text-xs", overdue ? "font-medium text-red-700" : "text-muted-foreground")}>
                      {job.targetDate ? (
                        <>
                          Target <DateText date={job.targetDate} />
                          {overdue && " · overdue"}
                        </>
                      ) : (
                        "No target date"
                      )}
                    </p>
                    {canMove && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <StatusButtons id={job.id} status={job.status} size="sm" />
                      </div>
                    )}
                  </article>
                );
              })}
              {!cards.length && <p className="px-1 py-4 text-center text-xs text-muted-foreground">Nothing here.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
