import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, expect, test, vi } from "vitest";
import { OWNER, signedIn, testOwner } from "@/db/test-owner";
import { createUser } from "@/lib/users";

// T42 (hard rule 5, D67): every exported server action ("use server" file) and every route handler (route.ts) must
// call a guard — requireUser / requirePermission / requireCostPermission, userFromHeaders, or the agent device wrapper
// agentRoute — itself or through a helper in the same file. Only the allow-list below may skip it. Then a runtime
// sample: actions and routes called without a session → /login or 401; a signed-in user outside the area → "/".

const GUARDS = new Set(["requireUser", "requirePermission", "requireCostPermission", "userFromHeaders", "agentRoute"]);
const ALLOWED = new Set([
  "src/app/(app)/actions.ts#logout", // signing out needs no session
  "src/app/api/auth/[...all]/route.ts#GET", // Better Auth's own handler (login itself)
  "src/app/api/auth/[...all]/route.ts#POST",
  "src/app/share/[token]/route.ts#GET", // public: the random share token is the key (D46)
  "src/app/api/agent/pair/route.ts#POST", // the agent trades a one-time pairing code for its device token (D64)
]);

const ROOT = path.resolve(__dirname, "../..");
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const isUseServer = (sf: ts.SourceFile) => {
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
};
const exported = (n: ts.Node) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** name → the exported handlers (function body or initializer) of one file, plus its local functions. */
function handlers(sf: ts.SourceFile) {
  const out = new Map<string, ts.Node>();
  const local = new Map<string, ts.Node>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) (exported(s) ? out : local).set(s.name.text, s);
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!d.initializer) continue;
        const target = exported(s) ? out : local;
        if (ts.isIdentifier(d.name)) target.set(d.name.text, d.initializer);
        else if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isIdentifier(el.name)) target.set(el.name.text, d.initializer);
      }
    }
  }
  return { out, local };
}

/** Does this node call a guard, directly or through a same-file helper? */
function guarded(node: ts.Node, local: Map<string, ts.Node>, seen = new Set<string>()): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (GUARDS.has(name)) return void (found = true);
      if (local.has(name) && !seen.has(name)) {
        seen.add(name);
        if (guarded(local.get(name)!, local, seen)) return void (found = true);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

test("every exported server action and route handler calls a permission guard (allow-list only)", () => {
  const checked: string[] = [];
  const unguarded: string[] = [];
  for (const file of sources(path.join(ROOT, "src"))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const isRoute = path.basename(file) === "route.ts";
    if (!isRoute && !isUseServer(sf)) continue;
    const { out, local } = handlers(sf);
    expect(out.size, `${rel(file)} exports nothing`).toBeGreaterThan(0);
    for (const [name, node] of out) {
      const key = `${rel(file)}#${name}`;
      if (isRoute && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) continue; // config exports (runtime, …)
      checked.push(key);
      if (!ALLOWED.has(key) && !guarded(node, local)) unguarded.push(key);
    }
  }
  expect(unguarded).toEqual([]);
  // The allow-list names real handlers (a stale entry would hide nothing but should go).
  expect([...ALLOWED].filter((k) => !checked.includes(k))).toEqual([]);
  // Sanity: the scan saw the app's actions and routes (115 handlers in 26 action files + 17 route files when written).
  expect(checked.length).toBeGreaterThanOrEqual(115);
  expect(checked.filter((k) => k.endsWith("/route.ts#GET") || k.endsWith("/route.ts#POST")).length).toBeGreaterThanOrEqual(18);
});

test("the scan catches an unguarded action, also behind a helper that never checks", () => {
  const scan = (code: string) => {
    const sf = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
    const { out, local } = handlers(sf);
    return [...out].map(([name, node]) => [name, guarded(node, local)]);
  };
  expect(
    scan(`"use server";
      const who = () => requireUser();
      const noop = () => 1;
      export async function a() { await requirePermission("payments"); }
      export async function b() { return db.select(); }
      export async function c() { await who(); }
      export async function d() { noop(); }
      export const GET = agentRoute(async () => 1);`),
  ).toEqual([["a", true], ["b", false], ["c", true], ["d", false], ["GET", true]]);
});

// ---- Runtime sample: the guards really answer.

let cookie: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookie ? { cookie } : {}),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));

const redirectedTo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw e;
  }
  return "no redirect";
};
const get = (url: string) => new Request(`http://localhost:3000${url}`, { headers: cookie ? { cookie } : {} });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  const owner = await testOwner();
  await createUser(owner, { name: "pc.sales", username: "pc.sales", role: "sales", canViewCost: false, password: "pc-sales-pass-1" });
});

// A cold start compiles every module imported here, which can take far longer than 5 s (D70).
test("without a session: server actions → /login, route handlers → 401", { timeout: 120_000 }, async () => {
  cookie = null;
  const { searchAction } = await import("@/app/(app)/actions");
  const { createReceiptAction, openItemsAction } = await import("@/app/(app)/receipts/actions");
  const { saveSettingsAction } = await import("@/app/(app)/settings/actions");
  const { cancelInvoiceAction } = await import("@/app/(app)/invoices/actions");
  expect(await redirectedTo(searchAction("abc"))).toBe("/login");
  expect(await redirectedTo(createReceiptAction({}, new FormData()))).toBe("/login");
  expect(await redirectedTo(openItemsAction(1))).toBe("/login");
  expect(await redirectedTo(saveSettingsAction({}, new FormData()))).toBe("/login");
  expect(await redirectedTo(cancelInvoiceAction(1, {}, new FormData()))).toBe("/login");

  // Each handler runs and is awaited before the next import starts: none may outlive this test (the next one signs in).
  const routes = [
    async () => (await import("@/app/export/all-data/route")).GET(get("/export/all-data") as never),
    async () => (await import("@/app/export/[name]/route")).GET(get("/export/sales") as never, params({ name: "sales" }) as never),
    async () => (await import("@/app/(app)/invoices/[id]/pdf/route")).GET(get("/invoices/1/pdf") as never, params({ id: "1" }) as never),
    async () => (await import("@/app/(app)/customers/[id]/statement/route")).GET(get("/customers/1/statement") as never, params({ id: "1" }) as never),
    async () => (await import("@/app/api/files/[id]/route")).GET(get("/api/files/1") as never, params({ id: "1" }) as never),
    async () => (await import("@/app/api/agent/bootstrap/route")).GET(get("/api/agent/bootstrap"), params({})),
  ];
  for (const run of routes) expect((await run()).status).toBe(401);
});

test("signed in outside the area: a sales user is sent to the dashboard / refused", async () => {
  cookie = (await signedIn("pc.sales", "pc-sales-pass-1")).get("cookie");
  const { saveSettingsAction } = await import("@/app/(app)/settings/actions");
  const { createReceiptAction } = await import("@/app/(app)/receipts/actions");
  expect(await redirectedTo(saveSettingsAction({}, new FormData()))).toBe("/");
  expect(await redirectedTo(createReceiptAction({}, new FormData()))).toBe("/");
  expect((await (await import("@/app/export/all-data/route")).GET(get("/export/all-data") as never)).status).toBe(403);
  // The owner gets through the same guard (a form error, not a redirect).
  cookie = (await signedIn(OWNER.username, OWNER.password)).get("cookie");
  expect(await redirectedTo(createReceiptAction({}, new FormData()))).toBe("no redirect");
  cookie = null;
});
