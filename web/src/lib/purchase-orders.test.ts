import { mkdir, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { GET as shareRoute } from "@/app/share/[token]/route";
import { db } from "@/db";
import { expenseCategories, vendors } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { formatDate, todayIST } from "@/lib/dates";
import { gstinCheckChar } from "@/lib/gstin";
import { cancelRequest, createRequest, decideRequest, getRequest, pendingRequestCount, type RequestInput } from "@/lib/material-requests";
import { purchaseOrderPdf } from "@/lib/pdf";
import { can, type Role, type SessionUser } from "@/lib/permissions";
import { createPurchaseBill } from "@/lib/purchase-bills";
import {
  cancelOrder,
  createOrder,
  getOrder,
  linesFromRequests,
  markOrderSent,
  ordersForRequest,
  updateOrder,
  type OrderInput,
} from "@/lib/purchase-orders";
import type { OrderLineText } from "@/lib/purchase-lines";
import { saveBooks } from "@/lib/settings";
import { createItem } from "@/lib/stock";
import { createUser } from "@/lib/users";
import { createVendor } from "@/lib/vendors";

// T22 (S18, A§8, D36, D53): material requests (production asks, only the owner decides, the maker cancels while
// pending) → purchase orders copied from approved requests (the request → Ordered), totals as for bills, PO PDF.

let owner: SessionUser;
let accountant: SessionUser;
let production: SessionUser;
let other: SessionUser; // another production user
let local: number; // Gujarat, registered → CGST + SGST
let outside: number; // Maharashtra → IGST
let sheet: number;
let led: number;
const today = todayIST();
const withCheck = (first14: string) => first14 + gstinCheckChar(first14);

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role, username: string, canViewCost: boolean) => {
    const user = { name: `PO ${username}`, username: `po.${username}`, role, canViewCost };
    return { ...user, id: await createUser(owner, { ...user, password: `${username}-pass-123` }) };
  };
  accountant = await staff("accountant", "accountant", true);
  production = await staff("production", "production", false);
  other = await staff("production", "other", false);
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  const vendor = (name: string, gstin: string, stateCode: string, email = "") =>
    createVendor(owner, { name, gstin, stateCode, mobile: "9825012345", email, address: "GIDC, Vatva", creditDays: "", notes: "" });
  local = await vendor("PO Acrylic House", withCheck("24AAAPA1234Q1Z"), "24", "orders@acrylic.example");
  outside = await vendor("PO Mumbai LED", withCheck("27AAAPL1234Q1Z"), "27");
  const [c] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Acrylic"));
  const item = (name: string, gst: string) => createItem(owner, { name, unit: "Sheet", categoryId: String(c.id), hsnSac: "3920", gstPercent: gst });
  sheet = await item("PO acrylic sheet", "18");
  led = await item("PO LED module", "12");
  // The last purchase rate of the sheet: ₹123.45 (the later of two bills).
  for (const [no, rate] of [["PO-B1", "110"], ["PO-B2", "123.45"]]) {
    await createPurchaseBill(owner, {
      vendorId: String(local), vendorBillNo: no, date: formatDate(today), roundOff: "", notes: "",
      lines: JSON.stringify([{ what: `item:${sheet}`, description: "", qty: "1", rate, gst: "18", jobId: "" }]),
    });
  }
});

const request = (lines: [number, string][], neededBy = today): RequestInput => ({
  neededBy: formatDate(neededBy),
  jobId: "",
  notes: "For the Navrangpura signboard",
  lines: JSON.stringify(lines.map(([itemId, qty]) => ({ itemId: String(itemId), qty }))),
});
const order = (vendorId: number, lines: OrderLineText[]): OrderInput => ({ vendorId: String(vendorId), date: formatDate(today), notes: "", lines: JSON.stringify(lines) });
const line = (itemId: number, qty: string, rate: string, gst: string, requestLineId = ""): OrderLineText => ({ itemId: String(itemId), description: "", qty, rate, gst, requestLineId });

test("production raises a request but can't approve it or open orders; only its maker cancels it while pending", async () => {
  const before = await pendingRequestCount();
  const { id, number } = await createRequest(production, request([[sheet, "10"], [led, "25"]]));
  expect(number).toMatch(/^MR\/26-27\/\d{4}$/);
  expect(await pendingRequestCount()).toBe(before + 1);
  const r = (await getRequest(id))!;
  expect(r).toMatchObject({ status: "pending", neededBy: today, requestedBy: "PO production" });
  expect(r.lines.map((l) => [l.name, l.qty])).toEqual([["PO acrylic sheet", 10_000n], ["PO LED module", 25_000n]]);

  await expect(decideRequest(production, id, "approve", "")).rejects.toThrow("Not allowed");
  await expect(decideRequest(accountant, id, "approve", "")).rejects.toThrow("Not allowed"); // only the owner (D53)
  expect(can(production, "purchaseOrders")).toBe(false);
  await expect(createOrder(production, order(local, [line(sheet, "1", "100", "18")]))).rejects.toThrow("Not allowed");
  await expect(cancelRequest(other, id)).rejects.toThrow("Only the person who asked for it can cancel it.");
  expect(await cancelRequest(production, id)).toEqual({ message: `Cancelled ${number}.` });
  await expect(decideRequest(owner, id, "approve", "")).rejects.toThrow(`${number} is already cancelled.`);
  expect(await pendingRequestCount()).toBe(before);
});

test("the owner approves → an order copies its lines (rate = the last purchase rate, qty editable) and the request is Ordered", async () => {
  const { id, number } = await createRequest(production, request([[sheet, "10"], [led, "25"]]));
  expect(await decideRequest(owner, id, "approve", "Buy from the usual vendor")).toEqual({ message: `Approved ${number}.` });
  await expect(cancelRequest(production, id)).rejects.toThrow("is already approved");
  const copied = await linesFromRequests([id]);
  expect(copied.requests).toEqual([{ id, number }]);
  expect(copied.lines.map((l) => [l.itemId, l.qty, l.rate, l.gst])).toEqual([
    [String(sheet), "10", "123.45", "18"],
    [String(led), "25", "", "12"], // never bought: no rate yet
  ]);
  const lines = [{ ...copied.lines[0], qty: "12" }, { ...copied.lines[1], rate: "80" }];
  const po = await createOrder(accountant, order(local, lines));
  expect(po.number).toMatch(/^PO\/26-27\/\d{4}$/);
  const o = (await getOrder(po.id))!;
  expect(o.status).toBe("draft");
  expect(o.lines.map((l) => [l.name, l.qtyMilli, l.ratePaise, l.gstBp, l.request])).toEqual([
    ["PO acrylic sheet", 12_000n, 123_45n, 1800, number],
    ["PO LED module", 25_000n, 80_00n, 1200, number],
  ]);
  expect(o.requests).toEqual([{ id, number }]);
  expect((await getRequest(id))!.status).toBe("ordered");
  expect(await ordersForRequest(id)).toEqual([{ id: po.id, number: po.number, status: "draft" }]);
  // Ordered once: a second order from it is refused.
  await expect(createOrder(owner, order(local, [copied.lines[0]]))).rejects.toThrow(`${number} is ordered: only approved requests can be ordered.`);
  await expect(createOrder(owner, order(local, [{ ...copied.lines[0], itemId: String(led) }]))).rejects.toThrow(`the item must stay as requested on ${number}`);

  // Sent → an edit takes it back to Draft; the request stays Ordered while a line of it is on the order.
  expect(await markOrderSent(owner, po.id)).toEqual({ message: "Marked as sent." });
  await expect(markOrderSent(owner, po.id)).rejects.toThrow("is already sent");
  await updateOrder(owner, po.id, order(local, [lines[0]]));
  expect((await getOrder(po.id))!).toMatchObject({ status: "draft", lines: [{ qtyMilli: 12_000n }] });
  expect((await getRequest(id))!.status).toBe("ordered");
  // Cancelled: the request can be ordered again.
  await cancelOrder(owner, po.id);
  expect((await getRequest(id))!.status).toBe("approved");
  await expect(updateOrder(owner, po.id, order(local, [lines[0]]))).rejects.toThrow("is cancelled");
  await createOrder(owner, order(outside, lines));
  expect((await getRequest(id))!.status).toBe("ordered");
});

test("a rejected request can't be ordered", async () => {
  const { id, number } = await createRequest(accountant, request([[sheet, "3"]]));
  await decideRequest(owner, id, "reject", "We have enough in stock");
  expect((await getRequest(id))!).toMatchObject({ status: "rejected", decisionNote: "We have enough in stock", decidedByName: "Owner" });
  expect((await linesFromRequests([id])).lines).toEqual([]);
  const [rl] = (await getRequest(id))!.lines;
  await expect(createOrder(owner, order(local, [line(sheet, "3", "120", "18", String(rl.id))]))).rejects.toThrow(
    `${number} is rejected: only approved requests can be ordered.`,
  );
});

test("totals as for bills: same state CGST + SGST, other state IGST, round-off to the rupee; the PO PDF + share link", async () => {
  // 10 × ₹123.45 = ₹1,234.50 at 18%: CGST = SGST = ₹111.11 (half-up) → ₹1,456.72 → round-off +₹0.28.
  const same = await createOrder(owner, order(local, [line(sheet, "10", "123.45", "18")]));
  expect((await getOrder(same.id))!).toMatchObject({
    mode: "same_state",
    totalPaise: 1457_00n,
    totals: { taxable: 1234_50n, cgst: 111_11n, sgst: 111_11n, igst: 0n, roundOff: 28n, total: 1457_00n },
  });
  // Other state: IGST ₹222.21 → ₹1,456.71 → +₹0.29.
  const other = await createOrder(owner, order(outside, [line(sheet, "10", "123.45", "18")]));
  expect((await getOrder(other.id))!).toMatchObject({
    mode: "other_state",
    totals: { taxable: 1234_50n, cgst: 0n, sgst: 0n, igst: 222_21n, roundOff: 29n, total: 1457_00n },
  });

  await markOrderSent(owner, same.id);
  const pdf = (await purchaseOrderPdf(same.id))!;
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.fileName).toBe(`${same.number.replaceAll("/", "-")}.pdf`);
  await mkdir(".samples", { recursive: true });
  await writeFile(".samples/purchase-order.pdf", pdf.bytes);
  const { shareToken } = (await getOrder(same.id))!;
  const res = await shareRoute(new Request(`http://x/share/${shareToken}`), { params: Promise.resolve({ token: shareToken }) });
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/pdf"]);
  // Vendors have an optional email (where the PO is emailed).
  expect((await db.select().from(vendors).where(eq(vendors.id, local)))[0].email).toBe("orders@acrylic.example");
  await expect(
    createVendor(owner, { name: "PO bad email", gstin: "", stateCode: "24", mobile: "", email: "not-an-email", address: "", creditDays: "", notes: "" }),
  ).rejects.toThrow("Enter a valid email.");
}, 30_000);
