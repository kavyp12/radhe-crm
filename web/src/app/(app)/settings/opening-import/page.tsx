import Link from "next/link";
import { FormSection } from "@/components/form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { canViewCost } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { ImportForm } from "./import-form";

/** Settings → Data → Import opening data (T43, D67): the owner's; needs the books start date. */
export default async function OpeningImportPage() {
  const user = await requirePermission("settings", "edit");
  const { booksStartDate } = await getSettings();

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Import opening data"
        description="Customers, vendors, their unpaid old bills, stock in hand and cash / bank balances on the books start date — from one Excel file."
      />
      {!booksStartDate ? (
        <p className="rounded-lg border bg-card p-4 text-sm">
          Set the books start date first (Settings → Books): every opening balance is posted on it.{" "}
          <Link href="/settings" className="text-primary hover:underline">
            Open Settings
          </Link>
        </p>
      ) : !canViewCost(user) ? (
        <p className="rounded-lg border bg-card p-4 text-sm">
          Opening stock is valued: turn on &ldquo;Can see cost, profit and purchase rates&rdquo; for your user first.
        </p>
      ) : (
        <>
          <FormSection
            title="1. Fill the template"
            description={`Everything as it stood on the books start date, ${formatDate(booksStartDate)}. Its "Read me" sheet explains every column.`}
          >
            <Button asChild variant="outline" className="w-fit">
              <a href="/settings/opening-import/template" download>
                Download the template (Excel)
              </a>
            </Button>
          </FormSection>
          <ImportForm />
        </>
      )}
    </div>
  );
}
