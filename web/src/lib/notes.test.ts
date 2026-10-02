import { mkdir, writeFile } from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { GET as shareRoute } from "@/app/share/[token]/route";
import { db } from "@/db";
import { accounts, allocations, approvalRequests, journalEntries, journalLines } from "@/db/schema";
import { testOwner } from "@/db/test-owner";
import { openInvoices } from "@/lib/allocations";
import { approve, SENT_FOR_APPROVAL } from "@/lib/approvals";
import { customerAdvance } from "@/lib/customer-history";
import { createCustomer, type CustomerInput } from "@/lib/customers";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { cancelInvoice, createInvoice, getInvoice, issueInvoice } from "@/lib/invoices";
import { ledger } from "@/lib/ledger";
import type { LineText } from "@/lib/lines";
import { cancelNote, createNote, getNote, invoiceLinesLeft, issueNote, updateNote, type NoteKind } from "@/lib/notes";
import { notePdf } from "@/lib/pdf";
import type { Role, SessionUser } from "@/lib/permissions";
import { createReceipt } from "@/lib/receipts";
import { saveBooks } from "@/lib/settings";
import { createUser } from "@/lib/users";

let owner: SessionUser;
let accountant: SessionUser;
let categoryId: string;
let cashId: string;
let local: number; // Gujarat: CGST + SGST
let outside: number; // Maharashtra: IGST
const today = todayIST();

const customer = (patch: Partial<CustomerInput>): CustomerInput => ({
  name: "",
  firmName: "",
  mobile: "",
  email: "",
  gstin: "",
  stateCode: "24",
  billingAddress: "",
  siteAddress: "",
  creditLimit: "",
  creditDays: "",
  isCreditCustomer: false,
  salesPersonId: "",
  collectionPersonId: "",
  notes: "",
  ...patch,
});

beforeAll(async () => {
  owner = await testOwner();
  const staff = async (role: Role) => {
    const user = { name: `Notes ${role}`, username: `notes.${role}`, role, canViewCost: true };
    return { ...user, id: await createUser(owner, { ...user, password: `${role}-pass-123` }) };
  };
  accountant = await staff("accountant");
  await saveBooks(owner, { booksStartDate: "01/04/2026", accounts: [] });
  categoryId = String((await db.query.productCategories.findFirst())!.id);
  cashId = String((await db.query.accounts.findFirst({ where: eq(accounts.systemKey, "cash") }))!.id);
  local = await createCustomer(owner, customer({ name: "Notes Local", billingAddress: "C.G. Road, Ahmedabad", creditDays: "10" }));
  outside = await createCustomer(owner, customer({ name: "Notes Pune", gstin: "27ABCDE1234F1Z0", stateCode: "27" }));
});

/** An issued tax invoice: 2 Nos × ₹500 at 18% = ₹1,000 taxable, ₹1,180 total. */
async function invoice(customerId: number) {
  const line: LineText = {
    lineId: "",
    categoryId,
    description: "Acrylic letters",
    hsnSac: "9405",
    width: "4",
    height: "2",
    qty: "2",
    unit: "Nos",
    rate: "500",
    discount: "",
    gst: "18",
  };
  const id = await createInvoice(owner, {
    kind: "tax",
    customerId: String(customerId),
    date: formatDate(today),
    terms: "",
    notes: "",
    lines: JSON.stringify([line]),
  });
  await issueInvoice(owner, id);
  return id;
}

async function draft(actor: SessionUser, kind: NoteKind, invoiceId: number, qty: string, amount: string, reason = "One letter returned") {
  const [line] = await invoiceLinesLeft(db, kind, invoiceId);
  return createNote(actor, kind, invoiceId, {
    date: formatDate(today),
    reason,
    notes: "",
    lines: JSON.stringify([{ invoiceLineId: String(line.id), qty, amount }]),
  });
}

/** The note's journal lines, net per account key (+Dr / −Cr). */
async function posted(docType: "credit_notes" | "debit_notes", id: number) {
  const rows = await db
    .select({ key: accounts.systemKey, debit: journalLines.debitPaise, credit: journalLines.creditPaise, customerId: journalLines.customerId, date: journalEntries.date })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.docType, docType), eq(journalEntries.docId, id)))
    .orderBy(asc(journalLines.id));
  const net: Record<string, bigint> = {};
  for (const r of rows) net[r.key!] = (net[r.key!] ?? 0n) + r.debit - r.credit;
  return { rows, net };
}

test("a credit note reduces the invoice's open amount and the output GST (Dr sales returns + GST / Cr AR)", async () => {
  const inv = await invoice(local);
  const id = await draft(owner, "credit", inv, "1", "500");
  expect((await getNote("credit", id))!).toMatchObject({ number: null, status: "draft", totalPaise: 590_00n });
  expect((await posted("credit_notes", id)).rows).toEqual([]); // drafts post nothing

  expect((await issueNote(owner, "credit", id)).message).toMatch(/^Issued CN\/26-27\/\d{4}\.$/);
  const note = (await getNote("credit", id))!;
  expect(note.number).toMatch(/^CN\/26-27\/\d{4}$/);
  // ₹500 at 18% same state: CGST ₹45 + SGST ₹45 = ₹590, no round-off.
  const { rows, net } = await posted("credit_notes", id);
  expect(net).toEqual({ sales_returns: 500_00n, gst_out_cgst: 45_00n, gst_out_sgst: 45_00n, ar: -590_00n });
  expect(rows.find((r) => r.key === "ar")?.customerId).toBe(local);
  // It pays its invoice: open ₹1,180 → ₹590.
  expect((await getInvoice(inv))!).toMatchObject({ open: 590_00n, payment: "Part Payment" });
  expect(note).toMatchObject({ paid: 590_00n, open: 0n });
  // Output CGST for invoice + note: −₹90 + ₹45 = −₹45 (Cr).
  const gst = (await posted("credit_notes", id)).net.gst_out_cgst + -90_00n;
  expect(gst).toBe(-45_00n);
  // An invoice with a credit note in force can't be cancelled until the note is.
  await expect(cancelInvoice(owner, inv, "")).rejects.toThrow(`Cancel ${note.number} first`);
});

test("a debit note increases them (Dr AR / Cr sales + IGST) and is a receivable receipts can pay", async () => {
  const inv = await invoice(outside);
  const id = await draft(owner, "debit", inv, "", "200", "Rate revised upwards");
  await issueNote(owner, "debit", id);
  const note = (await getNote("debit", id))!;
  expect(note.number).toMatch(/^DN\/26-27\/\d{4}$/);
  expect((await posted("debit_notes", id)).net).toEqual({ ar: 236_00n, sales: -200_00n, gst_out_igst: -36_00n });
  expect(note).toMatchObject({ totalPaise: 236_00n, open: 236_00n, payment: "Unpaid", dueDate: today });
  expect((await ledger({ account: "ar", customerId: outside })).closing).toBe(1180_00n + 236_00n);

  // The allocation panel offers it with the invoice; a receipt pays it.
  expect((await openInvoices(db, outside)).map((o) => [o.target, o.id, o.open])).toEqual([
    ["invoice", inv, 1180_00n],
    ["debit_note", id, 236_00n],
  ]);
  await createReceipt(owner, {
    customerId: String(outside),
    date: formatDate(today),
    amount: "236",
    mode: "cash",
    moneyAccountId: cashId,
    reference: "",
    chequeNo: "",
    chequeDate: "",
    receivedBy: "",
    notes: "",
    allocations: JSON.stringify([{ target: "debit_note", id: String(id), amount: "236" }]),
  });
  expect((await getNote("debit", id))!).toMatchObject({ open: 0n, payment: "Paid" });
});

test("a note can't take more than the invoice line has left after earlier notes (qty and amount)", async () => {
  const inv = await invoice(local);
  const first = await draft(owner, "credit", inv, "1", "600");
  await issueNote(owner, "credit", first);
  await expect(draft(owner, "credit", inv, "", "500")).rejects.toThrow("₹500.00 is more than the ₹400.00 left on it");
  await expect(draft(owner, "credit", inv, "2", "100")).rejects.toThrow("qty 2 is more than the 1 Nos left");
  // Two drafts can each ask for what is left; the second is refused at Issue.
  const a = await draft(owner, "credit", inv, "", "400");
  const b = await draft(owner, "credit", inv, "", "400");
  await issueNote(owner, "credit", a);
  await expect(issueNote(owner, "credit", b)).rejects.toThrow("more than the ₹0.00 left");
  // Debit notes count against earlier debit notes only.
  expect((await invoiceLinesLeft(db, "debit", inv))[0].taxableLeft).toBe(1000_00n);
  // An edited draft is checked the same way; no note on a draft invoice.
  await expect(updateNote(owner, "credit", b, { date: formatDate(today), reason: "x", notes: "", lines: "[]" })).rejects.toThrow("Enter an amount");
  const draftInvoice = await createInvoice(owner, { kind: "tax", customerId: String(local), date: formatDate(today), terms: "", notes: "", lines: JSON.stringify([{ lineId: "", categoryId, description: "", hsnSac: "", width: "", height: "", qty: "1", unit: "Nos", rate: "100", discount: "", gst: "" }]) });
  await expect(createNote(owner, "credit", draftInvoice, { date: formatDate(today), reason: "x", notes: "", lines: "[]" })).rejects.toThrow("Only an issued invoice");
});

test("a debit note has no cap (D50): more than the invoice line, and again after that", async () => {
  const inv = await invoice(outside);
  const first = await draft(owner, "debit", inv, "3", "1,500", "Extra letters supplied");
  await issueNote(owner, "debit", first);
  const second = await draft(owner, "debit", inv, "", "2,000", "Rate revised");
  await issueNote(owner, "debit", second);
  expect((await getNote("debit", first))!).toMatchObject({ status: "issued", totalPaise: 1770_00n }); // ₹1,500 + 18% IGST
  expect((await getNote("debit", second))!).toMatchObject({ status: "issued", totalPaise: 2360_00n });
});

test("a non-owner's credit note becomes an approval request and posts nothing; approval issues it", async () => {
  const inv = await invoice(local);
  const id = await draft(accountant, "credit", inv, "", "100");
  expect((await issueNote(accountant, "credit", id)).message).toBe(SENT_FOR_APPROVAL);
  expect((await getNote("credit", id))!).toMatchObject({ status: "draft", number: null });
  expect((await posted("credit_notes", id)).rows).toEqual([]);
  expect((await getInvoice(inv))!.open).toBe(1180_00n);

  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, "credit_note.issue"), eq(approvalRequests.targetId, id)));
  expect(req).toMatchObject({ status: "pending", requestedBy: accountant.id });
  await approve(owner, req.id, "ok");
  expect((await getNote("credit", id))!.status).toBe("issued");
  expect((await getInvoice(inv))!.open).toBe(1180_00n - 118_00n);
  // Its cancel by the accountant is a request too; the owner's approval reverses it.
  expect((await cancelNote(accountant, "credit", id, "Wrong line")).message).toBe(SENT_FOR_APPROVAL);
  expect((await getNote("credit", id))!.status).toBe("issued");
});

test("excess credit stays with the customer; a cancel reverses on the note's date and reopens the invoice", async () => {
  const c = await createCustomer(owner, customer({ name: "Notes Paid Up" }));
  const inv = await invoice(c);
  await createReceipt(owner, {
    customerId: String(c),
    date: formatDate(today),
    amount: "1180",
    mode: "cash",
    moneyAccountId: cashId,
    reference: "",
    chequeNo: "",
    chequeDate: "",
    receivedBy: "",
    notes: "",
    allocations: JSON.stringify([{ target: "invoice", id: String(inv), amount: "1180" }]),
  });
  const id = await draft(owner, "credit", inv, "1", "500");
  await issueNote(owner, "credit", id);
  // Paid in full already: nothing to allocate, so the ₹590 is customer credit (AR Cr).
  expect((await getNote("credit", id))!).toMatchObject({ paid: 0n, open: 590_00n });
  expect(await customerAdvance(c)).toEqual({ onJobs: 0n, onPrintJobs: 0n, onAccount: 590_00n });
  expect((await ledger({ account: "ar", customerId: c })).closing).toBe(-590_00n);

  expect((await cancelNote(owner, "credit", id, "Issued by mistake")).message).toMatch(/^Cancelled CN\//);
  const { rows, net } = await posted("credit_notes", id);
  expect(Object.values(net).every((v) => v === 0n)).toBe(true);
  expect(rows.every((r) => r.date === today)).toBe(true);
  expect(await customerAdvance(c)).toEqual({ onJobs: 0n, onPrintJobs: 0n, onAccount: 0n });

  // A credit note that did pay its invoice: the cancel gives the open amount back.
  const inv2 = await invoice(c);
  const id2 = await draft(owner, "credit", inv2, "", "100");
  await issueNote(owner, "credit", id2);
  expect((await getInvoice(inv2))!.open).toBe(1180_00n - 118_00n);
  await cancelNote(owner, "credit", id2, "");
  expect((await getInvoice(inv2))!.open).toBe(1180_00n);
  const kept = await db.select().from(allocations).where(eq(allocations.creditNoteId, id2));
  expect(kept.map((k) => k.active)).toEqual([false]);
  // A note can't be dated before its invoice.
  const [line] = await invoiceLinesLeft(db, "credit", inv2);
  await expect(
    createNote(owner, "credit", inv2, { date: formatDate(addDays(today, -1)), reason: "x", notes: "", lines: JSON.stringify([{ invoiceLineId: String(line.id), qty: "", amount: "10" }]) }),
  ).rejects.toMatchObject({ field: "date" });
});

test("PDFs render (samples saved) and their share links work without a login", async () => {
  await mkdir(".samples", { recursive: true });
  const inv = await invoice(local);
  const cn = await draft(owner, "credit", inv, "1", "500", "One acrylic letter returned (damaged in transit)");
  await issueNote(owner, "credit", cn);
  const outInv = await invoice(outside);
  const dn = await draft(owner, "debit", outInv, "", "200", "Rate revised: extra lighting");
  await issueNote(owner, "debit", dn);
  for (const [name, kind, id] of [["credit-note", "credit", cn], ["debit-note", "debit", dn]] as const) {
    const pdf = (await notePdf(kind, id))!;
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(`.samples/${name}.pdf`, pdf.bytes);
    const token = (await getNote(kind, id))!.shareToken;
    const res = await shareRoute(new Request(`http://x/share/${token}`), { params: Promise.resolve({ token }) });
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/pdf"]);
  }
}, 60_000);
