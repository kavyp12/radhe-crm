"use client";

import { FileDown, FileSpreadsheet, Printer, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const exportHref = (name: string, query: string, format: "xlsx" | "pdf") => `/export/${name}?${query ? `${query}&` : ""}format=${format}`;

/** Excel · PDF · Print · Share for a report (S27, D59), all built by /export/<name> with the page's filters. */
export function ReportActions({ name, query, pdfName, title }: { name: string; query: string; pdfName: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const pdf = exportHref(name, query, "pdf");

  // The browser's share sheet with the PDF (WhatsApp, mail … on a phone); where files can't be shared, a download.
  async function share() {
    setBusy(true);
    try {
      const res = await fetch(pdf);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const file = new File([blob], pdfName, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title }).catch((e: Error) => {
          if (e.name !== "AbortError") throw e;
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: pdfName });
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      toast.error("Couldn't share the PDF. Try the PDF button.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline">
        <a href={exportHref(name, query, "xlsx")} download>
          <FileSpreadsheet aria-hidden />
          Excel
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={pdf} download={pdfName}>
          <FileDown aria-hidden />
          PDF
        </a>
      </Button>
      <Button asChild variant="outline">
        <a href={pdf} target="_blank" rel="noopener">
          <Printer aria-hidden />
          Print
        </a>
      </Button>
      <Button variant="outline" onClick={share} disabled={busy}>
        <Share2 aria-hidden />
        Share
      </Button>
    </div>
  );
}

/** "Excel" on a main list: every row of the list, with the columns this user sees (S27). */
export function ExportExcelButton({ name }: { name: string }) {
  return (
    <Button asChild variant="outline">
      <a href={exportHref(name, "", "xlsx")} download>
        <FileSpreadsheet aria-hidden />
        Excel
      </a>
    </Button>
  );
}
