import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { pendingCount } from "@/lib/approvals";
import { requireUser } from "@/lib/auth";
import { SIDEBAR_COOKIE } from "@/lib/nav";
import { can } from "@/lib/permissions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
  const approvals = can(user, "approvals", "approve") ? await pendingCount() : 0;
  // The bell counts pending approvals; T29 adds the other alerts and the real follow-up count (placeholder 5).
  const counts = { approvals, followUps: 5, alerts: approvals };
  return (
    <AppShell user={user} counts={counts} collapsed={collapsed}>
      {children}
    </AppShell>
  );
}
