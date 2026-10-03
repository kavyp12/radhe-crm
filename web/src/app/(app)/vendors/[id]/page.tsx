import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { EmailDialog, WhatsAppButton } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { EmptyState } from "@/components/empty-state";
import { db } from "@/db";
import { History } from "@/components/history";
import { OpeningBills } from "@/components/opening-bills";
import { cancelOpeningBillAction } from "@/app/(app)/settings/actions";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { stateName } from "@/lib/gstin";
import { formatMoney } from "@/lib/num";
import { can, canViewCost } from "@/lib/permissions";
import { listPurchaseBills } from "@/lib/purchase-bills";
import { getSettings } from "@/lib/settings";
import { drCr, entryLabel, LEDGER_PERIODS, rangeText, readRange, statementMessage, vendorLedger } from "@/lib/statements";
import { vendorOnAccount, vendorOpeningBills } from "@/lib/vendor-payments";
import { getVendor, vendorOverview } from "@/lib/vendors";
import { LedgerFilter } from "../../customers/[id]/ledger-filter";
import { emailVendorStatementAction, vendorStatementShareAction } from "../actions";

const LABELS = {
  name: "Name",
  gstin: "GSTIN",
  state_code: "State",
  mobile: "Mobile",
  email: "Email",
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

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

export default async function VendorPage({ params, searchParams }: PageProps<"/vendors/[id]">) {
  const user = await requirePermission("vendors", "view");
  const id = Number((await params).id);
  const v = Number.isSafeInteger(id) ? await getVendor(id) : undefined;
  if (!v) notFound();
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const { period, range, error: rangeError } = readRange(text("period") || undefined, text("from"), text("to"));
  // Bills show purchase amounts per bill: only for can_view_cost users (D51).
  const bills = can(user, "books", "view") && canViewCost(user);
  const canApply = can(user, "payments", "create");
  const [overview, files, ledger, billRows, settings, onAccount, openingBills] = await Promise.all([
    vendorOverview(id),
    listAttachments("vendor", id),
    vendorLedger(id, range),
    bills ? listPurchaseBills(id) : [],
    getSettings(),
    canApply ? vendorOnAccount(db, id) : [],
    vendorOpeningBills(id),
  ]);
  const tiles = [
    { label: "Total billed", value: <Money paise={overview.billed} /> },
    { label: "Paid", value: <Money paise={overview.paid} /> },
    { label: "We owe", value: <Money paise={overview.outstanding} /> },
    { label: "Last payment", value: overview.lastPaymentDate ? <DateText date={overview.lastPaymentDate} /> : "—" },
  ];
  const tab = ["bills", "ledger", "attachments", "history"].includes(text("tab")) ? text("tab") : "overview";
  const rangeQuery = new URLSearchParams({ period, from: text("from"), to: text("to") }).toString();
  const docHref = (docType: string, docId: number) =>
    docType === "purchase_bills" && bills
      ? `/purchase-bills/${docId}`
      : docType === "vendor_payments" && can(user, "payments", "view")
        ? `/vendor-payments/${docId}`
        : docType === "adjustments" && can(user, "books", "view")
          ? `/journal-vouchers/${docId}`
          : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/vendors", label: "Vendors" }}
        title={v.name}
        description={[v.mobile, !v.active && "inactive"].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex flex-wrap gap-2">
            {v.active && can(user, "payments", "create") && (
              <Button asChild variant="outline">
                <Link href={`/vendor-payments/new?vendor=${id}`}>New payment</Link>
              </Button>
            )}
            {v.active && bills && can(user, "books", "create") && (
              <Button asChild variant="outline">
                <Link href={`/purchase-bills/new?vendor=${id}`}>New bill</Link>
              </Button>
            )}
            {can(user, "vendors", "edit") && (
              <Button asChild variant="outline">
                <Link href={`/vendors/${id}/edit`}>Edit</Link>
              </Button>
            )}
          </div>
        }
      />
      <Tabs defaultValue={tab} className="gap-4">
        <TabsList variant="line" className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {bills && <TabsTrigger value="bills">Bills ({billRows.length})</TabsTrigger>}
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
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
          {onAccount.length > 0 && (
            <section aria-label="On account" className="overflow-x-auto rounded-lg border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-medium">On account</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Paid but not on any bill yet. Apply it to open bills.</p>
              </div>
              <table className="w-full min-w-120 border-separate border-spacing-0 text-[13px]">
                <tbody>
                  {onAccount.map((p) => (
                    <tr key={p.id}>
                      <td className={td}>
                        <Link href={`/vendor-payments/${p.id}`} className="text-primary hover:underline">
                          <DocNumber number={p.number} />
                        </Link>
                      </td>
                      <td className={td}>
                        <DateText date={p.date} />
                      </td>
                      <td className={td}>Payment, not allocated</td>
                      <td className={`${td} text-right`}>
                        <Money paise={p.rest} />
                      </td>
                      <td className={`${td} w-24 text-right`}>
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/vendors/${id}/apply?payment=${p.id}`}>Apply</Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <dl className="grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="GSTIN">{v.gstin ?? "Unregistered"}</Detail>
            <Detail label="State">{`${v.stateCode} · ${stateName(v.stateCode) ?? ""}`}</Detail>
            <Detail label="Mobile">{v.mobile}</Detail>
            <Detail label="Email">{v.email}</Detail>
            <Detail label="Address">{v.address}</Detail>
            <Detail label="Credit days">{v.creditDays === null ? null : `${v.creditDays} days`}</Detail>
            <Detail label="Opening balance (+ = we owe)">
              <Money paise={v.openingBalancePaise} />
            </Detail>
            <Detail label="Notes">{v.notes}</Detail>
          </dl>
        </TabsContent>

        {bills && (
          <TabsContent value="bills">
            {billRows.length === 0 ? (
              <div className="rounded-lg border bg-card">
                <EmptyState title="No bills from this vendor yet." />
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr>
                      <th className={th}>Bill</th>
                      <th className={th}>Vendor bill no</th>
                      <th className={th}>Date</th>
                      <th className={th}>Due</th>
                      <th className={th}>Payment</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} text-right`}>Paid</th>
                      <th className={`${th} text-right`}>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billRows.map((b) => (
                      <tr key={b.id}>
                        <td className={td}>
                          <Link href={`/purchase-bills/${b.id}`} className="text-primary hover:underline">
                            <DocNumber number={b.number} status={b.payment} />
                          </Link>
                        </td>
                        <td className={td}>{b.vendorBillNo}</td>
                        <td className={td}>
                          <DateText date={b.date} />
                        </td>
                        <td className={td}>
                          <DateText date={b.dueDate} />
                        </td>
                        <td className={td}>
                          <StatusBadge status={b.payment} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={b.total} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={b.paid} />
                        </td>
                        <td className={`${td} text-right`}>
                          <Money paise={b.open} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        )}

        <TabsContent value="ledger" className="grid grid-cols-1 gap-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <LedgerFilter action={`/vendors/${id}`} periods={Object.entries(LEDGER_PERIODS)} period={period} from={range.from} to={range.to} />
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <a href={`/vendors/${id}/statement?${rangeQuery}`} target="_blank" rel="noopener">
                  PDF / Print
                </a>
              </Button>
              <WhatsAppButton share={vendorStatementShareAction.bind(null, id, period, text("from"), text("to"))} />
              <EmailDialog
                action={emailVendorStatementAction.bind(null, id, period, text("from"), text("to"))}
                to={v.email ?? ""}
                subject={`Statement of account${settings.companyName ? ` from ${settings.companyName}` : ""}`}
                message={statementMessage({ name: v.name, range, closing: ledger.closing, company: settings.companyName })}
              />
            </div>
          </div>
          {rangeError && (
            <p role="alert" className="text-sm text-destructive">
              {rangeError} Showing all entries.
            </p>
          )}
          <DocFacts
            facts={[
              ["Period", rangeText(range)],
              ["Brought forward", drCr(ledger.opening)],
              ["Debit / Credit", `${formatMoney(ledger.debit)} / ${formatMoney(ledger.credit)}`],
              ["Closing balance", `${drCr(ledger.closing)}${ledger.closing < 0n ? " (we owe)" : ""}`],
            ]}
          />
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-160 border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Document</th>
                  <th className={th}>Particulars</th>
                  <th className={`${th} text-right`}>Debit</th>
                  <th className={`${th} text-right`}>Credit</th>
                  <th className={`${th} text-right`}>Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="font-medium">
                  <td className={td}>{range.from && <DateText date={range.from} />}</td>
                  <td className={td} />
                  <td className={td}>Brought forward</td>
                  <td className={td} />
                  <td className={td} />
                  <td className={`${td} text-right tabular-nums`}>{drCr(ledger.opening)}</td>
                </tr>
                {ledger.rows.map((r, i) => {
                  const href = docHref(r.docType, r.docId);
                  return (
                    <tr key={i}>
                      <td className={td}>
                        <DateText date={r.date} />
                      </td>
                      <td className={td}>
                        {r.number && href ? (
                          <Link href={href} className="text-primary hover:underline">
                            <DocNumber number={r.number} />
                          </Link>
                        ) : (
                          (r.number ?? "")
                        )}
                      </td>
                      <td className={td}>{entryLabel(r)}</td>
                      <td className={`${td} text-right`}>{r.debit ? <Money paise={r.debit} /> : null}</td>
                      <td className={`${td} text-right`}>{r.credit ? <Money paise={r.credit} /> : null}</td>
                      <td className={`${td} text-right tabular-nums`}>{drCr(r.balance)}</td>
                    </tr>
                  );
                })}
                <tr className="font-medium">
                  <td className={td} />
                  <td className={td} />
                  <td className={td}>Closing balance</td>
                  <td className={`${td} text-right`}>
                    <Money paise={ledger.debit} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Money paise={ledger.credit} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{drCr(ledger.closing)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Cr = we owe the vendor; Dr = they owe us or hold our advance.</p>
        </TabsContent>

        <TabsContent value="attachments">
          <AttachmentsPanel entityType="vendor" entityId={id} items={files} canUpload={can(user, "vendors", "edit")} />
        </TabsContent>

        <TabsContent value="history" className="grid grid-cols-1 gap-4">
          <OpeningBills rows={openingBills} cancel={can(user, "settings", "edit") ? cancelOpeningBillAction : undefined} />
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
