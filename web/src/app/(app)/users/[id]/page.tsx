import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/permissions";
import { resetPasswordAction, updateUserAction } from "../actions";
import { EditUserForm, ResetPasswordForm } from "../forms";

export default async function UserPage({ params }: PageProps<"/users/[id]">) {
  const actor = await requirePermission("users", "view");
  const { id } = await params;
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.displayUsername,
      role: users.role,
      canViewCost: users.canViewCost,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, id));
  if (!user) notFound();

  return (
    <div className="grid max-w-2xl grid-cols-1 gap-5">
      <PageHeader
        back={{ href: "/users", label: "Users" }}
        title={user.name}
        description={`${user.username}, ${ROLE_LABEL[user.role]}${user.active ? "" : ", disabled"}`}
      />
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Access</CardTitle>
        </CardHeader>
        <CardContent>
          <EditUserForm user={user} self={user.id === actor.id} action={updateUserAction.bind(null, user.id)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm action={resetPasswordAction.bind(null, user.id)} />
        </CardContent>
      </Card>
    </div>
  );
}
