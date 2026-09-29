import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { expenseFormOptions } from "@/lib/expenses";
import { MODE_ACCOUNT } from "@/lib/receipt-modes";
import { createExpenseAction } from "../actions";
import { ExpenseForm } from "../expense-form";

/** ?job= tags the job (from a job page). */
export default async function NewExpensePage({ searchParams }: PageProps<"/expenses/new">) {
  await requirePermission("books", "create");
  const { job } = await searchParams;
  const options = await expenseFormOptions();
  const cash = options.accounts.find((a) => a.systemKey === MODE_ACCOUNT.cash);
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/expenses", label: "Expenses" }} title="New expense" />
      <ExpenseForm
        values={{
          date: todayIST(),
          categoryId: "",
          vendorId: "",
          jobId: options.jobs.some((j) => String(j.id) === job) ? String(job) : "",
          amount: "",
          mode: "cash",
          moneyAccountId: cash ? String(cash.id) : "",
          notes: "",
        }}
        options={options}
        submitLabel="Save expense"
        back="/expenses"
        action={createExpenseAction}
      />
    </div>
  );
}
