import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { todayIST } from "@/lib/dates";
import { getInvoice } from "@/lib/invoices";
import { noteFormLines } from "@/lib/notes";
import { createNoteAction } from "../actions";
import { NoteForm } from "../note-form";

/** ?invoice=<id>&kind=credit|debit — from the "Credit note" / "Debit note" buttons on an issued invoice. */
export default async function NewNotePage({ searchParams }: PageProps<"/credit-debit-notes/new">) {
  await requirePermission("invoices", "create");
  const q = await searchParams;
  const kind = q.kind === "debit" ? "debit" : "credit";
  const invoiceId = Number(q.invoice);
  const inv = Number.isSafeInteger(invoiceId) ? await getInvoice(invoiceId) : undefined;
  if (!inv) notFound();
  const title = kind === "credit" ? "New credit note" : "New debit note";
  if (inv.status !== "issued") {
    return (
      <div className="grid grid-cols-1 gap-5">
        <PageHeader back={{ href: `/invoices/${inv.id}`, label: inv.number ?? "Invoice" }} title={title} />
        <p className="text-sm text-muted-foreground">Only an issued invoice can have a credit or debit note.</p>
      </div>
    );
  }
  const c = inv.customer;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/invoices/${inv.id}`, label: inv.number! }}
        title={title}
        description={`Against invoice ${inv.number} · ${c.firmName ? `${c.name} · ${c.firmName}` : c.name}`}
      />
      <NoteForm
        kind={kind}
        lines={await noteFormLines(kind, inv.id)}
        mode={inv.mode}
        values={{ date: todayIST(), reason: "", notes: "", lines: {} }}
        submitLabel="Save draft"
        action={createNoteAction.bind(null, kind, inv.id)}
      />
    </div>
  );
}
