import { describe, expect, test } from "vitest";
import { can, canViewCost, PERMISSIONS, type Action, type Area, type Role } from "@/lib/permissions";

const as = (role: Role) => ({ role });
type Sample = [Area, Action?];

// A§8, a few allowed and denied samples per role.
const samples: Record<Role, { allowed: Sample[]; denied: Sample[] }> = {
  owner: {
    allowed: [["users", "create"], ["settings", "edit"], ["approvals", "approve"], ["jobs", "status"], ["reports"]],
    denied: [["customers", "approve"], ["invoices", "status"]],
  },
  accountant: {
    allowed: [["invoices", "cancel"], ["payments", "create"], ["books", "create"], ["reports", "view"], ["quotations", "view"], ["categories", "edit"], ["stockItems", "edit"]],
    denied: [["users"], ["settings"], ["approvals"], ["devices"], ["quotations", "create"], ["materialRequests", "approve"]],
  },
  sales: {
    allowed: [["customers", "edit"], ["quotations", "create"], ["jobs", "create"], ["followUps", "create"], ["invoices", "view"], ["salesReports", "view"]],
    denied: [["customers", "cancel"], ["invoices", "create"], ["payments"], ["vendors"], ["books"], ["reports"], ["users"], ["jobs", "status"], ["categories"], ["stockItems"]],
  },
  production: {
    allowed: [["jobs", "view"], ["jobs", "status"], ["stockIssue", "create"], ["materialRequests", "create"], ["printJobs", "view"], ["stockItems", "view"]],
    denied: [["jobs", "edit"], ["customers"], ["invoices"], ["payments"], ["books"], ["reports"], ["salesReports"], ["settings"], ["stockItems", "edit"], ["categories"]],
  },
};

describe.each(Object.entries(samples))("%s", (role, { allowed, denied }) => {
  test.each(allowed)("can %s %s", (area, action) => expect(can(as(role as Role), area, action)).toBe(true));
  test.each(denied)("cannot %s %s", (area, action) => expect(can(as(role as Role), area, action)).toBe(false));
});

test("production never sees money, in any area", () => {
  for (const area of Object.keys(PERMISSIONS) as Area[]) expect(can(as("production"), area, "money")).toBe(false);
});

test("accountant can't open users or settings", () => {
  expect(can(as("accountant"), "users")).toBe(false);
  expect(can(as("accountant"), "settings")).toBe(false);
});

test("cost visibility is the per-user flag", () => {
  expect(canViewCost({ canViewCost: true })).toBe(true);
  expect(canViewCost({ canViewCost: false })).toBe(false);
});
