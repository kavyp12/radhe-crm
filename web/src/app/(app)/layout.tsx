import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";
import { SIDEBAR_COOKIE } from "@/lib/nav";

// Placeholder counts until approvals (T07) and alerts / follow-ups (T29) exist.
const COUNTS = { approvals: 2, followUps: 5, alerts: 3 };

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
  return (
    <AppShell user={user} counts={COUNTS} collapsed={collapsed}>
      {children}
    </AppShell>
  );
}
