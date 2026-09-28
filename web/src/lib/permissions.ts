// Who may do what (ARCHITECTURE §8). Plain data + helpers, safe to import in client components.
// Hiding a menu item is not security: pages, server actions and route handlers check can() on the server.

export const ROLES = ["owner", "accountant", "sales", "production"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  accountant: "Accountant",
  sales: "Sales",
  production: "Production",
};

/** can_view_cost for a new user of this role; the owner can change it per user (A§8). */
export const DEFAULT_CAN_VIEW_COST: Record<Role, boolean> = {
  owner: true,
  accountant: true,
  sales: false,
  production: false,
};

/** The signed-in user as the app sees it (lib/auth.ts). */
export type SessionUser = { id: string; name: string; username: string; role: Role; canViewCost: boolean };

// cancel = cancel / deactivate (nothing is ever deleted, hard rule 3) · status = job status changes only
// money = may see amounts in this area (production never does)
export type Action = "view" | "create" | "edit" | "cancel" | "approve" | "status" | "money";

const FULL: Action[] = ["view", "create", "edit", "cancel", "money"];
const VIEW: Action[] = ["view", "money"];

// One entry per A§8 row; a missing role = no access. "Via approval" in A§8: the action is allowed here and
// T07's approval helper turns a non-owner's attempt into a request (A§7).
export const PERMISSIONS = {
  customers: { owner: FULL, accountant: FULL, sales: ["view", "create", "edit", "money"] },
  vendors: { owner: FULL, accountant: FULL },
  quotations: { owner: FULL, accountant: VIEW, sales: FULL },
  jobs: {
    owner: [...FULL, "status"],
    accountant: VIEW,
    sales: ["view", "create", "money"],
    production: ["view", "status"],
  },
  invoices: { owner: FULL, accountant: FULL, sales: VIEW }, // + credit / debit notes (accountant's CN via approval)
  payments: { owner: FULL, accountant: FULL }, // receipts + vendor payments
  followUps: { owner: FULL, accountant: FULL, sales: FULL },
  books: { owner: FULL, accountant: FULL }, // purchase bills, expenses, cash & bank, JV (accountant's JV via approval)
  materialRequests: {
    owner: [...FULL, "approve"],
    accountant: ["view", "create", "money"],
    production: ["view", "create"],
  },
  stockIssue: { owner: FULL, accountant: FULL, production: ["create"] }, // production: qty only
  stockAdjustment: { owner: FULL, accountant: ["create"] }, // accountant's "request" = create via approval
  printJobs: { owner: FULL, accountant: FULL, sales: VIEW, production: ["view"] },
  reports: { owner: VIEW, accountant: VIEW }, // dashboard & reports: all
  salesReports: { owner: VIEW, accountant: VIEW, sales: VIEW }, // dashboard & reports: sales / outstanding / follow-ups
  settings: { owner: FULL },
  users: { owner: FULL },
  approvals: { owner: ["view", "approve"] },
  devices: { owner: FULL },
  // D36: areas A§8 doesn't list.
  purchaseOrders: { owner: FULL, accountant: FULL },
  goodsReceipts: { owner: FULL, accountant: FULL },
  stockItems: { owner: FULL, accountant: FULL, production: ["view"] }, // production: items without any values
  categories: { owner: FULL, accountant: FULL }, // product + expense categories
  openingBalances: { owner: FULL, accountant: FULL }, // D40: they post to the journal
} satisfies Record<string, Partial<Record<Role, Action[]>>>;

export type Area = keyof typeof PERMISSIONS;

/** Without an action: any access at all (e.g. to show the area's menu item). */
export function can(user: Pick<SessionUser, "role">, area: Area, action?: Action): boolean {
  const granted = (PERMISSIONS[area] as Partial<Record<Role, Action[]>>)[user.role];
  return !!granted && (!action || granted.includes(action));
}

/** Cost, profit and purchase rates (per-user flag). Loaders strip those fields when this is false. */
export const canViewCost = (user: Pick<SessionUser, "canViewCost">): boolean => user.canViewCost;
