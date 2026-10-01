// One shape for every report and exported list (S20, S27, D59): the page table, the Excel file and the PDF are all
// built from it, so whatever the server loader stripped (cost, hard rule 5) is missing from all three.
// No server imports here: client components render it too.

/** Money = bigint paise; number = bigint count; date = 'YYYY-MM-DD'; text = string. null = blank. */
export type ReportCell = string | bigint | null;
export type ReportColumn = { key: string; label: string; type?: "text" | "money" | "number" | "date"; /** sum in the totals row */ total?: boolean };
export type ReportRow = Record<string, ReportCell> & { href?: string | null };
export type ReportTable = { title?: string; columns: ReportColumn[]; rows: ReportRow[] };
export type Report = {
  title: string;
  /** "Period: 01/10/2026 – 31/10/2026", "Mode: Cash" … printed under the title. */
  filters: string[];
  generatedAt: Date;
  tables: ReportTable[];
};

/** Σ of a money column (paise). */
export const columnTotal = (table: ReportTable, key: string) =>
  table.rows.reduce((sum, r) => sum + ((r[key] as bigint | null) ?? 0n), 0n);

/** Right-aligned columns (money, counts). */
export const isNumeric = (c: ReportColumn) => c.type === "money" || c.type === "number";

export const hasTotals = (table: ReportTable) => table.columns.some((c) => c.total);

/** "Collection report" + "xlsx" → "Collection-report-01-10-2026.xlsx" (the date in IST). */
export function reportFileName(title: string, generatedAt: Date, ext: "xlsx" | "pdf") {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata" }).format(generatedAt).replaceAll("/", "-");
  return `${title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${day}.${ext}`;
}
