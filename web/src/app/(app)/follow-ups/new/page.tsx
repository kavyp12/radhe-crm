import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { followUpFormOptions } from "@/lib/follow-ups";
import { outstanding } from "@/lib/outstanding";
import { createFollowUpAction } from "../actions";
import { FollowUpForm } from "../follow-up-form";

/** ?customer= / ?invoice= fill the form; ?from=customer | invoice | outstanding returns there after saving. */
export default async function NewFollowUpPage({ searchParams }: PageProps<"/follow-ups/new">) {
  const user = await requirePermission("followUps", "create");
  const q = await searchParams;
  const text = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
  const [options, report] = await Promise.all([followUpFormOptions(), outstanding()]);
  const invoice = options.invoices.find((i) => String(i.id) === text("invoice"));
  const customer = options.customers.find((c) => String(c.id) === (invoice ? String(invoice.customerId) : text("customer")));
  const back =
    text("from") === "invoice" && invoice
      ? `/invoices/${invoice.id}`
      : text("from") === "customer" && customer
        ? `/customers/${customer.id}`
        : text("from") === "outstanding" && customer
          ? `/outstanding?customer=${customer.id}`
          : "/follow-ups";
  const due = new Map(report.customers.map((c) => [c.id, c.totals.total]));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: back, label: "Back" }} title="New follow-up" />
      <FollowUpForm
        values={{
          customerId: customer ? String(customer.id) : "",
          invoiceId: invoice ? String(invoice.id) : "",
          followUpDate: todayIST(),
          personId: user.id,
        }}
        options={{ ...options, customers: options.customers.map((c) => ({ ...c, outstanding: due.get(c.id) ?? 0n })) }}
        back={back}
        action={createFollowUpAction}
      />
    </div>
  );
}
