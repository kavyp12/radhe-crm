import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { alertsFor } from "@/lib/alerts";
import { pendingCount } from "@/lib/approvals";
import { requireUser } from "@/lib/auth";
import { myFollowUpsDueCount } from "@/lib/follow-ups";
import { pendingRequestCount } from "@/lib/material-requests";
import { SIDEBAR_COOKIE } from "@/lib/nav";
import { can } from "@/lib/permissions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
  // Approval requests + pending material requests (D53: the owner approves those on the request itself).
  const approvals = can(user, "approvals", "approve") ? (await pendingCount()) + (await pendingRequestCount()) : 0;
  // T29: the bell = my alerts (D22: queries, only areas I can open); Follow-ups = mine due today or earlier.
  const [alerts, followUps] = await Promise.all([alertsFor(user), myFollowUpsDueCount(user)]);
  const counts = { approvals, followUps, alerts: alerts.length };
  return (
    <AppShell user={user} counts={counts} collapsed={collapsed}>
      {children}
    </AppShell>
  );
}
