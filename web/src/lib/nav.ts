import {
  Banknote,
  BookOpen,
  Briefcase,
  ChartColumn,
  ClipboardList,
  FileMinus,
  FileSpreadsheet,
  FileText,
  HandCoins,
  Landmark,
  LayoutDashboard,
  type LucideIcon,
  NotebookPen,
  Package,
  PackageCheck,
  PackageMinus,
  PhoneCall,
  Printer,
  Receipt,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  SquareCheckBig,
  Store,
  Tags,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import { can, type Area, type SessionUser } from "@/lib/permissions";

// The sidebar (DESIGN.md "Layout" + D35). URLs are final; modules not built yet land on the (app)/[...slug] page.

/** Remembers the collapsed desktop sidebar (read on the server, so no flash). */
export const SIDEBAR_COOKIE = "sidebar_collapsed";

/** Counts shown next to an item (placeholders until T07 / T29 fill them). */
export type NavCount = "approvals" | "followUps";
/** cost: the page shows purchase rates, so only can_view_cost users get the item (D52); the page checks it too. */
export type NavItem = { label: string; href: string; area: Area; icon: LucideIcon; count?: NavCount; cost?: true };
export type NavGroup = { label?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { items: [{ label: "Dashboard", href: "/", area: "salesReports", icon: LayoutDashboard }] },
  {
    label: "Sales",
    items: [
      { label: "Customers", href: "/customers", area: "customers", icon: Users },
      { label: "Quotations", href: "/quotations", area: "quotations", icon: FileText },
      { label: "Jobs", href: "/jobs", area: "jobs", icon: Briefcase },
      { label: "Invoices", href: "/invoices", area: "invoices", icon: Receipt },
      { label: "Credit/Debit Notes", href: "/credit-debit-notes", area: "invoices", icon: FileMinus },
      { label: "Print Jobs", href: "/print-jobs", area: "printJobs", icon: Printer },
      { label: "Follow-ups", href: "/follow-ups", area: "followUps", icon: PhoneCall, count: "followUps" },
    ],
  },
  {
    label: "Money",
    items: [
      { label: "Receipts", href: "/receipts", area: "payments", icon: HandCoins },
      { label: "Vendor Payments", href: "/vendor-payments", area: "payments", icon: Banknote },
      { label: "Expenses", href: "/expenses", area: "books", icon: Wallet },
      { label: "Cash & Bank", href: "/cash-bank", area: "books", icon: Landmark },
      { label: "Cash Book", href: "/cash-book", area: "books", icon: BookOpen },
      { label: "Journal Vouchers", href: "/journal-vouchers", area: "books", icon: NotebookPen }, // T24, D37
    ],
  },
  {
    label: "Purchase",
    items: [
      { label: "Vendors", href: "/vendors", area: "vendors", icon: Store },
      { label: "Material Requests", href: "/material-requests", area: "materialRequests", icon: ClipboardList },
      { label: "Purchase Orders", href: "/purchase-orders", area: "purchaseOrders", icon: ShoppingCart, cost: true },
      { label: "Material Receive", href: "/material-receive", area: "goodsReceipts", icon: PackageCheck, cost: true },
      { label: "Purchase Bills", href: "/purchase-bills", area: "books", icon: FileSpreadsheet, cost: true },
    ],
  },
  {
    label: "Stock",
    items: [
      { label: "Items", href: "/items", area: "stockItems", icon: Package },
      { label: "Issue to Job", href: "/issue-to-job", area: "stockIssue", icon: PackageMinus },
      { label: "Adjustments", href: "/stock-adjustments", area: "stockAdjustment", icon: SlidersHorizontal },
    ],
  },
  {
    items: [
      { label: "Reports", href: "/reports", area: "salesReports", icon: ChartColumn },
      { label: "Approvals", href: "/approvals", area: "approvals", icon: SquareCheckBig, count: "approvals" },
      { label: "Users", href: "/users", area: "users", icon: UserCog },
      { label: "Categories", href: "/categories", area: "categories", icon: Tags },
      { label: "Settings", href: "/settings", area: "settings", icon: Settings },
    ],
  },
];

/** The "+ New" menu: documents entered every day. */
export const NEW_MENU: { label: string; href: string; area: Area; cost?: true }[] = [
  { label: "Customer", href: "/customers/new", area: "customers" },
  { label: "Quotation", href: "/quotations/new", area: "quotations" },
  { label: "Job", href: "/jobs/new", area: "jobs" },
  { label: "Invoice", href: "/invoices/new", area: "invoices" },
  { label: "Receipt", href: "/receipts/new", area: "payments" },
  { label: "Follow-up", href: "/follow-ups/new", area: "followUps" },
  { label: "Expense", href: "/expenses/new", area: "books" },
  { label: "Purchase Bill", href: "/purchase-bills/new", area: "books", cost: true },
  { label: "Material Request", href: "/material-requests/new", area: "materialRequests" },
];

type NavUser = Pick<SessionUser, "role" | "canViewCost">;
const costOk = (user: NavUser, item: { cost?: true }) => !item.cost || user.canViewCost;

/** The sidebar for this user: only the areas their role can open (cost-only pages need can_view_cost), empty groups dropped. */
export function navFor(user: NavUser): NavGroup[] {
  return NAV.map((group) => ({ ...group, items: group.items.filter((item) => can(user, item.area) && costOk(user, item)) })).filter(
    (group) => group.items.length > 0,
  );
}

export function newMenuFor(user: NavUser) {
  return NEW_MENU.filter((item) => can(user, item.area, "create") && costOk(user, item));
}

/** The item a path belongs to: /quotations/new → Quotations. */
export function navItemFor(pathname: string): NavItem | undefined {
  const items = NAV.flatMap((group) => group.items);
  if (pathname === "/") return items[0];
  return items.find((item) => item.href !== "/" && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
}
