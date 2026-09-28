import { AttachmentsPanel, ImageField } from "@/components/attachments";
import { FormSection } from "@/components/form";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { moneyAccounts } from "@/lib/ledger";
import { moneyText } from "@/lib/num";
import { can } from "@/lib/permissions";
import { getSettings, percentText } from "@/lib/settings";
import { saveBooksAction, saveSettingsAction, setImageAction } from "./actions";
import { BooksForm } from "./books-form";
import { SettingsForm } from "./settings-form";

const LABELS = {
  company_name: "Company name",
  address: "Address",
  gstin: "GSTIN",
  state_code: "State code",
  phone: "Phone",
  email: "Email",
  bank_details: "Bank details",
  upi_id: "UPI id",
  logo_attachment_id: "Logo",
  signature_attachment_id: "Signature",
  invoice_terms: "Invoice terms",
  discount_limit_bp: "Discount limit",
  backdate_days: "Backdate days",
  default_credit_days: "Default credit days",
  books_start_date: "Books start date",
};

export default async function SettingsPage() {
  const user = await requirePermission("settings", "view");
  const [settings, files, money] = await Promise.all([getSettings(), listAttachments("settings", 1), moneyAccounts()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Settings" description="Company details for documents, and the rules for approvals." />
      <Tabs defaultValue="details" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="books">Books</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="grid grid-cols-1 gap-4">
          <FormSection title="Logo and signature" description="Printed on invoices. Saved as soon as you upload.">
            <div className="flex flex-wrap gap-8">
              <ImageField
                label="Logo"
                attachmentId={settings.logoAttachmentId}
                entityType="settings"
                entityId={1}
                onChange={setImageAction.bind(null, "logo")}
              />
              <ImageField
                label="Signature"
                attachmentId={settings.signatureAttachmentId}
                entityType="settings"
                entityId={1}
                onChange={setImageAction.bind(null, "signature")}
              />
            </div>
          </FormSection>
          <SettingsForm
            settings={settings}
            discountLimit={percentText(settings.discountLimitBp)}
            action={saveSettingsAction}
          />
        </TabsContent>
        <TabsContent value="books">
          <BooksForm
            booksStartDate={settings.booksStartDate}
            accounts={money.map((a) => ({
              id: a.id,
              code: a.code,
              name: a.name,
              opening: a.openingBalancePaise ? moneyText(a.openingBalancePaise) : "",
            }))}
            action={saveBooksAction}
          />
        </TabsContent>
        <TabsContent value="attachments">
          <AttachmentsPanel entityType="settings" entityId={1} items={files} canUpload={can(user, "settings", "edit")} />
        </TabsContent>
        <TabsContent value="history">
          <History table="settings" rowId={1} labels={LABELS} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
