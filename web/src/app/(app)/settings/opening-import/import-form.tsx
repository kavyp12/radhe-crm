"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Field, FormSection } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImportResult, Problem } from "@/lib/opening-import";

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 align-top";

function Problems({ title, rows }: { title: string; rows: Problem[] }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title} className="overflow-x-auto rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium text-red-700">
          {title} ({rows.length})
        </h2>
      </div>
      <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className={th}>Sheet</th>
            <th className={th}>Row</th>
            <th className={th}>Column</th>
            <th className={th}>What to fix</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={i}>
              <td className={`${td} whitespace-nowrap`}>{p.sheet ?? "—"}</td>
              <td className={`${td} tabular-nums`}>{p.row ?? "—"}</td>
              <td className={`${td} whitespace-nowrap`}>{p.column ?? "—"}</td>
              <td className={td}>{p.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Upload → Check (the validation preview: nothing saved) → Import (one transaction, all or nothing) → summary. The
 * same file is sent again for Import, and checked again on the server.
 */
export function ImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = (mode: "check" | "import") =>
    start(async () => {
      if (!file) return;
      setError(null);
      const body = new FormData();
      body.set("file", file);
      body.set("mode", mode);
      try {
        const res = await fetch("/settings/opening-import/upload", { method: "POST", body });
        const json = await res.json();
        if (!res.ok) {
          setResult(null);
          setError(json.error ?? "The upload failed: try again.");
        } else setResult(json as ImportResult);
      } catch {
        setError("The upload failed: check the connection and try again.");
      }
    });
  const clean = result && !result.problems.length && !result.duplicates.length;

  return (
    <div className="grid grid-cols-1 gap-4">
      <FormSection title="2. Check the file" description="Nothing is saved yet: every row is checked, also against what is already in the CRM.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Excel file (.xlsx, up to 2 MB)" className="min-w-64">
            <Input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
                setError(null);
              }}
            />
          </Field>
          <Button type="button" disabled={!file || pending} onClick={() => send("check")}>
            {pending ? "Checking…" : "Check file"}
          </Button>
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </FormSection>

      {result && (
        <>
          {result.imported ? (
            <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              Imported. Every opening balance is posted on the books start date. See{" "}
              <Link href="/customers" className="underline">
                customers
              </Link>
              ,{" "}
              <Link href="/outstanding" className="underline">
                outstanding
              </Link>
              ,{" "}
              <Link href="/vendors" className="underline">
                vendors
              </Link>{" "}
              and{" "}
              <Link href="/items" className="underline">
                stock items
              </Link>
              .
            </p>
          ) : clean ? (
            <p role="status" className="rounded-lg border bg-card p-4 text-sm">
              No problems found. Check the totals, then import: it saves everything at once.
            </p>
          ) : (
            <p role="status" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              Nothing was saved. Fix these rows in the file, then check it again.
            </p>
          )}
          <Problems title="Problems" rows={result.problems} />
          <Problems title="Already in the CRM" rows={result.duplicates} />
          {result.totals.length > 0 && (
            <section aria-label="Totals" className="overflow-x-auto rounded-lg border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-medium">{result.imported ? "Imported" : "In this file"}</h2>
              </div>
              <table className="w-full min-w-96 border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>Sheet</th>
                    <th className={`${th} text-right`}>Rows</th>
                    <th className={`${th} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {result.totals.map((t) => (
                    <tr key={t.sheet}>
                      <td className={td}>{t.sheet}</td>
                      <td className={`${td} text-right tabular-nums`}>{t.rows}</td>
                      <td className={`${td} text-right tabular-nums`}>{t.amount ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {clean && !result.imported && (
            <Button type="button" className="w-fit" disabled={pending} onClick={() => send("import")}>
              {pending ? "Importing…" : "Import"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
