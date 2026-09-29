// How a receipt was paid (S6) and the money account each mode starts with (D49, editable). Client-safe.

export const RECEIPT_MODES = ["cash", "upi", "bank", "cheque"] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

export const RECEIPT_MODE: Record<ReceiptMode, string> = { cash: "Cash", upi: "UPI", bank: "Bank transfer", cheque: "Cheque" };

/** System key of the default money account (lib/ledger.ts SYSTEM_KEYS). */
export const MODE_ACCOUNT: Record<ReceiptMode, "cash" | "upi" | "bank_1"> = {
  cash: "cash",
  upi: "upi",
  bank: "bank_1",
  cheque: "bank_1",
};
