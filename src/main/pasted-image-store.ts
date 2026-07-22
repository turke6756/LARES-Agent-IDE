import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Only formats the writer / Claude reliably accept this pass.
export const SUPPORTED_IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;         // per-file
export const IMAGE_RETENTION_MS = 24 * 60 * 60 * 1000;   // 24h
export const MAX_IMAGE_FILES = 100;
export const MAX_IMAGE_TOTAL_BYTES = 250 * 1024 * 1024;  // dir-wide quota

export function pickExtension(mime: string): string | null {
  return SUPPORTED_IMAGE_MIME_EXT[(mime || '').toLowerCase()] ?? null;
}

/** Delete oldest files until age, count, AND total-byte limits are all
 *  satisfied. Best-effort; never throws. `now` injectable for tests.
 *  `protectedPath` (the file saveImage just wrote) is never deleted, so an
 *  equal-mtime tie can't evict a live path and return it dead (addendum B). */
export async function pruneImages(dir: string, now: number, protectedPath?: string): Promise<void> {
  let entries: string[];
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  const stats = (await Promise.all(entries.map(async (name) => {
    const full = path.join(dir, name);
    try {
      const s = await fs.promises.stat(full);
      if (!s.isFile()) return null; // skip stray subdirs — never counted or "deleted" (addendum A)
      return { full, mtime: s.mtimeMs, size: s.size };
    } catch { return null; }
  }))).filter(Boolean) as { full: string; mtime: number; size: number }[];

  // 1. Age-out. A failed unlink keeps the file counted (survivor) so the
  //    downstream cap still accounts for its bytes.
  const survivors: typeof stats = [];
  for (const f of stats) {
    if (f.full === protectedPath) { survivors.push(f); continue; }
    if (now - f.mtime > IMAGE_RETENTION_MS) {
      try { await fs.promises.unlink(f.full); }
      catch { survivors.push(f); }
    } else survivors.push(f);
  }
  // 2. Count + byte cap: evict oldest first until both satisfied. Only mutate
  //    the quota counters when the unlink actually succeeded (addendum A), and
  //    never evict the just-written file (addendum B).
  survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
  let total = survivors.reduce((n, f) => n + f.size, 0);
  let count = survivors.length;
  for (const f of survivors) {
    if (count <= MAX_IMAGE_FILES && total <= MAX_IMAGE_TOTAL_BYTES) break;
    if (f.full === protectedPath) continue;
    try {
      await fs.promises.unlink(f.full);
      total -= f.size; count -= 1;
    } catch { /* deletion failed — leave it counted */ }
  }
}

// Serialize writes through a small module-level promise queue (addendum C): one
// call's prune can't delete another call's freshly-written file under
// concurrency, and the dir cap actually holds instead of racing.
let saveQueue: Promise<unknown> = Promise.resolve();

async function saveImageInner(
  dir: string, bytes: Uint8Array, mime: string, now: number,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const ext = pickExtension(mime);
  if (!ext) return { ok: false, error: `Unsupported image type: ${mime || 'unknown'}` };
  if (bytes.byteLength === 0) return { ok: false, error: 'Image was empty.' };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Image too large (${Math.round(bytes.byteLength / 1048576)} MB, max 25 MB).` };
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const full = path.join(dir, `paste-${randomUUID()}.${ext}`);
    await fs.promises.writeFile(full, bytes, { flag: 'wx' }); // exclusive create
    // Prune AFTER a successful write, protecting the file we just wrote. The cap
    // is best-effort — a write-before-prune window and concurrent saves can
    // transiently exceed it; the queue above is what bounds it (addendum C).
    await pruneImages(dir, now, full);
    return { ok: true, path: full };
  } catch (err: any) {
    return { ok: false, error: `Failed to save image: ${err?.message || err}` };
  }
}

/** Write bytes to a uniquely-named file with exclusive create. Serialized so
 *  concurrent saves don't prune each other's fresh files. Returns the native
 *  path. */
export async function saveImage(
  dir: string, bytes: Uint8Array, mime: string, now: number,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const run = saveQueue.then(() => saveImageInner(dir, bytes, mime, now));
  // Keep the queue alive across both outcomes without leaking a rejection.
  saveQueue = run.then(() => undefined, () => undefined);
  return run;
}
