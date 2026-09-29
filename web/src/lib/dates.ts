// Business dates are 'YYYY-MM-DD' strings (Postgres date), never JS Date objects. Calendar = Asia/Kolkata (D23).

const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in India. Prod servers run in UTC, so never use the machine's local date. */
export function todayIST(now = new Date()): string {
  const p = Object.fromEntries(IST.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Date.UTC rolls 31/02 over into March, so a round trip through it only survives real dates.
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** 'YYYY-MM-DD' → [year, month, day]. Throws unless it is a real calendar date. */
export function dateParts(date: string, shown = date): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || utc(+m[1], +m[2], +m[3]) !== date) throw new Error(`Invalid date: "${shown}"`);
  return [+m[1], +m[2], +m[3]];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = dateParts(date);
  return utc(y, m, d + days);
}

/** Financial year, April–March: '2027-03-31' → "26-27", '2027-04-01' → "27-28". */
export function fyKey(date: string): string {
  const [y, m] = dateParts(date);
  const start = m >= 4 ? y : y - 1;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
}

/** The 1 April the financial year of `date` starts on: '2027-03-31' → '2026-04-01'. */
export function fyStart(date: string): string {
  const [y, m] = dateParts(date);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

/** '2026-09-28' → "28/09/2026". */
export function formatDate(date: string): string {
  dateParts(date);
  return date.split("-").reverse().join("/");
}

/** DD/MM/YYYY (1/4/2026 is fine) → 'YYYY-MM-DD'. Throws on anything else, including 31/02/2026. */
export function parseDate(input: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  const iso = m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
  dateParts(iso, input);
  return iso;
}

export type Period = "today" | "yesterday" | "week" | "month";

/** Date presets in IST (D30): week = Monday → today, month = 1st → today. */
export function periodRange(period: Period, now = new Date()): { from: string; to: string } {
  const today = todayIST(now);
  const [y, m, d] = dateParts(today);
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case "week": // getUTCDay: Sunday 0 … Saturday 6 → days since Monday
      return { from: addDays(today, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7)), to: today };
    case "month":
      return { from: utc(y, m, 1), to: today };
  }
}

const IST_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h12",
});

/** A moment (e.g. created_at) in India: "28/09/2026 03:45 PM". */
export function formatDateTime(at: Date): string {
  const p = Object.fromEntries(IST_DATE_TIME.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()}`;
}
