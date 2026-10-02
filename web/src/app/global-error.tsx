"use client";

import "./globals.css";

/** The root layout itself failed (T42): its own document, no stack trace — only the digest from the server log. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Radhe CRM</title>
        <main className="grid min-h-screen place-items-center px-4 text-center">
          <div className="grid justify-items-center gap-3">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              Radhe CRM couldn&apos;t load. Try again; if it keeps happening, tell the owner
              {error.digest ? ` and quote reference ${error.digest}` : ""}.
            </p>
            <button type="button" onClick={() => retry()} className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
