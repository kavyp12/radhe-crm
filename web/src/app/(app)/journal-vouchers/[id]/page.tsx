import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { ADJUSTMENT_KIND, getAdjustment, type AdjustmentKind } from "@/lib/adjustments";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { cancelAdjustmentAction } from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  kind: "Kind",
  customer_id: "Customer",
  narration: "Narration",
  amount_paise: "Amount",
  status: "Status",
};

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2";

export default async function JournalVoucherPage({ params }: PageProps<"/journal-vouchers/[id]">) {
  const user = await requirePermission("books", "view");
  const id = Number((await params).id);
  const a = Number.isSafeInteger(id) ? await getAdjustment(id) : undefined;
  if (!a) notFound();
  const names = await db.select({ id: customers.id, name: customers.name }).from(customers);
  const active = a.status === "active";
  const isOwner = can(user, "approvals", "approve");
  const link = (href: string, text: string, allowed: boolean) =>
    allowed ? (
      <Link href={href} className="text-primary hover:underline">
        {text}
      </Link>
    ) : (
      text
    );
  const settles = a.kind === "write_off" || a.kind === "discount";
  const after = { journal: "", write_off: " The invoices it settled are open again.", discount: " The invoices it settled are open again.", refund: " The money it paid back is on account again." };

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/journal-vouchers", label: "Journal vouchers" }}
        title={a.number}
        status={active ? undefined : "Cancelled"}
        description={[ADJUSTMENT_KIND[a.kind], a.customer].filter(Boolean).join(" · ")}
      />
      {active && can(user, "books", "cancel") && (
        <div className="flex flex-wrap gap-2">
          <ActionDialog
            action={cancelAdjustmentAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${a.number}?`}
            description={
              <>
                The entry is reversed on the JV date ({formatDate(a.date)}); the number stays.{after[a.kind]}
                {!isOwner && " This goes to the owner for approval."}
              </>
            }
            confirmLabel="Cancel JV"
            done="Cancelled."
            reason
            variant="destructive"
          />
        </div>
      )}

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={a.date} />],
              ["Kind", ADJUSTMENT_KIND[a.kind]],
              ["Customer", a.customer && a.customerId ? link(`/customers/${a.customerId}`, a.customer, can(user, "customers", "view")) : null],
              ["Amount", <Money key="a" paise={a.amountPaise} />],
              ["Narration", a.narration],
              ["Entered by", a.createdByName],
            ]}
          />

          <section className="overflow-x-auto rounded-lg border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-medium">Entry</h2>
            <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Account</th>
                  <th className={th}>Customer, vendor or job</th>
                  <th className={`${th} text-right`}>Debit</th>
                  <th className={`${th} text-right`}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((l) => (
                  <tr key={l.id}>
                    <td className={td}>
                      <span className="text-muted-foreground tabular-nums">{l.code}</span> {l.account}
                    </td>
                    <td className={td}>
                      {l.customer && l.customerId && link(`/customers/${l.customerId}`, l.customer, can(user, "customers", "view"))}
                      {l.vendor && l.vendorId && link(`/vendors/${l.vendorId}`, l.vendor, can(user, "vendors", "view"))}
                      {l.job && l.jobId && link(`/jobs/${l.jobId}`, l.job, can(user, "jobs", "view"))}
                    </td>
                    <td className={`${td} text-right`}>{l.debit ? <Money paise={l.debit} /> : null}</td>
                    <td className={`${td} text-right`}>{l.credit ? <Money paise={l.credit} /> : null}</td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className={td} colSpan={2}>
                    Total
                  </td>
                  <td className={`${td} text-right`}>
                    <Money paise={a.amountPaise} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Money paise={a.amountPaise} />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          {a.allocated.length > 0 && (
            <section className="overflow-x-auto rounded-lg border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-medium">{settles ? "Settles" : "Pays back"}</h2>
              <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Document</th>
                    <th className={th}>Date</th>
                    <th className={`${th} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {a.allocated.map((l) => (
                    <tr key={l.id} className={l.active ? undefined : "text-muted-foreground"}>
                      <td className={td}>
                        {l.what}{" "}
                        <span className={l.active ? "font-medium tabular-nums" : "tabular-nums line-through"}>
                          {link(l.href, l.number, can(user, l.what === "Receipt" ? "payments" : "invoices", "view"))}
                        </span>
                        {!l.active && (
                          <>
                            {" "}
                            · removed <DateText at={l.changedAt} />
                          </>
                        )}
                      </td>
                      <td className={td}>
                        <DateText date={l.date} />
                      </td>
                      <td className={`${td} text-right${l.active ? "" : " line-through"}`}>
                        <Money paise={l.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </TabsContent>

        <TabsContent value="history">
          <History
            table="adjustments"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              customer_id: (v) => names.find((c) => c.id === v)?.name ?? String(v),
              kind: (v) => ADJUSTMENT_KIND[v as AdjustmentKind] ?? String(v),
              status: (v) => (v === "cancelled" ? "Cancelled" : "Active"),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
