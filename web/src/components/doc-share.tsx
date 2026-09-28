import { EmailDialog } from "@/components/doc-actions";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/action";

// PDF / print, WhatsApp and email for a quotation or invoice (D07). WhatsApp and email only once it has left Draft.

type Props = {
  pdfHref: string;
  /** wa.me link; omit for drafts. */
  whatsapp?: string;
  /** Omit for drafts. */
  email?: { action: (state: FormState, form: FormData) => Promise<FormState>; to: string; subject: string; message: string };
};

export function DocShare({ pdfHref, whatsapp, email }: Props) {
  return (
    <>
      <Button asChild variant="outline">
        <a href={pdfHref} target="_blank" rel="noopener">
          PDF / Print
        </a>
      </Button>
      {whatsapp && (
        <Button asChild variant="outline">
          <a href={whatsapp} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
        </Button>
      )}
      {email && <EmailDialog {...email} />}
    </>
  );
}

/** Label / value pairs under a document's header. */
export function DocFacts({ facts }: { facts: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      {facts.map(([label, value]) => (
        <div key={label} className="grid content-start gap-0.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm wrap-break-word whitespace-pre-line">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
