import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Radhe CRM" };

/** Only paths on this site, so ?next= can't send someone to another website. */
function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNext((await searchParams).next);
  if (await getUser()) redirect(next);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4">
      <LoginForm next={next} />
    </main>
  );
}
