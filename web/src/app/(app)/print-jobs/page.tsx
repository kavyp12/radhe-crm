import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listPrintJobs, listRow } from "@/lib/print-jobs";
import { PrintJobsTable } from "./print-jobs-table";

const PERIODS = ["today", "yesterday", "week", "month"] as const;

/**
 * P6 / A§8: owner and accountant full; sales view; production view without money (stripped in the loader).
 * ?period= / ?status= / ?machine= / ?billing= start the list filtered (the dashboard's Printing today links here).
 */
export default async function PrintJobsPage({ searchParams }: PageProps<"/print-jobs">) {
  const user = await requirePermission("printJobs", "view");
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const picked = Object.fromEntries(
    [["Machine", text("machine")], ["Billing", text("billing")]].filter(([, v]) => v),
  );
  const rows = await listPrintJobs(user);
  const newButton = can(user, "printJobs", "create") ? (
    <Button asChild>
      <Link href="/print-jobs/new">New print job</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Print jobs"
        description="Every print on a Radhe machine, with its payment. New prints are billed later; prints on a job are its cost."
        action={
          <div className="flex flex-wrap gap-2">
            {can(user, "printJobs", "edit") && (
              <Button asChild variant="outline">
                <Link href="/print-jobs/setup">Machines & types</Link>
              </Button>
            )}
            {can(user, "invoices", "create") && can(user, "printJobs", "edit") && (
              <Button asChild variant="outline">
                <Link href="/print-jobs/unbilled">Bill print jobs</Link>
              </Button>
            )}
            {newButton}
          </div>
        }
      />
      <PrintJobsTable
        rows={rows.map(listRow)}
        showMoney={can(user, "printJobs", "money")}
        newButton={newButton}
        initial={{ preset: PERIODS.find((p) => p === text("period")), status: text("status") || undefined, picked }}
      />
    </div>
  );
}
