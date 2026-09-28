import { formatDate, formatDateTime } from "@/lib/dates";

/** A business date ('YYYY-MM-DD') as DD/MM/YYYY, or a moment as DD/MM/YYYY hh:mm AM (IST). */
export function DateText(props: { date: string } | { at: Date }) {
  const iso = "at" in props ? props.at.toISOString() : props.date;
  return (
    <time dateTime={iso} className="whitespace-nowrap tabular-nums">
      {"at" in props ? formatDateTime(props.at) : formatDate(props.date)}
    </time>
  );
}
