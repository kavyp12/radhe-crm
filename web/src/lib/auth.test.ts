import { expect, test } from "vitest";
import { auth } from "@/lib/auth";

// D70: sign-in allows 10 tries per 60 s per client IP (office staff share one connection). Better Auth limits only in
// production, so this switches the limiter on for this file's instance.
test("sign-in: the 11th try within 60 s from one IP gets 429; another IP keeps its own count", async () => {
  const ctx = await auth.$context;
  ctx.rateLimit.enabled = true;
  try {
    const signIn = (ip: string) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/username", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ username: "rl.nobody", password: "wrong-password" }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await signIn("203.0.113.7")).status);
    expect(statuses).not.toContain(429);
    const blocked = await signIn("203.0.113.7");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("x-retry-after"))).toBeGreaterThan(10); // the 60 s window, not the default 10 s
    expect((await signIn("203.0.113.8")).status).not.toBe(429);
  } finally {
    ctx.rateLimit.enabled = false;
  }
});
