import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { accounts, expenseCategories, jobs, vendors } from "@/db/schema";
import { needsBackdateApproval } from "@/lib/approvals";
import { canAttach, listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { getExpense } from "@/lib/expenses";
import { can } from "@/lib/permissions";
import { RECEIPT_MODE, type ReceiptMode } from "@/lib/receipt-modes";
import { cancelExpenseAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  category_id: "Category",
  vendor_id: "Vendor",
  job_id: "Job",
  amount_paise: "Amount",
  mode: "Mode",
  money_account_id: "Paid from",
  notes: "Notes",
  status: "Status",
};

export default async function ExpensePage({ params }: PageProps<"/expenses/[id]">) {
  const user = await requirePermission("books", "view");
  const id = Number((await params).id);
  const e = Number.isSafeInteger(id) ? await getExpense(id) : undefined;
  if (!e) notFound();
  const [files, names, needsOwner] = await Promise.all([
    listAttachments("expense", id),
    Promise.all([
      db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories),
      db.select({ id: vendors.id, name: vendors.name }).from(vendors),
      db.select({ id: jobs.id, name: jobs.number }).from(jobs),
      db.select({ id: accounts.id, name: accounts.name }).from(accounts),
    ]),
    needsBackdateApproval(e.date),
  ]);
  const [categories, vendorNames, jobNames, money] = names;
  const named = (list: { id: number; name: string }[]) => (v: unknown) => list.find((x) => x.id === v)?.name ?? String(v);
  const active = e.status === "active";
  const isOwner = can(user, "approvals", "approve");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/expenses", label: "Expenses" }}
        title={e.number}
        status={active ? undefined : "Cancelled"}
        description={`${e.category} · ${RECEIPT_MODE[e.mode]}`}
      />
      {active && (
        <div className="flex flex-wrap gap-2">
          {can(user, "books", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/expenses/${id}/edit`}>Edit</Link>
            </Button>
          )}
          {can(user, "books", "cancel") && (
            <ActionDialog
              action={cancelExpenseAction.bind(null, id)}
              label="Cancel"
              title={`Cancel ${e.number}?`}
              description={
                <>
                  The entry is reversed on the expense date ({formatDate(e.date)}); the number stays.
                  {!isOwner && needsOwner && " It is before the backdate window, so this goes to the owner for approval."}
                </>
              }
              confirmLabel="Cancel expense"
              done="Cancelled."
              reason
              variant="destructive"
            />
          )}
        </div>
      )}

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="attachments">Bill photo ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={e.date} />],
              ["Category", e.category],
              ["Amount", <Money key="a" paise={e.amountPaise} />],
              ["Paid from", `${e.account} (${RECEIPT_MODE[e.mode]})`],
              [
                "Vendor",
                e.vendor && can(user, "vendors", "view") ? (
                  <Link key="v" href={`/vendors/${e.vendorId}`} className="text-primary hover:underline">
                    {e.vendor}
                  </Link>
                ) : (
                  e.vendor
                ),
              ],
              [
                "Job",
                e.job && can(user, "jobs", "view") ? (
                  <Link key="j" href={`/jobs/${e.jobId}`} className="text-primary hover:underline">
                    {e.job}
                  </Link>
                ) : (
                  e.job
                ),
              ],
              ["Notes", e.notes],
            ]}
          />
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="expense"
            entityId={id}
            items={files}
            canUpload={canAttach(user, "expense", "edit")}
            defaultKind="purchase_bill_photo"
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="expenses"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              category_id: named(categories),
              vendor_id: named(vendorNames),
              job_id: named(jobNames),
              money_account_id: named(money),
              mode: (v) => RECEIPT_MODE[v as ReceiptMode] ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
