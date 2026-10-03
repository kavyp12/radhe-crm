// pnpm smoke <base-url> (T44a, docs/DEPLOY.md §8): checks a running CRM from outside and changes nothing — public
// pages answer, private ones need a session or a device token, and the security headers (D69) are there. With
// SMOKE_USER / SMOKE_PASSWORD (a real login) it also signs in, opens the dashboard and signs out again.
// Prints ✓ / ✗ per check; any ✗ exits 1.

async function smoke() {
  const base = process.argv[2]?.replace(/\/+$/, "");
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("Usage: pnpm smoke <base-url>   e.g. pnpm smoke http://localhost:3000");
    process.exit(2);
  }
  let failed = 0;
  const check = async (name: string, run: () => Promise<true | string>) => {
    const result = await run().catch((e: Error) => e.message);
    if (result !== true) failed++;
    console.log(result === true ? `✓ ${name}` : `✗ ${name}: ${result}`);
  };
  const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
  const status = async (path: string, want: number) => {
    const res = await get(path);
    return res.status === want || `HTTP ${res.status}, expected ${want}`;
  };

  await check("/login answers 200", () => status("/login", 200));
  await check("/ without a session goes to /login", async () => {
    const res = await get("/");
    const to = res.headers.get("location");
    return (res.status >= 300 && res.status < 400 && !!to && new URL(to, base).pathname === "/login") || `HTTP ${res.status}, location ${to}`;
  });
  await check("/api/agent/bootstrap without a device token is 401", () => status("/api/agent/bootstrap", 401));
  await check("/share/<bad token> is 404", () => status("/share/not-a-real-token", 404));
  await check("/manifest.webmanifest answers 200", () => status("/manifest.webmanifest", 200));
  await check("security headers", async () => {
    const h = (await get("/login")).headers;
    const want: [string, (v: string) => boolean][] = [
      ["strict-transport-security", (v) => /max-age=\d{7,}/.test(v)],
      ["x-frame-options", (v) => v === "DENY"],
      ["content-security-policy", (v) => v.includes("frame-ancestors 'none'")],
      ["x-content-type-options", (v) => v === "nosniff"],
      ["referrer-policy", (v) => v === "strict-origin-when-cross-origin"],
      ["permissions-policy", (v) => v.includes("camera=(self)")],
    ];
    const wrong = want.filter(([key, ok]) => !ok(h.get(key) ?? "")).map(([key]) => `${key}: ${h.get(key) ?? "missing"}`);
    return wrong.length ? wrong.join(" · ") : true;
  });

  const { SMOKE_USER: username, SMOKE_PASSWORD: password } = process.env;
  if (username && password) {
    await check("sign in, open the dashboard, sign out", async () => {
      const json = { "content-type": "application/json", origin: base };
      const signIn = await fetch(`${base}/api/auth/sign-in/username`, { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
      if (signIn.status !== 200) return `sign-in HTTP ${signIn.status}`;
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const page = await get("/", { headers: { cookie } });
      const html = page.status === 200 ? await page.text() : "";
      await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
      if (page.status !== 200) return `dashboard HTTP ${page.status}`;
      return html.includes("Dashboard") || "the dashboard didn't render";
    });
  } else {
    console.log("· sign-in skipped: set SMOKE_USER and SMOKE_PASSWORD to include it");
  }

  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

smoke();
