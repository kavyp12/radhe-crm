"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Something broke while showing a page (T42). Never the error's message or stack — only the digest, which matches the
 * server log. Inside the app it keeps the sidebar.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="grid min-h-[60vh] place-items-center px-4 py-16 text-center">
      <div className="grid justify-items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg border bg-card text-red-700">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Try again; if it keeps happening, tell the owner
          {error.digest ? (
            <>
              {" "}
              and quote reference <span className="font-mono">{error.digest}</span>
            </>
          ) : null}
          .
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/">Dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
