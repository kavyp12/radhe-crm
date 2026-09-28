// Attachment kinds (S24 + other) and the upload cap. Plain data, safe to import in client components.

export const ATTACHMENT_KINDS = [
  "purchase_bill_photo",
  "payment_screenshot",
  "cheque",
  "customer_po",
  "quotation",
  "delivery_challan",
  "installation_photo",
  "other",
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const KIND_LABEL: Record<AttachmentKind, string> = {
  purchase_bill_photo: "Purchase bill photo",
  payment_screenshot: "Payment screenshot",
  cheque: "Cheque",
  customer_po: "Customer PO",
  quotation: "Quotation",
  delivery_challan: "Delivery challan",
  installation_photo: "Installation photo",
  other: "Other",
};

/** Vercel caps request bodies at 4.5 MB (D10); photos are shrunk in the browser first. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
