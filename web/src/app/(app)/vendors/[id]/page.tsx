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
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { stateName } from "@/lib/gstin";
import { can } from "@/lib/permissions";
import { getVendor, vendorOverview } from "@/lib/vendors";

const LABELS = {
  name: "Name",
  gstin: "GSTIN",
  state_code: "State",
  mobile: "Mobile",
  address: "Address",
  credit_days: "Credit days",
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

export default async function VendorPage({ params }: PageProps<"/vendors/[id]">) {
  const user = await requirePermission("vendors", "view");
  const id = Number((await params).id);
  const v = Number.isSafeInteger(id) ? await getVendor(id) : undefined;
  if (!v) notFound();
  const [overview, files] = await Promise.all([vendorOverview(id), listAttachments("vendor", id)]);
  const tiles = [
    { label: "Total billed", value: <Money paise={overview.billed} /> },
    { label: "Paid", value: <Money paise={overview.paid} /> },
    { label: "We owe", value: <Money paise={overview.outstanding} /> },
    { label: "Last payment", value: overview.lastPaymentDate ? <DateText date={overview.lastPaymentDate} /> : "—" },
  ];

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/vendors", label: "Vendors" }}
        title={v.name}
        description={[v.mobile, !v.active && "inactive"].filter(Boolean).join(" · ") || undefined}
        action={
          can(user, "vendors", "edit") && (
            <Button asChild variant="outline">
              <Link href={`/vendors/${id}/edit`}>Edit</Link>
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
            <Detail label="GSTIN">{v.gstin ?? "Unregistered"}</Detail>
            <Detail label="State">{`${v.stateCode} · ${stateName(v.stateCode) ?? ""}`}</Detail>
            <Detail label="Mobile">{v.mobile}</Detail>
            <Detail label="Address">{v.address}</Detail>
            <Detail label="Credit days">{v.creditDays === null ? null : `${v.creditDays} days`}</Detail>
            <Detail label="Opening balance (+ = we owe)">
              <Money paise={v.openingBalancePaise} />
            </Detail>
            <Detail label="Notes">{v.notes}</Detail>
          </dl>
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel entityType="vendor" entityId={id} items={files} canUpload={can(user, "vendors", "edit")} />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="vendors"
            rowId={id}
            labels={LABELS}
            hide={["created_by"]}
            display={{ state_code: (value) => `${value} · ${stateName(String(value)) ?? ""}` }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
