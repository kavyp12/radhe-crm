"use client";

import { Camera, ExternalLink, FileText, ImageIcon, Paperclip, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { DateText } from "@/components/date-text";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { KIND_LABEL, MAX_UPLOAD_BYTES, UPLOAD_KINDS, type AttachmentKind } from "@/lib/attachment-kinds";
import type { AttachmentItem } from "@/lib/attachments";

type Target = { entityType: string; entityId: number; kind: AttachmentKind };

/**
 * Photos are shrunk in the browser (long side 1600 px) before upload: Vercel refuses bodies over 4.5 MB, and a
 * phone photo is often bigger. JPEG output (on white, so transparency doesn't turn black) unless keepPng.
 */
async function shrink(file: File, keepPng: boolean): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d")!;
  const png = keepPng && file.type === "image/png";
  if (!png) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = png ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  if (!blob) throw new Error("Could not encode the image");
  return new File([blob], file.name.replace(/\.[^.]*$/, "") + (png ? ".png" : ".jpg"), { type });
}

async function uploadFile(file: File, target: Target, keepPng = false): Promise<{ id: number } | { error: string }> {
  let body = file;
  if (file.type.startsWith("image/")) {
    try {
      body = await shrink(file, keepPng);
    } catch {
      return { error: "This photo can't be read here. Take it again, or choose a JPEG or PNG." };
    }
  }
  if (body.size > MAX_UPLOAD_BYTES) return { error: "Files can be 4 MB at most." };
  const form = new FormData();
  form.set("file", body);
  form.set("entityType", target.entityType);
  form.set("entityId", String(target.entityId));
  form.set("kind", target.kind);
  try {
    const res = await fetch("/api/files", { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { id: json.id } : { error: json.error ?? "Upload failed." };
  } catch {
    return { error: "Can't reach the server. Check the connection and try again." };
  }
}

const fileUrl = (id: number) => `/api/files/${id}`;
const sizeText = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type PanelProps = {
  entityType: string;
  entityId: number;
  items: AttachmentItem[];
  canUpload: boolean;
  defaultKind?: AttachmentKind;
};

/** Attach photos / PDFs to a record: take a photo, choose a file, list, preview. */
export function AttachmentsPanel({ entityType, entityId, items, canUpload, defaultKind = "other" }: PanelProps) {
  const router = useRouter();
  const [kind, setKind] = useState<AttachmentKind>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AttachmentItem | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const result = await uploadFile(file, { entityType, entityId, kind });
    setBusy(false);
    if ("error" in result) return toast.error(result.error);
    toast.success("File attached.");
    router.refresh();
  }
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void upload(e.target.files?.[0]);
    e.target.value = "";
  };

  return (
    <div className="rounded-lg border bg-card">
      {canUpload && (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <NativeSelect aria-label="Kind of document" value={kind} onChange={(e) => setKind(e.target.value as AttachmentKind)}>
            {UPLOAD_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {KIND_LABEL[k]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" variant="outline" disabled={busy} onClick={() => camera.current?.click()}>
            <Camera />
            Take photo
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => chooser.current?.click()}>
            <Upload />
            Choose file
          </Button>
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {busy ? "Uploading…" : "Photos or PDF, up to 4 MB"}
          </span>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
          <input ref={chooser} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={onPick} />
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState icon={Paperclip} title="No files attached yet." />
      ) : (
        <ul className="divide-y">
          {items.map((item) => {
            const image = item.mime.startsWith("image/");
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setPreview(item)}
                  aria-label={`Preview ${item.fileName}`}
                  className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted outline-none transition-shadow hover:ring-2 hover:ring-ring/30 focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- auth-checked file route; next/image would fetch it without the session
                    <img src={fileUrl(item.id)} alt="" className="size-full object-cover" loading="lazy" />
                  ) : (
                    <FileText className="size-5 text-muted-foreground" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setPreview(item)}
                    className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                  >
                    {item.fileName}
                  </button>
                  <p className="truncate text-xs text-muted-foreground">
                    {KIND_LABEL[item.kind]}, {sizeText(item.size)}, {item.createdBy ?? "System"},{" "}
                    <DateText at={item.createdAt} />
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" asChild>
                  <a href={fileUrl(item.id)} target="_blank" rel="noopener" aria-label={`Open ${item.fileName} in a new tab`}>
                    <ExternalLink />
                  </a>
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="truncate pr-8">{preview?.fileName}</DialogTitle>
          <DialogDescription className="sr-only">Preview of the attached file</DialogDescription>
          {preview &&
            (preview.mime.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element -- auth-checked file route
              <img src={fileUrl(preview.id)} alt={preview.fileName} className="max-h-[75vh] w-full rounded-md object-contain" />
            ) : (
              <iframe src={fileUrl(preview.id)} title={preview.fileName} className="h-[75vh] w-full rounded-md border" />
            ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type ImageFieldProps = {
  label: string;
  attachmentId: number | null;
  entityType: string;
  entityId: number;
  /** Server action that stores the choice (null = remove). */
  onChange: (attachmentId: number | null) => Promise<{ error?: string } | void>;
};

/** One image setting (logo, signature): upload, replace, remove. Saved straight away; PNG transparency kept. */
export function ImageField({ label, attachmentId, entityType, entityId, onChange }: ImageFieldProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function save(id: number | null) {
    const result = await onChange(id);
    if (result?.error) return toast.error(result.error);
    toast.success(id ? `${label} saved.` : `${label} removed.`);
    router.refresh();
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const result = await uploadFile(file, { entityType, entityId, kind: "other" }, true);
    if ("error" in result) toast.error(result.error);
    else await save(result.id);
    setBusy(false);
  }

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-16 w-32 place-items-center overflow-hidden rounded-md border bg-[repeating-conic-gradient(var(--color-zinc-100)_0_25%,white_0_50%)] bg-[length:12px_12px]">
          {attachmentId ? (
            // eslint-disable-next-line @next/next/no-img-element -- auth-checked file route
            <img src={fileUrl(attachmentId)} alt={label} className="max-h-full max-w-full object-contain" />
          ) : (
            <ImageIcon aria-hidden className="size-5 text-muted-foreground" />
          )}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          <Upload />
          {busy ? "Uploading…" : attachmentId ? "Replace" : "Upload"}
        </Button>
        {attachmentId && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => save(null)}>
            Remove
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
