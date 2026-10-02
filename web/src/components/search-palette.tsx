"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { searchAction } from "@/app/(app)/actions";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { SearchGroup } from "@/lib/search";

/**
 * Universal search (S26, T35): the top-bar box and Ctrl+K open a palette (full screen on a phone). Typing asks the
 * server once the input rests (one action, up to 5 hits per type); ↑ ↓ pick a hit, Enter opens it.
 */
export function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ q: string; groups: SearchGroup[] } | null>(null);
  const q = query.trim();
  const ready = q.length >= 3;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = setTimeout(() => {
      searchAction(q)
        .then((groups) => live && setResult({ q, groups }))
        .catch(() => {
          if (live) setResult({ q, groups: [] });
          toast.error("Search failed. Try again.");
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, ready]);

  // While the next answer is on its way the last one stays on screen, dimmed and disabled, so Enter never opens a hit
  // for an older query; the fresh one remounts (keyed by its query) and cmdk selects its first hit.
  const groups = ready && result ? result.groups : [];
  const fresh = result?.q === q;

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] text-muted-foreground outline-none transition-colors duration-150 hover:border-zinc-400 focus-visible:ring-2 focus-visible:ring-ring/60 md:max-w-sm"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="truncate">Search customers, jobs, invoices…</span>
        <kbd className="ml-auto hidden rounded border bg-card px-1.5 font-sans text-[11px] leading-5 sm:inline">Ctrl K</kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search"
        description="Customers, vendors, jobs, documents by number, or an amount."
        showCloseButton
        className="sm:max-w-xl max-sm:inset-0 max-sm:h-svh max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none!"
      >
        <Command shouldFilter={false} className="max-sm:rounded-none!">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Name, mobile, GSTIN, job / invoice no, amount…"
            className="pr-8"
          />
          <CommandList className="max-h-[min(28rem,60svh)] max-sm:max-h-none max-sm:flex-1">
            {!ready ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 3 characters.</p>
            ) : !fresh && groups.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p>
            ) : (
              <CommandEmpty>Nothing found for “{q}”.</CommandEmpty>
            )}
            {groups.map((g) => (
              <CommandGroup key={`${result!.q}|${g.label}`} heading={g.label}>
                {g.hits.map((h, i) => (
                  <CommandItem key={i} value={`${g.label} ${i}`} disabled={!fresh} onSelect={() => go(h.href)}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{h.title}</p>
                      {h.detail && <p className="truncate text-xs text-muted-foreground">{h.detail}</p>}
                    </div>
                    {h.amount && <span className="shrink-0 text-[13px] tabular-nums">{h.amount}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
