import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { milliText, moneyText } from "@/lib/num";
import { getNote, kindOfPath, noteFormLines, NOTE_KIND } from "@/lib/notes";
import { updateNoteAction } from "../../../actions";
import { NoteForm } from "../../../note-form";

export default async function EditNotePage({ params }: PageProps<"/credit-debit-notes/[kind]/[id]/edit">) {
  await requirePermission("invoices", "edit");
  const { kind: path, id: raw } = await params;
  const kind = kindOfPath(path);
  const id = Number(raw);
  const note = kind && Number.isSafeInteger(id) ? await getNote(kind, id) : undefined;
  if (!kind || !note) notFound();
  if (note.status !== "draft") redirect(`/credit-debit-notes/${path}/${id}`);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        back={{ href: `/credit-debit-notes/${path}/${id}`, label: `Draft ${NOTE_KIND[kind].title.toLowerCase()}` }}
        title={`Edit draft ${NOTE_KIND[kind].title.toLowerCase()}`}
        description={`Against invoice ${note.invoice.number} · ${note.customer.name}`}
      />
      <NoteForm
        kind={kind}
        lines={await noteFormLines(kind, note.invoiceId, id)}
        mode={note.mode}
        values={{
          date: note.date,
          reason: note.reason,
          notes: note.notes ?? "",
          lines: Object.fromEntries(
            note.lines.map((l) => [l.invoiceLineId, { qty: l.qtyMilli === null ? "" : milliText(l.qtyMilli), amount: moneyText(l.taxablePaise) }]),
          ),
        }}
        submitLabel="Save draft"
        action={updateNoteAction.bind(null, kind, id)}
      />
    </div>
  );
}
