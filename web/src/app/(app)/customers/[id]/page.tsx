import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { customerOverview, getCustomer } from "@/lib/customers";
import { stateName } from "@/lib/gstin";
import { can } from "@/lib/permissions";

const LABELS = {
  name: "Name",
  firm_name: "Firm name",
  mobile: "Mobile",
  gstin: "GSTIN",
  state_code: "State",
  billing_address: "Billing address",
  site_address: "Site address",
  credit_limit_paise: "Credit limit",
  credit_days: "Credit days",
  is_credit_customer: "Credit customer",
  sales_person_id: "Sales person",
  collection_person_id: "Collection person",
  opening_balance_paise: "Opening balance",
  active: "Active",
  notes: "Notes",
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word whitespace-pre-line">{children || "—"}</dd>
    </div>
  );
}

export default async function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  const user = await requirePermission("customers", "view");
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) ? await getCustomer(id) : undefined;
  if (!c) notFound();
  const [overview, files, people] = await Promise.all([
    customerOverview(id),
    listAttachments("customer", id),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const personName = (v: unknown) => people.find((p) => p.id === v)?.name ?? String(v);
  const tiles = [
    { label: "Total business", value: <Money paise={overview.business} /> },
    { label: "Received", value: <Money paise={overview.received} /> },
    { label: "Outstanding", value: <Money paise={overview.outstanding} drcr /> },
    { label: "Last payment", value: overview.lastPaymentDate ? <DateText date={overview.lastPaymentDate} /> : "—" },
  ];

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/customers", label: "Customers" }}
        title={c.name}
        description={[c.firmName, c.mobile, !c.active && "inactive"].filter(Boolean).join(" · ") || undefined}
        action={
          can(user, "customers", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/customers/${id}/edit`}>Edit</Link>
            </Button>
          )
        }
      />
      <Tabs defaultValue="overview" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid grid-cols-1 gap-4">
          <section
            aria-label="Totals"
            className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4"
          >
            {tiles.map((t) => (
              <div key={t.label} className="bg-card px-4 py-3.5">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="mt-1 text-lg leading-7 font-medium tracking-tight tabular-nums sm:text-xl">{t.value}</p>
              </div>
            ))}
          </section>
          <dl className="grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="GSTIN">{c.gstin ?? "Unregistered"}</Detail>
            <Detail label="State">{`${c.stateCode} · ${stateName(c.stateCode) ?? ""}`}</Detail>
            <Detail label="Mobile">{c.mobile}</Detail>
            <Detail label="Billing address">{c.billingAddress}</Detail>
            <Detail label="Delivery / site address">{c.siteAddress}</Detail>
            <Detail label="Credit limit">{c.creditLimitPaise === null ? "No limit" : <Money paise={c.creditLimitPaise} />}</Detail>
            <Detail label="Credit days">{c.creditDays === null ? null : `${c.creditDays} days`}</Detail>
            <Detail label="Credit customer">{c.isCreditCustomer ? "Yes" : "No"}</Detail>
            <Detail label="Sales person">{c.salesPerson}</Detail>
            <Detail label="Collection person">{c.collectionPerson}</Detail>
            <Detail label="Opening balance">
              <Money paise={c.openingBalancePaise} drcr />
            </Detail>
            <Detail label="Notes">{c.notes}</Detail>
          </dl>
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="customer"
            entityId={id}
            items={files}
            canUpload={can(user, "customers", "edit")}
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="customers"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{
              sales_person_id: personName,
              collection_person_id: personName,
              state_code: (v) => `${v} · ${stateName(String(v)) ?? ""}`,
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
