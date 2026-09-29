import { and, desc, eq } from "drizzle-orm";
import { db, writeTx } from "@/db";
import { attachments, users } from "@/db/schema";
import { UserError } from "@/lib/action";
import { ATTACHMENT_KINDS, MAX_UPLOAD_BYTES, type AttachmentKind } from "@/lib/attachment-kinds";
import { todayIST } from "@/lib/dates";
import { can, type Action, type Area, type SessionUser } from "@/lib/permissions";
import { storage } from "@/lib/storage";

// Files attached to records (S24). Uploading needs "edit" on the record's area (a job: "view", D48), viewing needs "view".

/** The permission area behind each entity type's files. Each module adds its entity when it gets attachments. */
const ENTITY_AREA: Record<string, Area> = {
  settings: "settings",
  customer: "customers",
  vendor: "vendors",
  quotation: "quotations",
  job: "jobs",
  invoice: "invoices",
  receipt: "payments",
};

/** Entity types whose files anyone who can see the record may add (D48: production uploads installation photos). */
const UPLOAD_ON_VIEW = new Set(["job"]);

/** "edit" = may upload. */
export function canAttach(user: SessionUser, entityType: string, action: Extract<Action, "view" | "edit">) {
  const area = ENTITY_AREA[entityType];
  return !!area && can(user, area, action === "edit" && UPLOAD_ON_VIEW.has(entityType) ? "view" : action);
}

const EXTENSION = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" } as const;
export type FileType = keyof typeof EXTENSION;

/** The real type from the first bytes. The browser's claimed type and the file name are not trusted. */
export function sniffType(bytes: Uint8Array): FileType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** Photos and PDF only, 4 MB at most. Returns the detected type. */
export function checkUpload(bytes: Uint8Array): FileType {
  if (bytes.length === 0) throw new UserError("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UserError("Files can be 4 MB at most.");
  const type = sniffType(bytes);
  if (!type) throw new UserError("Only photos (JPEG, PNG, WebP) and PDF files can be attached.");
  return type;
}

export type NewAttachment = {
  entityType: string;
  entityId: number;
  kind: string;
  fileName: string;
  bytes: Uint8Array;
};

export async function saveAttachment(actor: SessionUser, input: NewAttachment) {
  if (!canAttach(actor, input.entityType, "edit")) throw new Error("Not allowed");
  if (!Number.isSafeInteger(input.entityId) || input.entityId < 1) throw new UserError("Unknown record.");
  if (!ATTACHMENT_KINDS.includes(input.kind as AttachmentKind)) throw new UserError("Pick the kind of document.");
  const type = checkUpload(input.bytes);
  const fileName = input.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim().slice(-200) || "file";
  const [year, month] = todayIST().split("-");
  const path = `attachments/${year}/${month}/${crypto.randomUUID()}.${EXTENSION[type]}`;

  // Bytes first: a failed insert leaves an unused file, never a row pointing at nothing.
  await storage.put(path, input.bytes);
  const [row] = await writeTx(actor, (tx) =>
    tx
      .insert(attachments)
      .values({
        entityType: input.entityType,
        entityId: input.entityId,
        kind: input.kind as AttachmentKind,
        path,
        fileName,
        mime: type,
        size: input.bytes.length,
        createdBy: actor.id,
      })
      .returning(),
  );
  return row;
}

export type AttachmentItem = {
  id: number;
  kind: AttachmentKind;
  fileName: string;
  mime: string;
  size: number;
  createdAt: Date;
  createdBy: string | null;
};

export async function listAttachments(entityType: string, entityId: number): Promise<AttachmentItem[]> {
  return db
    .select({
      id: attachments.id,
      kind: attachments.kind,
      fileName: attachments.fileName,
      mime: attachments.mime,
      size: attachments.size,
      createdAt: attachments.createdAt,
      createdBy: users.name,
    })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(and(eq(attachments.entityType, entityType), eq(attachments.entityId, entityId)))
    .orderBy(desc(attachments.id));
}

/** The file and its bytes, or null when it doesn't exist or this user can't see its record. */
export async function readAttachment(user: SessionUser, id: number) {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row || !canAttach(user, row.entityType, "view")) return null;
  const bytes = await storage.get(row.path);
  return bytes && { row, bytes };
}
