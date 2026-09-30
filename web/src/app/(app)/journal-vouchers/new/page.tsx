import { PageHeader } from "@/components/page-header";
import { journalFormOptions } from "@/lib/adjustments";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { createAdjustmentAction } from "../actions";
import { JournalForm } from "../journal-form";

export default async function NewJournalVoucherPage() {
  const user = await requirePermission("books", "create");
  const options = await journalFormOptions();
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/journal-vouchers", label: "Journal vouchers" }} title="New journal voucher" />
      <JournalForm options={options} today={todayIST()} owner={can(user, "approvals", "approve")} action={createAdjustmentAction} />
    </div>
  );
}
