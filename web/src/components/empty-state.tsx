import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** One line and the primary action (DESIGN.md "Empty states"). */
export function EmptyState({ icon: Icon = Inbox, title, action }: { icon?: LucideIcon; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-lg border bg-card text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <p className="max-w-sm text-sm text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}
