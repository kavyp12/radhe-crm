import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { ActionButton, ActionDialog } from "@/components/doc-actions";
import { DocLines } from "@/components/doc-lines";
import { DocFacts, DocShare } from "@/components/doc-share";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { listAttachments } from "@/lib/attachments";
import { liveJobFor } from "@/lib/jobs";
import { requirePermission } from "@/lib/auth";
import { stateName } from "@/lib/gstin";
import { can } from "@/lib/permissions";
import { getQuotation, QUOTATION_STATUS, type QuotationStatus } from "@/lib/quotations";
import { getSettings } from "@/lib/settings";
import { shareMessage, shareUrl, whatsappLink } from "@/lib/share";
import {
  approveQuotationAction,
  cancelQuotationAction,
  duplicateQuotationAction,
  emailQuotationAction,
  sendQuotationAction,
} from "../actions";

const LABELS = {
  number: "Number",
  date: "Date",
  customer_id: "Customer",
  place_of_supply: "Place of supply",
  status: "Status",
  total_paise: "Total",
  terms: "Terms",
  notes: "Notes",
};

export default async function QuotationPage({ params }: PageProps<"/quotations/[id]">) {
  const user = await requirePermission("quotations", "view");
  const id = Number((await params).id);
  const q = Number.isSafeInteger(id) ? await getQuotation(id) : undefined;
  if (!q) notFound();
  const [files, settings, names, job] = await Promise.all([
    listAttachments("quotation", id),
    getSettings(),
    db.select({ id: customers.id, name: customers.name }).from(customers),
    liveJobFor(db, id),
  ]);
  const c = q.customer;
  const edit = can(user, "quotations", "edit");
  const shared = q.status !== "draft";
  const message = shareMessage({
    what: "our quotation",
    number: q.number,
    name: c.name,
    total: q.totalPaise,
    link: shareUrl(q.shareToken),
    company: settings.companyName,
  });

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/quotations", label: "Quotations" }}
        title={q.number}
        status={QUOTATION_STATUS[q.status]}
        description={c.firmName ? `${c.name} · ${c.firmName}` : c.name}
      />
      <div className="flex flex-wrap gap-2">
        <DocShare
          pdfHref={`/quotations/${id}/pdf`}
          whatsapp={shared ? whatsappLink(c.mobile, message) : undefined}
          email={
            shared
              ? {
                  action: emailQuotationAction.bind(null, id),
                  to: c.email ?? "",
                  subject: `Quotation ${q.number}${settings.companyName ? ` from ${settings.companyName}` : ""}`,
                  message,
                }
              : undefined
          }
        />
        {job && can(user, "jobs", "view") && (
          <Button asChild variant="outline">
            <Link href={`/jobs/${job.id}`}>Job {job.number}</Link>
          </Button>
        )}
        {!job && q.status === "approved" && can(user, "jobs", "create") && (
          <Button asChild>
            <Link href={`/jobs/new?quotation=${id}`}>Create job</Link>
          </Button>
        )}
        {edit && (q.status === "draft" || q.status === "sent") && (
          <Button asChild variant="outline">
            <Link href={`/quotations/${id}/edit`}>Edit</Link>
          </Button>
        )}
        {can(user, "quotations", "create") && (
          <ActionButton action={duplicateQuotationAction.bind(null, id)} label="Duplicate" done="Duplicated." />
        )}
        {can(user, "quotations", "cancel") && q.status !== "cancelled" && (
          <ActionDialog
            action={cancelQuotationAction.bind(null, id)}
            label="Cancel"
            title={`Cancel ${q.number}?`}
            description="It stays on record, marked Cancelled. This can't be undone."
            confirmLabel="Cancel quotation"
            done="Quotation cancelled."
            variant="destructive"
          />
        )}
        {edit && q.status === "draft" && (
          <ActionButton action={sendQuotationAction.bind(null, id)} label="Mark as sent" done="Marked as sent." variant="default" />
        )}
        {edit && q.status === "sent" && (
          <ActionButton
            action={approveQuotationAction.bind(null, id)}
            label="Customer approved"
            done="Marked approved."
            variant="default"
          />
        )}
      </div>

      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <DocFacts
            facts={[
              ["Date", <DateText key="d" date={q.date} />],
              ["Customer", c.firmName ? `${c.name}\n${c.firmName}` : c.name],
              ["GSTIN", c.gstin ?? "Unregistered"],
              ["State", `${q.placeOfSupply} · ${stateName(q.placeOfSupply) ?? ""}`],
              ["Billing address", c.billingAddress],
              ["Mobile", c.mobile],
              ["Terms", q.terms],
              ["Notes", q.notes],
            ]}
          />
          <DocLines lines={q.lines} totals={q.totals} mode={q.mode} />
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel
            entityType="quotation"
            entityId={id}
            items={files}
            canUpload={edit}
            defaultKind="quotation"
          />
        </TabsContent>

        <TabsContent value="history">
          <History
            table="quotations"
            rowId={id}
            labels={LABELS}
            hide={["created_by", "share_token"]}
            display={{
              customer_id: (v) => names.find((n) => n.id === v)?.name ?? String(v),
              status: (v) => QUOTATION_STATUS[v as QuotationStatus] ?? String(v),
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
