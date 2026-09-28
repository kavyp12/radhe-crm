import { expect, test } from "vitest";
import { navFor, navItemFor, newMenuFor } from "@/lib/nav";
import type { Role } from "@/lib/permissions";

const labels = (role: Role) => navFor({ role }).flatMap((group) => group.items.map((item) => item.label));

test("owner sees every item", () => {
  expect(labels("owner")).toHaveLength(26);
  expect(labels("owner")).toEqual(expect.arrayContaining(["Users", "Categories", "Settings", "Approvals", "Cash Book"]));
});

test("accountant: money, purchase and stock, but no users / settings / approvals", () => {
  const items = labels("accountant");
  expect(items).toEqual(
    expect.arrayContaining(["Invoices", "Receipts", "Cash & Bank", "Purchase Bills", "Reports", "Categories"]),
  );
  for (const hidden of ["Users", "Settings", "Approvals"]) expect(items).not.toContain(hidden);
});

test("sales: customers, quotations, jobs, invoices, follow-ups, reports — no money or purchase", () => {
  expect(labels("sales")).toEqual([
    "Dashboard",
    "Customers",
    "Quotations",
    "Jobs",
    "Invoices",
    "Credit/Debit Notes",
    "Print Jobs",
    "Follow-ups",
    "Reports",
  ]);
});

test("production: jobs and shop-floor stock only, no dashboard", () => {
  expect(labels("production")).toEqual(["Jobs", "Print Jobs", "Material Requests", "Items", "Issue to Job"]); // items: view only (D36)
  expect(navFor({ role: "production" }).map((group) => group.label)).toEqual(["Sales", "Purchase", "Stock"]);
});

test("+ New lists only what the role may create", () => {
  expect(newMenuFor({ role: "sales" }).map((item) => item.label)).toEqual([
    "Customer",
    "Quotation",
    "Job",
    "Follow-up",
  ]);
  expect(newMenuFor({ role: "production" }).map((item) => item.label)).toEqual(["Material Request"]);
});

test("a path maps to its module", () => {
  expect(navItemFor("/")?.label).toBe("Dashboard");
  expect(navItemFor("/quotations/new")?.label).toBe("Quotations");
  expect(navItemFor("/purchase-bills")?.label).toBe("Purchase Bills");
  expect(navItemFor("/nope")).toBeUndefined();
});
