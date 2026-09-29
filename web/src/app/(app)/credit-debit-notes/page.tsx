import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { listNotes, NOTE_KIND, NOTE_STATUS } from "@/lib/notes";
import { NotesTable } from "./notes-table";

export default async function NotesPage() {
  await requirePermission("invoices", "view");
  const rows = await listNotes();
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Credit/Debit Notes"
        description="Corrections to issued invoices: returns, rate changes, discounts. Made from the invoice's page."
      />
      <NotesTable
        rows={rows.map((r) => ({
          href: `/credit-debit-notes/${NOTE_KIND[r.kind].path}/${r.id}`,
          number: r.number ?? "Draft",
          kind: NOTE_KIND[r.kind].title,
          date: r.date,
          invoice: r.invoice ?? "",
          customer: r.firmName ? `${r.customer} · ${r.firmName}` : r.customer,
          reason: r.reason,
          status: NOTE_STATUS[r.status],
          payment: r.payment,
          total: r.total,
        }))}
      />
    </div>
  );
}
