import { requireUser } from "@/lib/auth";

export default async function DashboardPage() {
  const user = await requireUser();
  return <h1 className="text-lg font-semibold">Welcome, {user.name}</h1>;
}
