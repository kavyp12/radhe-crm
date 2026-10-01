import Link from "next/link";
import { notFound } from "next/navigation";
import { DateText } from "@/components/date-text";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { getCustomer } from "@/lib/customers";
import { AGING, byPerson, emptyTotals, outstanding, type OutstandingCustomer, type OutstandingDoc, type Totals } from "@/lib/outstanding";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { CustomerTable, DocTable, PersonTable, type DocRow, type Figures } from "./outstanding-tables";

const VIEWS = [
  { key: "customer", label: "Customer-wise" },
  { key: "invoice", label: "Invoice-wise" },
  { key: "sales", label: "Sales person" },
  { key: "collection", label: "Collection person" },
] as const;
type View = (typeof VIEWS)[number]["key"];

const link = (params: Record<string, string>) => `/outstanding?${new URLSearchParams(params)}`;
const flat = (t: Totals): Figures => ({ ...t.aging, onAccount: t.onAccount, total: t.total, dueToday: t.dueToday, overdue: t.overdue });
const docRow = (d: OutstandingDoc, customer: string): DocRow => ({
  key: `${d.target}:${d.id}`,
  number: d.number,
  kind: d.target === "invoice" ? "Invoice" : "Debit note",
  customer,
  date: d.date,
  dueDate: d.dueDate,
  age: d.age,
  bucket: AGING.find((b) => b.key === d.bucket)!.label,
  due: d.due === "today" ? "Due today" : d.due === "overdue" ? "Overdue" : "Not due",
  open: d.open,
  href: d.target === "invoice" ? `/invoices/${d.id}` : `/credit-debit-notes/dn/${d.id}`,
});
const customerRows = (rows: OutstandingCustomer[], from: Record<string, string> = {}) =>
  rows.map((c) => ({
    id: c.id,
    name: c.firmName ? `${c.name} · ${c.firmName}` : c.name,
    salesPerson: c.salesPerson ?? "",
    collectionPerson: c.collectionPerson ?? "",
    href: link({ ...from, customer: String(c.id) }),
    ...flat(c.totals),
  }));

/** S7: who owes what and for how long, as of today (IST); every view adds up to AR (D57). */
export default async function OutstandingPage({ searchParams }: PageProps<"/outstanding">) {
  const user = await requirePermission("salesReports", "view");
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const view: View = VIEWS.find((v) => v.key === text("view"))?.key ?? "customer";
  const report = await outstanding();
  const asOf = (
    <>
      As of <DateText date={report.today} /> · aging by invoice date
    </>
  );

  // One customer's open documents (from the customer list, or from a person's).
  if (text("customer")) {
    const id = Number(text("customer"));
    const row = report.customers.find((c) => c.id === id);
    const customer = row ?? (Number.isSafeInteger(id) ? await getCustomer(id) : undefined);
    if (!customer) notFound();
    const person = text("person");
    const back = person ? { href: link({ view, person }), label: "Back to the person" } : { href: link({ view }), label: "Outstanding" };
    const totals = row?.totals ?? emptyTotals();
    return (
      <div className="grid grid-cols-1 gap-5">
        <PageHeader
          back={back}
          title={customer.name}
          description={asOf}
          action={
            <div className="flex flex-wrap gap-2">
              {can(user, "followUps", "create") && (
                <Button asChild variant="outline">
                  <Link href={`/follow-ups/new?customer=${id}&from=outstanding`}>Log follow-up</Link>
                </Button>
              )}
              {can(user, "customers", "view") && (
                <Button asChild variant="outline">
                  <Link href={`/customers/${id}`}>Customer page</Link>
                </Button>
              )}
            </div>
          }
        />
        <Summary totals={totals} />
        <DocTable rows={(row?.docs ?? []).map((d) => docRow(d, customer.name))} showCustomer={false} />
      </div>
    );
  }

  // A person's customers.
  if ((view === "sales" || view === "collection") && text("person")) {
    const group = byPerson(report.customers, view).find((g) => g.id === text("person"));
    if (!group) notFound();
    return (
      <div className="grid grid-cols-1 gap-5">
        <PageHeader
          back={{ href: link({ view }), label: view === "sales" ? "Sales persons" : "Collection persons" }}
          title={group.name}
          description={asOf}
        />
        <Summary totals={group.totals} />
        <CustomerTable rows={customerRows(group.customers, { view, person: group.id })} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Outstanding" description={asOf} />
      <Summary totals={report.totals} />
      <nav aria-label="Views" className="flex flex-wrap gap-1 border-b">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={link({ view: v.key })}
            aria-current={v.key === view ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
              v.key === view ? "border-primary font-medium text-foreground" : "border-transparent",
            )}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      {view === "customer" && <CustomerTable rows={customerRows(report.customers)} />}
      {view === "invoice" && (
        <DocTable rows={report.customers.flatMap((c) => c.docs.map((d) => docRow(d, c.name))).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))} />
      )}
      {(view === "sales" || view === "collection") && (
        <PersonTable
          rows={byPerson(report.customers, view).map((g) => ({
            id: g.id,
            name: g.name,
            customers: g.customers.length,
            href: link({ view, person: g.id }),
            ...flat(g.totals),
          }))}
        />
      )}
    </div>
  );
}

/** Total receivable (= AR), due today, overdue; then the aging buckets and the opening / on-account rest. */
function Summary({ totals }: { totals: Totals }) {
  const tile = "bg-card px-4 py-3";
  return (
    <div className="grid gap-3">
      <section aria-label="Receivable" className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {[
          ["Total receivable", totals.total, ""],
          ["Due today", totals.dueToday, ""],
          ["Overdue", totals.overdue, totals.overdue > 0n ? "text-red-700" : ""],
        ].map(([label, paise, tone]) => (
          <div key={label as string} className={tile}>
            <p className="text-xs text-muted-foreground">{label as string}</p>
            <Money paise={paise as bigint} className={cn("mt-0.5 block text-lg leading-7 font-medium tracking-tight", tone as string)} />
          </div>
        ))}
      </section>
      <section aria-label="Aging" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {AGING.map((b) => (
          <div key={b.key} className={tile}>
            <p className="text-xs text-muted-foreground">{b.label}</p>
            <Money paise={totals.aging[b.key]} className="mt-0.5 block font-medium" />
          </div>
        ))}
        <div className={tile}>
          <p className="text-xs text-muted-foreground">Opening / on account</p>
          <Money paise={totals.onAccount} className="mt-0.5 block font-medium" />
        </div>
      </section>
    </div>
  );
}
