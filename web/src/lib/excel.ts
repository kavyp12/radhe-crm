import { Workbook, type Worksheet } from "exceljs";
import { dateParts, formatDateTime } from "@/lib/dates";
import { excelRupees } from "@/lib/num";
import { columnTotal, hasTotals, type Report, type ReportColumn } from "@/lib/report";

// Excel export (S27, D07, D59) with exceljs: a title block (report name, filters, generated-at), then each table with
// a bold header and a totals row. Money cells are real numbers in an Indian ₹ format; dates are real DD/MM/YYYY dates.

// Lakh / crore grouping needs Excel's two conditional sections. ponytail: negatives below −₹1 lakh fall into the last
// section and group western-style (−₹500,000.00); add a negative-specific format if the accountant minds.
export const INR_FORMAT = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00';
const DATE_FORMAT = "dd/mm/yyyy";
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F5" } } as const;

/** 'YYYY-MM-DD' → a Date at UTC midnight, which exceljs writes as that calendar day. */
function excelDate(iso: string): Date {
  const [y, m, d] = dateParts(iso);
  return new Date(Date.UTC(y, m - 1, d));
}

function cellValue(c: ReportColumn, v: unknown) {
  if (v === null || v === undefined) return null;
  if (c.type === "money") return excelRupees(v as bigint);
  if (c.type === "date") return excelDate(v as string);
  if (c.type === "number") return Number(v as bigint);
  return String(v);
}

function styleCells(sheet: Worksheet, rowNumber: number, columns: ReportColumn[]) {
  columns.forEach((c, i) => {
    const cell = sheet.getRow(rowNumber).getCell(i + 1);
    if (c.type === "money") cell.numFmt = INR_FORMAT;
    if (c.type === "date") cell.numFmt = DATE_FORMAT;
  });
}

export async function reportXlsx(report: Report): Promise<Buffer> {
  const book = new Workbook();
  book.creator = "Radhe CRM";
  book.created = report.generatedAt;
  // Sheet names: max 31 characters, none of : \ / ? * [ ]
  const sheet = book.addWorksheet(report.title.replace(/[:\\/?*[\]]/g, " ").slice(0, 31));

  sheet.addRow([report.title]).font = { bold: true, size: 14 };
  if (report.filters.length) sheet.addRow([report.filters.join(" · ")]);
  sheet.addRow([`Generated ${formatDateTime(report.generatedAt)}`]).font = { color: { argb: "FF6B7280" } };

  const widths: number[] = [];
  const fit = (i: number, n: number) => (widths[i] = Math.min(Math.max(widths[i] ?? 8, n + 2), 50));

  for (const table of report.tables) {
    sheet.addRow([]);
    if (table.title) sheet.addRow([table.title]).font = { bold: true };
    const header = sheet.addRow(table.columns.map((c) => c.label));
    header.font = { bold: true };
    header.eachCell((cell) => (cell.fill = HEADER_FILL));
    table.columns.forEach((c, i) => fit(i, c.type === "money" ? 16 : c.type === "date" ? 10 : c.label.length));

    for (const r of table.rows) {
      const row = sheet.addRow(table.columns.map((c) => cellValue(c, r[c.key])));
      styleCells(sheet, row.number, table.columns);
      table.columns.forEach((c, i) => c.type !== "money" && c.type !== "date" && fit(i, String(r[c.key] ?? "").length));
    }
    if (hasTotals(table)) {
      const values = table.columns.map((c, i) =>
        c.total ? excelRupees(columnTotal(table, c.key)) : i === 0 ? `Total (${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"})` : null,
      );
      const row = sheet.addRow(values);
      row.font = { bold: true };
      styleCells(sheet, row.number, table.columns);
    }
  }
  widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));

  return Buffer.from(await book.xlsx.writeBuffer());
}
