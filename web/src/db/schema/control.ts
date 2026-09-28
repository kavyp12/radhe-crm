import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

// Document number counters (ARCHITECTURE §6); only lib/numbering.ts touches them.
// next_value = the number the next document of this series + period will get.
export const counters = pgTable(
  "counters",
  {
    series: text("series").notNull(),
    periodKey: text("period_key").notNull(),
    nextValue: integer("next_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.series, t.periodKey] })],
);
