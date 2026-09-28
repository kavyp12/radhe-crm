import { ChevronLeft, Ellipsis } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge, type Status } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  status?: Status;
  back?: { href: string; label: string };
  /** The primary action (usually one Button). */
  action?: ReactNode;
  /** Secondary actions: DropdownMenuItem elements, shown behind "⋯". */
  menu?: ReactNode;
};

export function PageHeader({ title, description, status, back, action, menu }: Props) {
  return (
    <header>
      {back && (
        <Link
          href={back.href}
          className="mb-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-xl leading-8 font-medium tracking-tight">{title}</h1>
          {status && <StatusBadge status={status} />}
        </div>
        {(action || menu) && (
          <div className="flex items-center gap-2">
            {menu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
              </DropdownMenu>
            )}
            {action}
          </div>
        )}
      </div>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}
