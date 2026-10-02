import type { Writable } from "node:stream";
import { asc, getTableColumns, getTableName, gt, sql, type Column } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { stream } from "exceljs";
import { db } from "@/db";
import {
  accounts, adjustmentLines, adjustments, allocations, cashCounts, creditNoteLines, creditNotes, customers, debitNoteLines, debitNotes,
  expenseCategories, expenses, followUps, goodsReceiptLines, goodsReceipts, invoiceLines, invoices, jobCostEntries, jobLines, jobs, openingBills,
  jobStatusHistory, journalEntries, journalLines, machines, materialRequestLines, materialRequests, printingTypes, printJobs, productCategories, purchaseBillLines,
  purchaseBills, purchaseOrderLines, purchaseOrders, quotationLines, quotations, receipts, settings, stockAdjustments, stockIssueLines,
  stockIssues, stockItems, stockMoves, transfers, users, vendorAllocations, vendorPayments, vendors,
} from "@/db/schema";
import { DATE_FORMAT, excelDate, INR_FORMAT } from "@/lib/excel";
import { excelQty, excelRupees } from "@/lib/num";
import { can, canViewCost, type SessionUser } from "@/lib/permissions";
import { inRange, moneyCol, REPORT_PERIODS, reportRange, type ReportQuery, type ReportResult } from "@/lib/reports";
import { entryLabel, rangeText } from "@/lib/statements";

// Taking the data out (S27, D62): the full Excel export (owner) and the journal for the accountant. Backups proper
// are pg_dump files (pnpm db:backup, docs/BACKUP.md); this Excel copy is for reading, not for restoring.

/**
 * The full export, a sheet per table in this order: masters, every document with its lines, allocations, stock moves,
 * follow-ups, the journal. Left out: the audit log, approval requests, attachment metadata, counters, share links
 * and the sign-in tables (sessions, password hashes) — all in the pg_dump backup.
 */
export const EXPORT_TABLES: PgTable[] = [
  settings, users, accounts, customers, vendors, openingBills, productCategories, expenseCategories, stockItems, machines, printingTypes,
  quotations, quotationLines, jobs, jobLines, jobStatusHistory, jobCostEntries, printJobs, invoices, invoiceLines,
  creditNotes, creditNoteLines, debitNotes, debitNoteLines, receipts, allocations, followUps,
  materialRequests, materialRequestLines, purchaseOrders, purchaseOrderLines, goodsReceipts, goodsReceiptLines,
  purchaseBills, purchaseBillLines, vendorPayments, vendorAllocations, expenses,
  stockMoves, stockAdjustments, stockIssues, stockIssueLines,
  transfers, adjustments, adjustmentLines, cashCounts, journalEntries, journalLines,
];

/** Everything, purchase rates and stock values included: the owner with can_view_cost (hard rule 5). */
export const canExportAll = (user: SessionUser) => can(user, "settings", "view") && canViewCost(user);

// A share token opens a document's PDF to anyone holding the link: never copied into a file.
const SECRET_COLUMNS = new Set(["share_token"]);
const IST_OFFSET = 330 * 60_000; // India has no DST: timestamps are written as Indian wall-clock time
const TEXT_LIMIT = 32_767; // characters Excel holds in a cell
const BATCH = 2000;

type Kind = "money" | "qty" | "date" | "time" | "plain";
const FORMAT: Partial<Record<Kind, string>> = { money: INR_FORMAT, date: DATE_FORMAT, time: "dd/mm/yyyy hh:mm" };

/** A table's columns as sheet columns: total_paise → "total_rupees" (rupees), qty_milli → "qty" (a number). */
function sheetColumns(table: PgTable) {
  return Object.entries(getTableColumns(table))
    .filter(([, c]) => !SECRET_COLUMNS.has(c.name))
    .map(([key, c]) => {
      let kind: Kind = "plain";
      if (c.columnType === "PgBigInt64") {
        if (c.name.endsWith("_paise")) kind = "money";
        else if (c.name.endsWith("_milli")) kind = "qty";
        else throw new Error(`${getTableName(table)}.${c.name}: a bigint column needs _paise or _milli`);
      } else if (c.columnType === "PgDateString") kind = "date";
      else if (c.columnType === "PgTimestamp") kind = "time";
      return { key, kind, header: c.name.replace(/_paise$/, "_rupees").replace(/_milli$/, "") };
    });
}

function cellValue(kind: Kind, v: unknown) {
  if (v === null || v === undefined) return null;
  if (kind === "money") return excelRupees(v as bigint);
  if (kind === "qty") return excelQty(v as bigint);
  if (kind === "date") return excelDate(v as string);
  if (kind === "time") return new Date((v as Date).getTime() + IST_OFFSET);
  const value = typeof v === "object" ? JSON.stringify(v) : v; // json / arrays
  // ponytail: longer text is cut at Excel's cell limit (no column holds that much today); the pg_dump keeps it whole.
  return typeof value === "string" && value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
}

/**
 * Writes the full export to `out` with exceljs's streaming writer: rows go out as they are read (2,000 at a time, in
 * id order), all tables from one repeatable-read snapshot so the sheets agree with each other. Ids are kept, so the
 * sheets join like the tables. The caller checks canExportAll.
 */
export async function exportAll(out: Writable): Promise<void> {
  const book = new stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
  book.creator = "Radhe CRM";
  await db.transaction(
    async (tx) => {
      for (const table of EXPORT_TABLES) {
        const columns = sheetColumns(table);
        const sheet = book.addWorksheet(getTableName(table), { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.columns = columns.map((c) => ({
          header: c.header,
          key: c.key,
          width: Math.min(Math.max(c.header.length + 2, c.kind === "time" ? 17 : 11), 40),
          ...(FORMAT[c.kind] ? { style: { numFmt: FORMAT[c.kind] } } : {}),
        }));
        sheet.getRow(1).font = { bold: true };
        const id = getTableColumns(table).id as Column;
        for (let last: unknown = null; ; ) {
          const rows = (await tx
            .select()
            .from(table)
            .where(last === null ? undefined : gt(id, last))
            .orderBy(asc(id))
            .limit(BATCH)) as Record<string, unknown>[];
          for (const row of rows) sheet.addRow(columns.map((c) => cellValue(c.kind, row[c.key]))).commit();
          if (rows.length < BATCH) break;
          last = rows[rows.length - 1].id;
        }
        sheet.commit();
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  await book.commit();
}

/**
 * The journal for the accountant (S27, D32): every journal line in the period — date, voucher type, voucher no (the
 * posting document's number), ledger (account + party), Dr, Cr, narration — with totals (Σ Dr = Σ Cr). Reversals are
 * entries of their own. Stock values and materials consumed are in it, so it needs can_view_cost, like the P&L.
 */
export async function journalReport(user: SessionUser, q: ReportQuery, now = new Date()): Promise<ReportResult | null> {
  if (!can(user, "reports", "view") || !canViewCost(user)) return null;
  const { period, range, error } = reportRange(q);
  const rows = await db.execute<{
    date: string; number: string | null; doc_type: string; reverses: string | null; account: string; party: string | null;
    debit: string; credit: string; narration: string | null;
  }>(sql`
    select e.date, e.number, e.doc_type, e.reverses_entry_id as reverses, a.name as account,
      coalesce(c.name || coalesce(' · ' || c.firm_name, ''), v.name) as party, l.debit_paise as debit, l.credit_paise as credit,
      e.narration
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    left join customers c on c.id = l.customer_id
    left join vendors v on v.id = l.vendor_id
    where ${inRange(sql`e.date`, range)}
    order by e.date, e.id, l.id`);
  const side = (paise: string) => (paise === "0" ? null : BigInt(paise));
  return {
    report: {
      title: "Journal",
      filters: [`Period: ${rangeText(range)}`, "Every journal line; a cancelled or edited document's reversal is an entry of its own"],
      generatedAt: now,
      tables: [
        {
          columns: [
            { key: "date", label: "Date", type: "date" },
            { key: "type", label: "Voucher type" },
            { key: "number", label: "Voucher no" },
            { key: "ledger", label: "Ledger" },
            moneyCol("debit", "Dr"),
            moneyCol("credit", "Cr"),
            { key: "narration", label: "Narration" },
          ],
          rows: rows.map((r) => ({
            date: r.date,
            type: entryLabel({ docType: r.doc_type, number: r.number, reverses: r.reverses === null ? null : Number(r.reverses) }),
            number: r.number,
            ledger: r.party ? `${r.account} · ${r.party}` : r.account,
            debit: side(r.debit),
            credit: side(r.credit),
            narration: r.narration,
          })),
        },
      ],
    },
    period,
    error,
    periods: REPORT_PERIODS,
    picks: [],
  };
}
