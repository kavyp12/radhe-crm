import { Copy, Printer, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { DateInput } from "@/components/date-input";
import { DateText } from "@/components/date-text";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber, StatusBadge, STATUSES } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { KitForm, KitTable, KitToasts } from "./kit-demo";

// Every shared component with sample data, for the look check. Owner only (same gate as Settings).
export default async function KitPage() {
  await requirePermission("settings");
  const today = todayIST();

  return (
    <div className="grid grid-cols-1 gap-8">
      <PageHeader
        back={{ href: "/", label: "Dashboard" }}
        title="UI kit"
        description="Every shared component with sample data."
        status="Draft"
        action={<Button>Primary action</Button>}
        menu={
          <>
            <DropdownMenuItem>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Printer />
              Print
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <XCircle />
              Cancel document
            </DropdownMenuItem>
          </>
        }
      />

      <Section title="Status badges">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <DocNumber number="RDS/26-27/0142" status="Paid" /> <StatusBadge status="Paid" />
          </span>
          <span className="inline-flex items-center gap-2">
            <DocNumber number="RDS/26-27/0137" status="Cancelled" /> <StatusBadge status="Cancelled" />
          </span>
        </p>
      </Section>

      <Section title="Money and dates">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <Sample label="Amount">
            <Money paise={12_345_678_90n} />
          </Sample>
          <Sample label="Negative">
            <Money paise={-1_500_00n} />
          </Sample>
          <Sample label="Ledger debit">
            <Money paise={48_500_00n} drcr />
          </Sample>
          <Sample label="Ledger credit">
            <Money paise={-12_000_50n} drcr />
          </Sample>
          <Sample label="Date">
            <DateText date={today} />
          </Sample>
          <Sample label="Date and time">
            <DateText at={new Date("2026-09-28T10:15:00Z")} />
          </Sample>
        </dl>
      </Section>

      <Section title="Inputs and buttons">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Label className="grid gap-1.5">
            Text
            <Input placeholder="Customer name" />
          </Label>
          <Label className="grid gap-1.5">
            Date (DD/MM/YYYY)
            <DateInput defaultValue={today} />
          </Label>
          <Label className="grid gap-1.5">
            Select
            <NativeSelect className="w-full" defaultValue="upi">
              <NativeSelectOption value="cash">Cash</NativeSelectOption>
              <NativeSelectOption value="upi">UPI</NativeSelectOption>
              <NativeSelectOption value="bank">Bank</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label className="grid gap-1.5">
            Disabled
            <Input disabled defaultValue="Locked after issue" />
          </Label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button>Save</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Cancel invoice</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Data table" description="Sort by any column; filter by text, date and status; totals cover every filtered row.">
        <KitTable today={today} />
      </Section>

      <Section title="Form" description="Sample invoice: Tab moves between cells, Enter adds a line, totals update as you type.">
        <KitForm today={today} />
      </Section>

      <Section title="Empty, loading and toasts">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card">
            <EmptyState title="No receipts yet." action={<Button size="sm">New receipt</Button>} />
          </div>
          <div className="grid content-start gap-3 rounded-lg border bg-card p-4" aria-label="Loading example">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
        <div className="mt-4">
          <KitToasts />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-3">
      <div>
        <h2 className="text-base font-medium">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
