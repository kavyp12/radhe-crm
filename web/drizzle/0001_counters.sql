CREATE TABLE "counters" (
	"series" text NOT NULL,
	"period_key" text NOT NULL,
	"next_value" integer NOT NULL,
	CONSTRAINT "counters_series_period_key_pk" PRIMARY KEY("series","period_key")
);
