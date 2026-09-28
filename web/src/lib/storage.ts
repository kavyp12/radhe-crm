import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// File bytes (D08). Local disk under web/uploads (gitignored) for now; T44 adds the Supabase Storage driver
// (private bucket) behind the same two calls. Files are served only through the auth-checked /api/files route.

export type Storage = {
  /** Stores new bytes under `key`; never overwrites. */
  put(key: string, body: Uint8Array): Promise<void>;
  /** The bytes under `key`, or null when there are none. */
  get(key: string): Promise<Uint8Array | null>;
};

// UPLOAD_DIR only exists so tests can write to a temp folder. The turbopackIgnore hints keep the build from
// tracing the whole project into the server bundle because of these runtime paths.
const root = () => path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"));

/** Keys are ours (e.g. attachments/2026/09/<uuid>.jpg); anything else is refused, so a key can't leave the root. */
function fileFor(key: string): string {
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]+$/.test(key)) throw new Error(`Bad storage key: ${key}`);
  return path.join(/*turbopackIgnore: true*/ root(), key);
}

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

export const storage: Storage = localDisk;
