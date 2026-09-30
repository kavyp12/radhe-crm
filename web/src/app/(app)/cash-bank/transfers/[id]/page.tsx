import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { needsBackdateApproval } from "@/lib/approvals";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { getTransfer } from "@/lib/transfers";
import { cancelTransferAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  from_account_id: "From",
  to_account_id: "To",
  amount_paise: "Amount",
  reference: "Reference",
  notes: "Notes",
  status: "Status",
};

export default async function TransferPage({ params }: PageProps<"/cash-bank/transfers/[id]">) {
  const user = await requirePermission("books", "view");
  const id = Number((await params).id);
  const t = Number.isSafeInteger(id) ? await getTransfer(id) : undefined;
  if (!t) notFound();
  const [money, needsOwner] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.name }).from(accounts),
    needsBackdateApproval(t.date),
  ]);
  const named = (v: unknown) => money.find((a) => a.id === v)?.name ?? String(v);
  const active = t.status === "active";
  const isOwner = can(user, "approvals", "approve");
  const book = (accountId: number, name: string) => (
    <Link href={`/cash-bank/accounts/${accountId}`} className="text-primary hover:underline">
      {name}
    </Link>
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/cash-bank/transfers", label: "Transfers" }}
        title={t.number}
        status={active ? undefined : "Cancelled"}
        description={`${t.from} → ${t.to}`}
      />
      {active && (
        <div className="flex flex-wrap gap-2">
          {can(user, "books", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/cash-bank/transfers/${id}/edit`}>Edit</Link>
            </Button>
          )}
          {can(user, "books", "cancel") && (
            <ActionDialog
              action={cancelTransferAction.bind(null, id)}
              label="Cancel"
              title={`Cancel ${t.number}?`}
              description={
                <>
                  The entry is reversed on the transfer date ({formatDate(t.date)}); the number stays.
                  {!isOwner && needsOwner && " It is before the backdate window, so this goes to the owner for approval."}
                </>
              }
              confirmLabel="Cancel transfer"
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
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={t.date} />],
              ["From", book(t.fromAccountId, t.from)],
              ["To", book(t.toAccountId, t.to)],
              ["Amount", <Money key="a" paise={t.amountPaise} />],
              ["Reference", t.reference],
              ["Notes", t.notes],
            ]}
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="transfers"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              from_account_id: named,
              to_account_id: named,
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
