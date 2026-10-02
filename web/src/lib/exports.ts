import { listCustomers } from "@/lib/customers";
import { journalReport } from "@/lib/data-export";
import { listExpenses } from "@/lib/expenses";
import { INVOICE_KIND, INVOICE_STATUS, listInvoices } from "@/lib/invoices";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { printPendingReport } from "@/lib/print-jobs";
import { listPurchaseBills } from "@/lib/purchase-bills";
import { RECEIPT_MODE } from "@/lib/receipt-modes";
import { listReceipts } from "@/lib/receipts";
import type { Report, ReportColumn, ReportRow } from "@/lib/report";
import { collectionReport, type ReportQuery, type ReportResult } from "@/lib/reports";
import {
  bankBookReport,
  cashBookReport,
  customerLedgerReport,
  expenseReport,
  purchaseReport,
  stockValuationReport,
  vendorLedgerReport,
} from "@/lib/reports-books";
import { gstReport, jobProfitReport, productReport, profitReport } from "@/lib/reports-profit";
import {
  advanceReport,
  collectionPersonReport,
  outstandingReport,
  pendingPaymentReport,
  salesPersonReport,
  salesReport,
} from "@/lib/reports-sales";
import { listItems } from "@/lib/stock";
import { listVendors } from "@/lib/vendors";

// What /export/<name> can download (S27, D59): the reports and the main lists. Each goes through the same loader and
// permission as its page, so a user gets exactly the rows and columns they see there — cost columns only with
// can_view_cost (hard rule 5). null = not allowed. Lists export every row (the page's filters run in the browser).

/** The S20 reports by their /reports/<name> (REPORT_INDEX): the page and the export both load through here. */
export const REPORTS: Record<string, (user: SessionUser, q: ReportQuery) => Promise<ReportResult | null>> = {
  sales: salesReport,
  collection: collectionReport,
  outstanding: outstandingReport,
  "sales-person": salesPersonReport,
  "collection-person": collectionPersonReport,
  "pending-payment": pendingPaymentReport,
  advances: advanceReport,
  "customer-ledger": customerLedgerReport,
  "vendor-ledger": vendorLedgerReport,
  purchase: purchaseReport,
  expense: expenseReport,
  "cash-book": cashBookReport,
  "bank-book": bankBookReport,
  "stock-valuation": stockValuationReport,
  profit: profitReport,
  "job-profit": jobProfitReport,
  "product-sales": productReport,
  "gst-summary": gstReport,
  journal: journalReport,
  "print-pending": printPendingReport,
};
/** The loader of /reports/<name>, or undefined (own keys only: "constructor" is not a report). */
export const reportLoader = (name: string) => (Object.hasOwn(REPORTS, name) ? REPORTS[name] : undefined);

type Exporter = (user: SessionUser, q: ReportQuery) => Promise<Report | null>;

const list = (title: string, columns: ReportColumn[], rows: ReportRow[]): Report => ({
  title,
  filters: ["All entries"],
  generatedAt: new Date(),
  tables: [{ columns, rows }],
});
const party = (name: string, firm: string | null) => (firm ? `${name} · ${firm}` : name);
const money = (key: string, label: string): ReportColumn => ({ key, label, type: "money", total: true });

export const EXPORTS: Record<string, Exporter> = {
  ...Object.fromEntries(Object.entries(REPORTS).map(([name, load]): [string, Exporter] => [name, async (user, q) => (await load(user, q))?.report ?? null])),

  invoices: async (user) => {
    if (!can(user, "invoices", "view")) return null;
    const rows = await listInvoices();
    return list(
      "Invoices",
      [
        { key: "number", label: "Number" },
        { key: "kind", label: "Kind" },
        { key: "date", label: "Date", type: "date" },
        { key: "customer", label: "Customer" },
        { key: "status", label: "Status" },
        { key: "payment", label: "Payment" },
        { key: "dueDate", label: "Due", type: "date" },
        money("total", "Total"),
        money("open", "Open"),
      ],
      rows.map((r) => ({
        number: r.number ?? "Draft",
        kind: INVOICE_KIND[r.kind],
        date: r.date,
        customer: party(r.customer, r.firmName),
        status: INVOICE_STATUS[r.status],
        payment: r.payment,
        dueDate: r.dueDate,
        total: r.total,
        open: r.open,
      })),
    );
  },

  receipts: async (user) => {
    if (!can(user, "payments", "view")) return null;
    const rows = await listReceipts();
    return list(
      "Receipts",
      [
        { key: "number", label: "Number" },
        { key: "date", label: "Date", type: "date" },
        { key: "customer", label: "Customer" },
        { key: "mode", label: "Mode" },
        { key: "status", label: "Status" },
        money("amount", "Amount"),
        money("allocated", "Allocated"),
        money("onAccount", "On account"),
      ],
      rows.map((r) => ({
        number: r.number,
        date: r.date,
        customer: party(r.customer, r.firmName),
        mode: RECEIPT_MODE[r.mode],
        status: r.status === "cancelled" ? "Cancelled" : "Active",
        amount: r.amount,
        allocated: r.allocated,
        onAccount: r.onAccount,
      })),
    );
  },

  customers: async (user) => {
    if (!can(user, "customers", "view")) return null;
    const rows = await listCustomers();
    return list(
      "Customers",
      [
        { key: "name", label: "Name" },
        { key: "firmName", label: "Firm" },
        { key: "mobile", label: "Mobile" },
        { key: "gstin", label: "GSTIN" },
        money("outstanding", "Outstanding"),
      ],
      rows.map((r) => ({ name: r.name, firmName: r.firmName, mobile: r.mobile, gstin: r.gstin, outstanding: r.outstanding })),
    );
  },

  vendors: async (user) => {
    if (!can(user, "vendors", "view")) return null;
    const rows = await listVendors();
    return list(
      "Vendors",
      [{ key: "name", label: "Name" }, { key: "mobile", label: "Mobile" }, { key: "gstin", label: "GSTIN" }, money("outstanding", "We owe")],
      rows.map((r) => ({ name: r.name, mobile: r.mobile, gstin: r.gstin, outstanding: r.outstanding })),
    );
  },

  // Purchase rates: the whole list needs can_view_cost (D51), as its page does.
  "purchase-bills": async (user) => {
    if (!can(user, "books", "view") || !canViewCost(user)) return null;
    const rows = await listPurchaseBills();
    return list(
      "Purchase bills",
      [
        { key: "number", label: "Number" },
        { key: "vendorBillNo", label: "Vendor bill no" },
        { key: "date", label: "Bill date", type: "date" },
        { key: "vendor", label: "Vendor" },
        { key: "dueDate", label: "Due", type: "date" },
        { key: "payment", label: "Payment" },
        money("total", "Total"),
        money("open", "Open"),
      ],
      rows.map((r) => ({
        number: r.number,
        vendorBillNo: r.vendorBillNo,
        date: r.date,
        vendor: r.vendor,
        dueDate: r.dueDate,
        payment: r.payment,
        total: r.total,
        open: r.open,
      })),
    );
  },

  expenses: async (user) => {
    if (!can(user, "books", "view")) return null;
    const rows = await listExpenses();
    return list(
      "Expenses",
      [
        { key: "number", label: "Number" },
        { key: "date", label: "Date", type: "date" },
        { key: "category", label: "Category" },
        { key: "vendor", label: "Vendor" },
        { key: "job", label: "Job" },
        { key: "account", label: "Paid from" },
        { key: "status", label: "Status" },
        money("amount", "Amount"),
      ],
      rows.map((r) => ({
        number: r.number,
        date: r.date,
        category: r.category,
        vendor: r.vendor,
        job: r.job,
        account: r.account,
        status: r.status === "cancelled" ? "Cancelled" : "Active",
        amount: r.amount,
      })),
    );
  },

  // Stock value and average cost only come back from listItems for can_view_cost users.
  items: async (user) => {
    if (!can(user, "stockItems", "view")) return null;
    const rows = await listItems(user);
    const cost = canViewCost(user); // the same rule listItems strips by
    return list(
      "Items",
      [
        { key: "name", label: "Item" },
        { key: "category", label: "Category" },
        { key: "qty", label: "In stock", type: "qty" },
        { key: "unit", label: "Unit" },
        { key: "status", label: "Status" },
        ...(cost ? [{ key: "average", label: "Average cost", type: "money" } as const, money("value", "Stock value")] : []),
      ],
      rows.map((r) => ({
        name: r.name,
        category: r.category,
        qty: r.qty,
        unit: r.unit,
        status: r.active ? "Active" : "Inactive",
        ...("cost" in r ? { average: r.cost.average, value: r.cost.value } : {}),
      })),
    );
  },
};
