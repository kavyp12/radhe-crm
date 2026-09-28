import { can, canViewCost, type SessionUser } from "@/lib/permissions";

// Owner dashboard (R1, S19). DUMMY numbers for the T04 look check; T30 replaces them with journal and document
// queries (A§12). Who sees what is decided here, on the server: owner / accountant everything (profit only with
// can_view_cost), sales only sales / outstanding / follow-ups, production nothing (the page sends them to /jobs).

export type Stat = { key: string; label: string; paise: bigint };
export type MonthPoint = { month: string; sales: bigint; collection?: bigint; expense?: bigint };
export type Ranked = { name: string; paise: bigint };
export type FollowUp = { customer: string; invoice: string; due: string; paise: bigint; note: string };

export type Dashboard = {
  kpis: Stat[]; // R1, this month / balances now
  today: Stat[]; // S19 Today
  current: Stat[]; // S19 Current
  performance: Stat[]; // S19 Performance
  months: MonthPoint[]; // monthly chart, FY so far
  topCustomers: Ranked[];
  topServices: Ranked[];
  followUps: FollowUp[];
};

const rs = (rupees: bigint) => rupees * 100n;

type Seen = "all" | "sales" | "cost";
const stat = (key: string, label: string, paise: bigint, seen: Seen) => ({ key, label, paise, seen });

// A§12: sales = taxable (excl. GST); cash = cash + petty cash; bank = bank 1 + bank 2 + UPI.
const KPIS = [
  stat("sales", "Sales", rs(845_600n), "sales"),
  stat("collection", "Collection", rs(712_300n), "all"),
  stat("outstanding", "Outstanding", rs(1_238_450n), "sales"),
  stat("purchase", "Purchase", rs(326_800n), "all"),
  stat("expense", "Expense", rs(148_900n), "all"),
  stat("profit", "Profit", rs(214_750n), "cost"),
  stat("cash", "Cash", rs(86_420n), "all"),
  stat("bank", "Bank", rs(954_310n), "all"),
];
const TODAY = [
  stat("todaySales", "Sales", rs(42_500n), "sales"),
  stat("todayCollection", "Collection", rs(38_000n), "all"),
  stat("todayPurchase", "Purchase", rs(12_400n), "all"),
  stat("todayExpense", "Expense", rs(3_850n), "all"),
];
const CURRENT = [
  stat("receivable", "Total receivable", rs(1_238_450n), "sales"),
  stat("payable", "Total payable", rs(412_600n), "all"),
  stat("cashBalance", "Cash balance", rs(86_420n), "all"),
  stat("bankBalance", "Bank balance", rs(954_310n), "all"),
];
const PERFORMANCE = [
  stat("monthlySales", "Monthly sales", rs(845_600n), "sales"),
  stat("monthlyCollection", "Monthly collection", rs(712_300n), "all"),
  stat("monthlyExpense", "Monthly expense", rs(148_900n), "all"),
  stat("grossProfit", "Gross profit", rs(305_200n), "cost"),
  stat("performanceOutstanding", "Outstanding", rs(1_238_450n), "sales"),
];
const MONTHS: Required<MonthPoint>[] = [
  { month: "Apr", sales: rs(612_400n), collection: rs(548_900n), expense: rs(132_600n) },
  { month: "May", sales: rs(701_800n), collection: rs(655_200n), expense: rs(141_300n) },
  { month: "Jun", sales: rs(583_100n), collection: rs(602_700n), expense: rs(127_800n) },
  { month: "Jul", sales: rs(768_900n), collection: rs(689_400n), expense: rs(152_100n) },
  { month: "Aug", sales: rs(912_300n), collection: rs(804_600n), expense: rs(160_400n) },
  { month: "Sep", sales: rs(845_600n), collection: rs(712_300n), expense: rs(148_900n) },
];
const TOP_CUSTOMERS: Ranked[] = [
  { name: "Shree Ganesh Traders", paise: rs(186_400n) },
  { name: "Om Sai Hospital", paise: rs(142_750n) },
  { name: "Patel Motors", paise: rs(118_200n) },
  { name: "Krishna Sweets", paise: rs(96_500n) },
  { name: "Ambica Textiles", paise: rs(74_300n) },
];
const TOP_SERVICES: Ranked[] = [
  { name: "LED Sign Board", paise: rs(254_800n) },
  { name: "ACP Elevation", paise: rs(198_300n) },
  { name: "Flex Banner", paise: rs(142_600n) },
  { name: "Acrylic Channel Letter", paise: rs(121_900n) },
  { name: "Vinyl Printing", paise: rs(68_400n) },
];
const FOLLOW_UPS: FollowUp[] = [
  { customer: "Om Sai Hospital", invoice: "RDS/26-27/0142", due: "2026-09-28", paise: rs(48_500n), note: "Promised by cheque today" },
  { customer: "Patel Motors", invoice: "RDS/26-27/0131", due: "2026-09-28", paise: rs(22_800n), note: "Call accounts after 4 pm" },
  { customer: "Krishna Sweets", invoice: "RDS/26-27/0118", due: "2026-09-29", paise: rs(15_600n), note: "Part payment on delivery" },
];

export function loadDashboard(user: SessionUser): Dashboard {
  const all = can(user, "reports", "view");
  if (!all && !can(user, "salesReports", "view")) throw new Error("Not allowed");
  const cost = all && canViewCost(user);
  const shown = (s: { seen: Seen }) => s.seen === "sales" || (s.seen === "all" && all) || (s.seen === "cost" && cost);
  const pick = (stats: (Stat & { seen: Seen })[]) => stats.filter(shown).map(({ key, label, paise }) => ({ key, label, paise }));

  return {
    kpis: pick(KPIS),
    today: pick(TODAY),
    current: pick(CURRENT),
    performance: pick(PERFORMANCE),
    months: all ? MONTHS : MONTHS.map(({ month, sales }) => ({ month, sales })),
    topCustomers: TOP_CUSTOMERS,
    topServices: TOP_SERVICES,
    followUps: FOLLOW_UPS,
  };
}
