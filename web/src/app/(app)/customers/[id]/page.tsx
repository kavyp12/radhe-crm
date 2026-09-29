import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AttachmentsPanel } from "@/components/attachments";
import { DateText } from "@/components/date-text";
import { EmailDialog, WhatsAppButton } from "@/components/doc-actions";
import { DocFacts } from "@/components/doc-share";
import { EmptyState } from "@/components/empty-state";
import { History } from "@/components/history";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { DocNumber, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { listAttachments } from "@/lib/attachments";
import { requirePermission } from "@/lib/auth";
import { customerAdvance, customerHistory, type Chain } from "@/lib/customer-history";
import { customerOverview, getCustomer } from "@/lib/customers";
import { stateName } from "@/lib/gstin";
import { formatMoney } from "@/lib/num";
import { can, type SessionUser } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { customerLedger, drCr, entryLabel, LEDGER_PERIODS, rangeText, readRange, statementMessage } from "@/lib/statements";
import { emailStatementAction, statementShareAction } from "../actions";
import { LedgerFilter } from "./ledger-filter";

const LABELS = {
  name: "Name",
  firm_name: "Firm name",
  mobile: "Mobile",
  email: "Email",
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

/** A document number, linked when this user may open it. */
function DocLink({ href, number, status, allowed }: { href: string; number: string; status?: Parameters<typeof DocNumber>[0]["status"]; allowed: boolean }) {
  return allowed ? (
    <Link href={href} className="text-primary hover:underline">
      <DocNumber number={number} status={status} />
    </Link>
  ) : (
    <DocNumber number={number} status={status} />
  );
}

/** Where a journal line's document lives. */
function docHref(docType: string, docId: number): string | null {
  if (docType === "invoices") return `/invoices/${docId}`;
  if (docType === "receipts") return `/receipts/${docId}`;
  return null;
}

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">{children}</dd>
    </div>
  );
}

function Timeline({ chains, user }: { chains: Chain[]; user: SessionUser }) {
  if (!chains.length) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState title="No quotations, jobs or invoices yet." />
      </div>
    );
  }
  const none = <span className="text-muted-foreground">—</span>;
  return (
    <ol className="grid gap-3">
      {chains.map((c) => (
        <li key={c.key} className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <StatusBadge status={c.label} />
            <span className="text-xs text-muted-foreground">
              <DateText date={c.date} />
            </span>
          </div>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <Step label="Quotation">
              {c.quotations.length
                ? c.quotations.map((q) => (
                    <DocLink key={q.id} href={`/quotations/${q.id}`} number={q.number} status={q.status} allowed={can(user, "quotations", "view")} />
                  ))
                : none}
            </Step>
            <Step label="Job">
              {c.jobs.length
                ? c.jobs.map((j) => (
                    <span key={j.id} className="inline-flex items-center gap-1.5">
                      <DocLink href={`/jobs/${j.id}`} number={j.number} status={j.status} allowed={can(user, "jobs", "view")} />
                      <span className="text-xs text-muted-foreground">{j.status}</span>
                    </span>
                  ))
                : none}
            </Step>
            <Step label="Invoice">
              {c.invoices.length
                ? c.invoices.map((i) => (
                    <span key={i.id} className="inline-flex items-center gap-1.5">
                      <DocLink href={`/invoices/${i.id}`} number={i.number} status={i.status} allowed={can(user, "invoices", "view")} />
                      <Money paise={i.total} className="text-xs text-muted-foreground" />
                    </span>
                  ))
                : none}
            </Step>
            <Step label="Payment">
              {c.payments.length
                ? c.payments.map((p) => (
                    <span key={p.receiptId} className="inline-flex items-center gap-1.5">
                      <DocLink href={`/receipts/${p.receiptId}`} number={p.number} allowed={can(user, "payments", "view")} />
                      <Money paise={p.amount} className="text-xs text-muted-foreground" />
                    </span>
                  ))
                : none}
            </Step>
            <Step label="Pending">{c.invoices.some((i) => i.status === "Issued") ? <Money paise={c.pending} /> : none}</Step>
          </dl>
        </li>
      ))}
    </ol>
  );
}

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

export default async function CustomerPage({ params, searchParams }: PageProps<"/customers/[id]">) {
  const user = await requirePermission("customers", "view");
  const id = Number((await params).id);
  const c = Number.isSafeInteger(id) ? await getCustomer(id) : undefined;
  if (!c) notFound();
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const money = can(user, "customers", "money");
  const { period, range, error: rangeError } = readRange(text("period") || undefined, text("from"), text("to"));

  const [overview, advance, files, people, chains, ledger, settings] = await Promise.all([
    customerOverview(id),
    customerAdvance(id),
    listAttachments("customer", id),
    db.select({ id: users.id, name: users.name }).from(users),
    customerHistory(id),
    money ? customerLedger(id, range) : null,
    getSettings(),
  ]);
  const personName = (v: unknown) => people.find((p) => p.id === v)?.name ?? String(v);
  const tiles = [
    { label: "Total business", value: <Money paise={overview.business} /> },
    { label: "Received", value: <Money paise={overview.received} /> },
    { label: "Outstanding", value: <Money paise={overview.outstanding} drcr /> },
    { label: "Last payment", value: overview.lastPaymentDate ? <DateText date={overview.lastPaymentDate} /> : "—" },
    {
      label: "Advance / on account",
      value: <Money paise={advance.onJobs + advance.onAccount} />,
      note: advance.onJobs ? `${formatMoney(advance.onJobs)} of it on jobs` : undefined,
    },
  ];
  const tab = ["history", "ledger", "attachments", "changes"].includes(text("tab")) ? text("tab") : "overview";
  const rangeQuery = new URLSearchParams({ period, from: text("from"), to: text("to") }).toString();

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/customers", label: "Customers" }}
        title={c.name}
        description={[c.firmName, c.mobile, !c.active && "inactive"].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex gap-2">
            {can(user, "payments", "create") && c.active && (
              <Button asChild variant="outline">
                <Link href={`/receipts/new?customer=${id}`}>New receipt</Link>
              </Button>
            )}
            {can(user, "customers", "edit") && (
              <Button asChild variant="outline">
                <Link href={`/customers/${id}/edit`}>Edit</Link>
              </Button>
            )}
          </div>
        }
      />
      <Tabs defaultValue={tab} className="gap-4">
        <TabsList variant="line" className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">History ({chains.length})</TabsTrigger>
          {money && <TabsTrigger value="ledger">Ledger</TabsTrigger>}
          <TabsTrigger value="attachments">Attachments ({files.length})</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid grid-cols-1 gap-4">
          <section
            aria-label="Totals"
            className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-5"
          >
            {tiles.map((t) => (
              <div key={t.label} className="bg-card px-4 py-3.5">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="mt-1 text-lg leading-7 font-medium tracking-tight tabular-nums sm:text-xl">{t.value}</p>
                {t.note && <p className="text-xs text-muted-foreground">{t.note}</p>}
              </div>
            ))}
          </section>
          <dl className="grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="GSTIN">{c.gstin ?? "Unregistered"}</Detail>
            <Detail label="State">{`${c.stateCode} · ${stateName(c.stateCode) ?? ""}`}</Detail>
            <Detail label="Mobile">{c.mobile}</Detail>
            <Detail label="Email">{c.email}</Detail>
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

        <TabsContent value="history">
          <Timeline chains={chains} user={user} />
        </TabsContent>

        {ledger && (
          <TabsContent value="ledger" className="grid grid-cols-1 gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <LedgerFilter
                action={`/customers/${id}`}
                periods={Object.entries(LEDGER_PERIODS)}
                period={period}
                from={range.from}
                to={range.to}
              />
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <a href={`/customers/${id}/statement?${rangeQuery}`} target="_blank" rel="noopener">
                    PDF / Print
                  </a>
                </Button>
                <WhatsAppButton share={statementShareAction.bind(null, id, period, text("from"), text("to"))} />
                <EmailDialog
                  action={emailStatementAction.bind(null, id, period, text("from"), text("to"))}
                  to={c.email ?? ""}
                  subject={`Statement of account${settings.companyName ? ` from ${settings.companyName}` : ""}`}
                  message={statementMessage({ name: c.name, range, closing: ledger.closing, company: settings.companyName })}
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
                ["Closing balance", drCr(ledger.closing)],
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
                    const allowed = r.docType === "receipts" ? can(user, "payments", "view") : can(user, "invoices", "view");
                    return (
                      <tr key={i}>
                        <td className={td}>
                          <DateText date={r.date} />
                        </td>
                        <td className={td}>
                          {r.number && href ? <DocLink href={href} number={r.number} allowed={allowed} /> : (r.number ?? "")}
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
          </TabsContent>
        )}

        <TabsContent value="attachments">
          <AttachmentsPanel entityType="customer" entityId={id} items={files} canUpload={can(user, "customers", "edit")} />
        </TabsContent>

        <TabsContent value="changes">
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
