import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { navItemFor } from "@/lib/nav";
import { can } from "@/lib/permissions";

// One page for every module that isn't built yet; each module's own route replaces it when its task lands.
export default async function NotBuiltPage({ params }: PageProps<"/[...slug]">) {
  const user = await requireUser();
  const item = navItemFor(`/${(await params).slug.join("/")}`);
  if (!item) notFound();
  if (!can(user, item.area)) redirect("/");

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title={item.label} />
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={item.icon}
          title="This page isn't built yet. It arrives in a later step of the build."
          action={
            can(user, "salesReports") && (
              <Button asChild variant="outline" size="sm">
                <Link href="/">Back to dashboard</Link>
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}
