import Link from "next/link";
import { ListPeriod } from "@/components/list-period";
import { PageHeader } from "@/components/page-header";
import { ExportExcelButton } from "@/components/report-actions";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { listExpenses } from "@/lib/expenses";
import { can } from "@/lib/permissions";
import { listPeriod } from "@/lib/statements";
import { ExpensesTable } from "./expenses-table";

export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const user = await requirePermission("books", "view");
  const period = listPeriod(await searchParams);
  const rows = await listExpenses(period.range);
  const newButton = can(user, "books", "create") ? (
    <Button asChild>
      <Link href="/expenses/new">New expense</Link>
    </Button>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Expenses" description="Day-to-day spending, by category; tagged to a job when it is for one." action={
          <div className="flex gap-2">
            <ExportExcelButton name="expenses" query={period.query} />
            {newButton}
          </div>
        }
      />
      <ListPeriod {...period} />
      <ExpensesTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          date: r.date,
          category: r.category,
          vendor: r.vendor ?? "",
          job: r.job ?? "",
          account: r.account,
          status: r.status === "cancelled" ? "Cancelled" : "Active",
          amount: r.amount,
        }))}
        newButton={newButton}
      />
    </div>
  );
}
