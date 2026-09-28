import nodemailer from "nodemailer";
import { formEmail, formText, UserError } from "@/lib/action";
import { formatMoney } from "@/lib/num";

// Sharing a PDF (D07): a public share link, a WhatsApp (wa.me) link carrying it, or an email with the PDF attached.

/** The app's own public URL (BETTER_AUTH_URL in .env). */
const appUrl = () => (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/** Public link that serves only this one PDF (app/share/[token]/route.ts). */
export const shareUrl = (token: string) => `${appUrl()}/share/${token}`;

/**
 * wa.me link with the message filled in. A 10-digit Indian mobile gets the 91 country code; no usable number opens
 * WhatsApp's contact picker instead.
 */
export function whatsappLink(mobile: string | null, text: string): string {
  let digits = (mobile ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  const phone = digits.length >= 11 && digits.length <= 15 ? digits : "";
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export const mailConfigured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

/** Sends one email with the PDF attached. SMTP not set up or refused → a UserError the form shows; never a crash. */
export async function sendPdfMail(mail: { to: string; subject: string; text: string; fileName: string; pdf: Buffer }) {
  if (!mailConfigured()) {
    throw new UserError("Email isn't set up yet. Add SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM to the server's .env.");
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = TLS from the start; other ports upgrade with STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      attachments: [{ filename: mail.fileName, content: mail.pdf, contentType: "application/pdf" }],
    });
  } catch (e) {
    throw new UserError(`The email couldn't be sent: ${e instanceof Error ? e.message : "unknown error"}.`);
  }
}

/** The email dialog as typed → a checked address, subject and text. */
export function readMail(form: FormData) {
  const field = (key: string) => String(form.get(key) ?? "");
  const to = formEmail(field("to"), "to");
  if (!to) throw new UserError("Enter the email address.", "to");
  const subject = formText(field("subject"), "subject");
  if (!subject) throw new UserError("Enter a subject.", "subject");
  return { to, subject, text: formText(field("message"), "message", 4000) ?? "" };
}

/** The WhatsApp / email text for a document (D07). */
export function shareMessage(d: { what: string; number: string; name: string; total: bigint; link: string; company: string | null }) {
  return [
    `Dear ${d.name},`,
    "",
    `Please find ${d.what} ${d.number} for ${formatMoney(d.total)}:`,
    d.link,
    "",
    "Regards,",
    d.company ?? "",
  ].join("\n").trim();
}
