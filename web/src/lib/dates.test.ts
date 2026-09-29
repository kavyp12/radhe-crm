import { expect, test } from "vitest";
import { formatDate, formatDateTime, fyKey, fyStart, parseDate, periodRange, todayIST } from "./dates";

test("financial year boundary", () => {
  expect(fyKey("2027-03-31")).toBe("26-27");
  expect(fyKey("2027-04-01")).toBe("27-28");
  expect(fyKey("2099-04-01")).toBe("99-00");
  expect([fyStart("2027-03-31"), fyStart("2027-04-01"), fyStart("2026-09-29")]).toEqual(["2026-04-01", "2027-04-01", "2026-04-01"]);
});

test("today is the IST date, whatever the server's zone", () => {
  expect(todayIST(new Date("2027-03-31T18:29:59Z"))).toBe("2027-03-31");
  expect(todayIST(new Date("2027-03-31T18:30:00Z"))).toBe("2027-04-01");
});

test("DD/MM/YYYY format and strict parse", () => {
  expect(formatDate("2026-09-28")).toBe("28/09/2026");
  expect(parseDate("28/09/2026")).toBe("2026-09-28");
  expect(parseDate("1/4/2026")).toBe("2026-04-01");
  expect(parseDate("29/02/2028")).toBe("2028-02-29");
  for (const bad of ["31/02/2026", "29/02/2026", "31/04/2026", "00/01/2026", "01/13/2026", "2026-09-28", "1/4/26", ""]) {
    expect(() => parseDate(bad), bad).toThrow();
  }
  expect(() => formatDate("2026-02-31")).toThrow();
});

// Instants at 12:00 IST
const MONDAY = new Date("2026-09-28T06:30:00Z");
const THURSDAY_1ST = new Date("2026-10-01T06:30:00Z");
const SUNDAY = new Date("2026-10-04T06:30:00Z");

test("period presets: week = Monday → today, month = 1st → today", () => {
  expect(periodRange("week", MONDAY)).toEqual({ from: "2026-09-28", to: "2026-09-28" });
  expect(periodRange("month", MONDAY)).toEqual({ from: "2026-09-01", to: "2026-09-28" });
  expect(periodRange("week", SUNDAY)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  expect(periodRange("month", SUNDAY)).toEqual({ from: "2026-10-01", to: "2026-10-04" });
  expect(periodRange("week", THURSDAY_1ST)).toEqual({ from: "2026-09-28", to: "2026-10-01" });
  expect(periodRange("month", THURSDAY_1ST)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  expect(periodRange("today", THURSDAY_1ST)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  expect(periodRange("yesterday", THURSDAY_1ST)).toEqual({ from: "2026-09-30", to: "2026-09-30" });
  expect(periodRange("yesterday", new Date("2027-01-01T06:30:00Z"))).toEqual({ from: "2026-12-31", to: "2026-12-31" });
  // Sunday 19:00 UTC is already Monday 00:30 in India
  expect(periodRange("week", new Date("2026-10-04T19:00:00Z"))).toEqual({ from: "2026-10-05", to: "2026-10-05" });
});

test("date-time in IST, hh:mm a", () => {
  expect(formatDateTime(new Date("2026-09-28T10:15:00Z"))).toBe("28/09/2026 03:45 PM");
  expect(formatDateTime(new Date("2026-09-27T18:35:00Z"))).toBe("28/09/2026 12:05 AM"); // after midnight IST
  expect(formatDateTime(new Date("2026-09-28T06:30:00Z"))).toBe("28/09/2026 12:00 PM");
});
