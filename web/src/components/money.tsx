import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/num";

/**
 * ₹1,00,000.00 from paise. Negatives are red with a minus; `drcr` shows ledger style instead
 * (₹500.00 Dr / ₹500.00 Cr, positive = Dr).
 */
export function Money({ paise, drcr, className }: { paise: bigint; drcr?: boolean; className?: string }) {
  const base = cn("whitespace-nowrap tabular-nums", className);
  if (drcr) {
    if (paise === 0n) return <span className={base}>{formatMoney(0n)}</span>;
    return (
      <span className={base}>
        {formatMoney(paise < 0n ? -paise : paise)} {paise < 0n ? "Cr" : "Dr"}
      </span>
    );
  }
  return <span className={cn(base, paise < 0n && "text-red-600")}>{formatMoney(paise)}</span>;
}
