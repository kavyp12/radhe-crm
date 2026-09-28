"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Posts straight to Better Auth's endpoint so its rate limit and origin check apply to sign-in.
export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      if (res.ok) return window.location.assign(next); // full load, so every server component sees the new session
      const body = await res.json().catch(() => null);
      setError(res.status === 429 ? "Too many attempts. Wait a minute and try again." : (body?.message ?? "Sign-in failed."));
    } catch {
      setError("Can't reach the server. Check the connection and try again.");
    }
    setPending(false);
  }

  return (
    <Card className="w-full max-w-sm gap-5 py-6">
      <CardHeader className="px-6">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            R
          </span>
          <div className="leading-tight">
            <p className="text-sm font-medium">Radhe</p>
            <p className="text-xs text-muted-foreground">Digital Sign Board</p>
          </div>
        </div>
        <CardTitle className="text-lg">Sign in</CardTitle>
        <CardDescription>Use the username and password the owner gave you.</CardDescription>
      </CardHeader>
      <CardContent className="px-6">
        <form onSubmit={onSubmit} className="grid gap-4">
          <Label className="grid gap-1.5">
            Username
            <Input name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} />
          </Label>
          <Label className="grid gap-1.5">
            Password
            <Input name="password" type="password" required autoComplete="current-password" />
          </Label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
