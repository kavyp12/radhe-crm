import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { needsBackdateApproval } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { expenseFormOptions, getExpense } from "@/lib/expenses";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { updateExpenseAction } from "../../actions";
import { ExpenseForm } from "../../expense-form";

export default async function EditExpensePage({ params }: PageProps<"/expenses/[id]/edit">) {
  const user = await requirePermission("books", "edit");
  const id = Number((await params).id);
  const e = Number.isSafeInteger(id) ? await getExpense(id) : undefined;
  if (!e) notFound();
  if (e.status !== "active") redirect(`/expenses/${id}`);
  const options = await expenseFormOptions(e);
  // An old expense (before the backdate window) goes to the owner when anyone else changes it (A§7).
  const askReason = !can(user, "approvals", "approve") && (await needsBackdateApproval(e.date));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/expenses/${id}`, label: e.number }}
        title={`Edit ${e.number}`}
        description="A change to the date, category, job, amount or account reverses the entry and posts it again."
      />
      <ExpenseForm
        values={{
          date: e.date,
          categoryId: String(e.categoryId),
          vendorId: e.vendorId === null ? "" : String(e.vendorId),
          jobId: e.jobId === null ? "" : String(e.jobId),
          amount: moneyText(e.amountPaise),
          mode: e.mode,
          moneyAccountId: String(e.moneyAccountId),
          notes: e.notes ?? "",
        }}
        options={options}
        askReason={askReason}
        submitLabel={askReason ? "Ask the owner" : "Save changes"}
        back={`/expenses/${id}`}
        action={updateExpenseAction.bind(null, id)}
      />
    </div>
  );
}
