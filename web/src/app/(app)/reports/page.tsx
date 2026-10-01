import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { REPORT_INDEX } from "@/lib/reports";

/** S20: the reports this user may open. Each downloads as Excel / PDF from its own page (S27). */
export default async function ReportsPage() {
  const user = await requirePermission("salesReports", "view");
  const list = REPORT_INDEX.filter((r) => can(user, r.area, "view"));
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5">
      <PageHeader title="Reports" description="Pick a report, set its dates and filters, then download Excel or PDF, print or share." />
      <ul className="overflow-hidden rounded-lg border bg-card text-sm">
        {list.map((r) => (
          <li key={r.n} className="border-b last:border-b-0">
            {r.href ? (
              <Link href={r.href} className="flex items-center gap-3 px-4 py-3 font-medium hover:bg-muted/40">
                <span className="w-6 text-xs text-muted-foreground tabular-nums">{r.n}</span>
                <span className="flex-1">{r.title}</span>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </Link>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-3 text-muted-foreground">
                <span className="w-6 text-xs tabular-nums">{r.n}</span>
                <span className="flex-1">{r.title}</span>
                <span className="text-xs">Coming in the next step</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
