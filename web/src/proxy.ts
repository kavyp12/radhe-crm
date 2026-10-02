import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// First gate only: is there a session cookie at all? Every page, server action and route handler still checks
// the real session on the server (lib/auth.ts).
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // /share/<token>: a public PDF link (D46); the token is checked by the route itself. /api/agent/*: the print agent
  // (T39) has no session — every route there checks its device token itself (lib/agent.ts) and never a cookie.
  const open =
    pathname === "/login" || pathname.startsWith("/api/auth/") || pathname.startsWith("/share/") || pathname.startsWith("/api/agent/");
  if (open || getSessionCookie(request)) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
