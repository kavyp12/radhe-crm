import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { can, ROLE_LABEL } from "@/lib/permissions";
import { logout } from "./actions";

// Minimal frame for T03; T04 replaces it with the real shell (sidebar, top bar).
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="min-h-svh bg-muted">
      <header className="flex h-12 items-center justify-between gap-4 border-b bg-background px-4">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="font-semibold">
            Radhe CRM
          </Link>
          {can(user, "users") && <Link href="/users">Users</Link>}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span>
            {user.name} · {ROLE_LABEL[user.role]}
          </span>
          <form action={logout}>
            <Button variant="outline" size="sm">
              Log out
            </Button>
          </form>
        </div>
      </header>
      <main className="p-4">{children}</main>
    </div>
  );
}
