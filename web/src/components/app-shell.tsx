"use client";

import { Bell, ChevronsUpDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { logout } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navFor, navItemFor, newMenuFor, SIDEBAR_COOKIE, type NavCount, type NavItem } from "@/lib/nav";
import { ROLE_LABEL, type SessionUser } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export type ShellCounts = Record<NavCount | "alerts", number>;

type ShellProps = { user: SessionUser; counts: ShellCounts; collapsed: boolean; children: React.ReactNode };

// The menu only reflects can(); every page still checks permission on the server.
export function AppShell({ user, counts, collapsed: initiallyCollapsed, children }: ShellProps) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  function toggleSidebar() {
    setCollapsed(!collapsed);
    document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 0 : 1}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <div className="flex h-svh overflow-hidden">
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-out md:flex",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <Sidebar user={user} counts={counts} collapsed={collapsed} />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" showCloseButton={false} className="w-72 max-w-[85vw] gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Sidebar user={user} counts={counts} collapsed={false} onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          user={user}
          alerts={counts.alerts}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onMenu={() => setDrawerOpen(true)}
        />
        <main className="relative flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-5 md:px-6 md:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

type SidebarProps = { user: SessionUser; counts: ShellCounts; collapsed: boolean; onNavigate?: () => void };

function Sidebar({ user, counts, collapsed, onNavigate }: SidebarProps) {
  const activeHref = navItemFor(usePathname())?.href;
  return (
    <>
      <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b px-3", collapsed && "justify-center px-0")}>
        {/* Monogram until Radhe's logo arrives (Q3). */}
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          R
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-medium">Radhe</p>
            <p className="truncate text-xs text-muted-foreground">Digital Sign Board</p>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-3">
        {navFor(user).map((group, index) => (
          <div key={group.label ?? index}>
            {group.label && !collapsed ? (
              <p className={cn("px-2 pb-1 text-xs font-medium text-muted-foreground", index === 0 ? "pt-1" : "pt-4")}>
                {group.label}
              </p>
            ) : (
              index > 0 && <div role="separator" className="mx-2 my-2.5 h-px bg-border" />
            )}
            <ul className="grid gap-px">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    item={item}
                    active={item.href === activeHref}
                    collapsed={collapsed}
                    count={item.count ? counts[item.count] : 0}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <UserMenu user={user} collapsed={collapsed} />
    </>
  );
}

type NavLinkProps = { item: NavItem; active: boolean; collapsed: boolean; count: number; onNavigate?: () => void };

function NavLink({ item, active, collapsed, count, onNavigate }: NavLinkProps) {
  const Icon = item.icon;
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" }); // e.g. Settings, below the fold on a laptop
  }, [active]);
  const link = (
    <Link
      ref={ref}
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? (count ? `${item.label} (${count})` : item.label) : undefined}
      className={cn(
        "group/nav relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium max-md:h-10 max-md:text-sm text-sidebar-foreground outline-none transition-colors duration-150",
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        active && "bg-primary/[0.08] text-primary hover:bg-primary/[0.08] hover:text-primary",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/nav:text-foreground",
          active && "text-primary group-hover/nav:text-primary",
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {count > 0 &&
        (collapsed ? (
          <span aria-hidden className="absolute top-1.5 right-2 size-1.5 rounded-full bg-primary" />
        ) : (
          <span
            className={cn(
              "ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-[18px] font-medium tabular-nums",
              active ? "bg-primary/10 text-primary" : "bg-zinc-100 text-zinc-600",
            )}
          >
            {count}
          </span>
        ))}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {item.label}
        {count > 0 && ` · ${count}`}
      </TooltipContent>
    </Tooltip>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

function UserMenu({ user, collapsed }: { user: SessionUser; collapsed: boolean }) {
  const [signingOut, startTransition] = useTransition();
  return (
    <div className="shrink-0 border-t p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={collapsed ? `${user.name}, ${ROLE_LABEL[user.role]}` : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition-colors duration-150",
              "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-sidebar-accent",
              collapsed && "justify-center",
            )}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {initials(user.name)}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[13px] font-medium">{user.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{ROLE_LABEL[user.role]}</span>
                </span>
                <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium text-foreground">{user.name}</p>
            <p className="text-xs text-muted-foreground">
              {user.username} · {ROLE_LABEL[user.role]}
            </p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signingOut} onSelect={() => startTransition(() => logout())}>
            <LogOut />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type TopBarProps = {
  user: SessionUser;
  alerts: number;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: () => void;
};

function TopBar({ user, alerts, collapsed, onToggle, onMenu }: TopBarProps) {
  const newItems = newMenuFor(user);
  const router = useRouter();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3 md:px-4">
      <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu" onClick={onMenu}>
        <Menu />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden text-muted-foreground md:inline-flex"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggle}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>

      {/* Placeholder: universal search (Ctrl+K) arrives in T35. */}
      <button
        type="button"
        onClick={() => toast("Search is coming soon.")}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] text-muted-foreground outline-none transition-colors duration-150 hover:border-zinc-400 focus-visible:ring-2 focus-visible:ring-ring/60 md:max-w-sm"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="truncate">Search customers, jobs, invoices…</span>
        <kbd className="ml-auto hidden rounded border bg-card px-1.5 font-sans text-[11px] leading-5 sm:inline">Ctrl K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        {newItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" aria-label="New">
                <Plus />
                <span className="hidden sm:inline">New</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {newItems.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* T29: every alert this user may see (/alerts). */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative text-muted-foreground"
          aria-label={`Alerts (${alerts})`}
          onClick={() => router.push("/alerts")}
        >
          <Bell />
          {alerts > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums">
              {alerts}
            </span>
          )}
        </Button>
      </div>
    </header>
  );
}
