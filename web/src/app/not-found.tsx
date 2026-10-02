import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** 404 (T42): an unknown address, or a record that doesn't exist (notFound()). Inside the app it keeps the sidebar. */
export default function NotFound() {
  return (
    <main className="grid min-h-[60vh] place-items-center px-4 py-16 text-center">
      <div className="grid justify-items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg border bg-card text-muted-foreground">
          <FileQuestion className="size-5" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="max-w-sm text-sm text-muted-foreground">This page doesn&apos;t exist, or the record was never saved. Check the address or go back.</p>
        <Button asChild size="sm">
          <Link href="/">Go to the dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
