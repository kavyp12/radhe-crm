import { expect, test } from "vitest";
import { loadDashboard, type Dashboard } from "@/lib/dashboard";
import type { Role, SessionUser } from "@/lib/permissions";

const user = (role: Role, canViewCost: boolean): SessionUser => ({ id: "u", name: "U", username: "u", role, canViewCost });
const keys = (d: Dashboard) => [...d.kpis, ...d.today, ...d.current, ...d.performance].map((s) => s.key);
const hasProfit = (d: Dashboard) => keys(d).some((key) => /profit/i.test(key));

test("owner with cost access sees all 8 R1 numbers, profit included", () => {
  const d = loadDashboard(user("owner", true));
  expect(d.kpis.map((s) => s.key)).toEqual([
    "sales",
    "collection",
    "outstanding",
    "purchase",
    "expense",
    "profit",
    "cash",
    "bank",
  ]);
  expect(keys(d)).toContain("grossProfit");
});

test("no profit without can_view_cost, even for the owner or accountant", () => {
  expect(hasProfit(loadDashboard(user("owner", false)))).toBe(false);
  expect(hasProfit(loadDashboard(user("accountant", false)))).toBe(false);
  expect(hasProfit(loadDashboard(user("accountant", true)))).toBe(true);
});

test("sales sees only sales / outstanding / follow-ups — no profit, even with can_view_cost", () => {
  for (const canViewCost of [false, true]) {
    const d = loadDashboard(user("sales", canViewCost));
    expect(hasProfit(d)).toBe(false);
    expect(keys(d)).toEqual(["sales", "outstanding", "todaySales", "receivable", "monthlySales", "performanceOutstanding"]);
    expect(d.months.every((m) => m.collection === undefined && m.expense === undefined)).toBe(true);
    expect(d.followUps.length).toBeGreaterThan(0);
  }
});

test("production gets no dashboard", () => {
  expect(() => loadDashboard(user("production", false))).toThrow("Not allowed");
});
