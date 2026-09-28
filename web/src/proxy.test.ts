import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { proxy } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, "http://localhost:3000"), { headers: cookie ? { cookie } : {} });
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

test("no session → redirect to /login, remembering where the user was going", () => {
  const res = proxy(request("/customers?q=ram"));
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fcustomers%3Fq%3Dram");
  expect(proxy(request("/")).headers.get("location")).toBe("http://localhost:3000/login");
});

test("/login, /api/auth/* and /share/<token> stay reachable without a session", () => {
  expect(passes(proxy(request("/login")))).toBe(true);
  expect(passes(proxy(request("/api/auth/sign-in/username")))).toBe(true);
  expect(passes(proxy(request("/share/abc")))).toBe(true);
  expect(passes(proxy(request("/shared")))).toBe(false);
});

test("other API routes answer 401 without a session", () => {
  expect(proxy(request("/api/files/1")).status).toBe(401);
});

test("a session cookie lets the request through (the page re-checks the session)", () => {
  expect(passes(proxy(request("/customers", "better-auth.session_token=abc.def")))).toBe(true);
});
