import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// File bytes (D08, D34). Local disk under web/uploads (gitignored) in dev; Supabase Storage (a private bucket) in
// prod — STORAGE_DRIVER picks one. Either way files are served only through the auth-checked /api/files route.

export type Storage = {
  /** Stores new bytes under `key`; never overwrites. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** The bytes under `key`, or null when there are none. */
  get(key: string): Promise<Uint8Array | null>;
};

/** Keys are ours (e.g. attachments/2026/09/<uuid>.jpg); anything else is refused, so a key can't leave its root. */
function checkKey(key: string): string {
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]+$/.test(key)) throw new Error(`Bad storage key: ${key}`);
  return key;
}

// UPLOAD_DIR: tests write to a temp folder; the live server keeps files outside the app folder (D71). Blank = web/uploads.
// The turbopackIgnore hints keep the build from tracing the whole project into the server bundle because of these
// runtime paths.
const root = () => path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
const fileFor = (key: string) => path.join(/*turbopackIgnore: true*/ root(), checkKey(key));

const localDisk: Storage = {
  async put(key, body) {
    const file = fileFor(key);
    await mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
    await writeFile(/*turbopackIgnore: true*/ file, body, { flag: "wx" });
  },
  async get(key) {
    try {
      return new Uint8Array(await readFile(/*turbopackIgnore: true*/ fileFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
};

/**
 * Supabase Storage through its REST API (D69: plain fetch, no supabase-js), on the server only. `key` is a secret key
 * (sb_secret_…, sent as `apikey`) or a legacy service_role JWT (also sent as the Bearer token). Uploads never
 * overwrite (x-upsert: false); the bucket is private, so reads go to /object/authenticated.
 */
export function supabaseStorage({ url, key, bucket }: { url: string; key: string; bucket: string }): Storage {
  const base = `${url.replace(/\/+$/, "")}/storage/v1/object`;
  const headers = { apikey: key, ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}) };
  const where = (k: string) => `${encodeURIComponent(bucket)}/${checkKey(k)}`;
  /** Storage answers errors as JSON { statusCode, error, message }; older servers send HTTP 400 with the real code inside. */
  const failure = async (res: Response) => {
    const body = (await res.json().catch(() => ({}))) as { statusCode?: string | number; error?: string; message?: string };
    return { code: Number(body.statusCode ?? res.status), text: `${res.status} ${body.error ?? ""} ${body.message ?? ""}`.trim() };
  };
  return {
    async put(k, body) {
      const res = await fetch(`${base}/${where(k)}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream", "x-upsert": "false" },
        body: body as Uint8Array<ArrayBuffer>,
      });
      if (!res.ok) throw new Error(`Storage upload of ${k} failed: ${(await failure(res)).text}`);
    },
    async get(k) {
      const res = await fetch(`${base}/authenticated/${where(k)}`, { headers });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      const f = await failure(res);
      if (f.code === 404 && !/bucket/i.test(f.text)) return null; // a missing bucket is a setup error, not a missing file
      throw new Error(`Storage download of ${k} failed: ${f.text}`);
    },
  };
}

/** STORAGE_DRIVER=supabase → the bucket (the start-up env check, lib/env.ts, makes sure its settings are there). */
export const storage: Storage =
  process.env.STORAGE_DRIVER === "supabase"
    ? supabaseStorage({ url: process.env.SUPABASE_URL ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", bucket: process.env.SUPABASE_BUCKET ?? "" })
    : localDisk;
