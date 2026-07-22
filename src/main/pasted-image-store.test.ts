// pasted-image-store tests — the pure, directory-injected persistence helper
// behind the clipboard-image paste feature. No Electron imports, so it runs
// under plain `node dist/main/main/pasted-image-store.test.js`.
//
// Covers:
//   1. pickExtension — supported MIME → ext, unsupported/empty → null.
//   2. saveImage — rejects unsupported/empty/oversized WITHOUT writing a file;
//      happy path writes a uniquely-named file with the right extension; two
//      calls yield distinct paths (UUID uniqueness); post-write dir cap holds.
//   3. pruneImages — age-out, count-cap, byte-cap, and the three jointly; a
//      non-file entry is left alone; the protectedPath is never evicted.
//
//   npm run build:main
//   node dist/main/main/pasted-image-store.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pickExtension, saveImage, pruneImages,
  MAX_IMAGE_BYTES, IMAGE_RETENTION_MS, MAX_IMAGE_FILES, MAX_IMAGE_TOTAL_BYTES,
} from './pasted-image-store';

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-img-'));
}

/** Create a file of a given apparent size (via truncate — fast, no huge write)
 *  and set its mtime. Returns the full path. */
function makeFile(dir: string, name: string, size: number, mtimeMs: number): string {
  const full = path.join(dir, name);
  const fd = fs.openSync(full, 'w');
  try { if (size > 0) fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
  const t = mtimeMs / 1000;
  fs.utimesSync(full, t, t);
  return full;
}

// ── pickExtension ────────────────────────────────────────────────────
test('pickExtension maps supported MIMEs and rejects the rest', () => {
  assert.equal(pickExtension('image/png'), 'png');
  assert.equal(pickExtension('image/jpeg'), 'jpg');
  assert.equal(pickExtension('IMAGE/PNG'), 'png'); // case-insensitive
  assert.equal(pickExtension('image/gif'), null);
  assert.equal(pickExtension('image/webp'), null);
  assert.equal(pickExtension(''), null);
});

// ── saveImage: rejections write nothing ──────────────────────────────
test('saveImage rejects an unsupported MIME without writing a file', async () => {
  const dir = freshDir();
  const res = await saveImage(dir, new Uint8Array([1, 2, 3]), 'image/gif', Date.now());
  assert.equal(res.ok, false);
  // Dir may not even exist (mkdir happens on the write path); either way, empty.
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(entries.length, 0);
});

test('saveImage rejects an empty (0-byte) image without writing a file', async () => {
  const dir = freshDir();
  const res = await saveImage(dir, new Uint8Array(0), 'image/png', Date.now());
  assert.equal(res.ok, false);
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(entries.length, 0);
});

test('saveImage rejects an oversized image (>25 MB) without writing a file', async () => {
  const dir = freshDir();
  const res = await saveImage(dir, new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png', Date.now());
  assert.equal(res.ok, false);
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(entries.length, 0);
});

// ── saveImage: happy path ────────────────────────────────────────────
test('saveImage writes a uniquely-named file with the correct extension', async () => {
  const dir = freshDir();
  const res = await saveImage(dir, new Uint8Array([1, 2, 3, 4]), 'image/png', Date.now());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.path.startsWith(dir));
  assert.match(path.basename(res.path), /^paste-[0-9a-f-]+\.png$/);
  assert.ok(fs.existsSync(res.path));
  assert.deepEqual([...fs.readFileSync(res.path)], [1, 2, 3, 4]);
});

test('saveImage uses the jpg extension for image/jpeg', async () => {
  const dir = freshDir();
  const res = await saveImage(dir, new Uint8Array([9]), 'image/jpeg', Date.now());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(path.basename(res.path), /\.jpg$/);
});

test('two successive saves yield distinct paths (UUID uniqueness)', async () => {
  const dir = freshDir();
  const a = await saveImage(dir, new Uint8Array([1]), 'image/png', Date.now());
  const b = await saveImage(dir, new Uint8Array([2]), 'image/png', Date.now());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readdirSync(dir).length, 2);
});

// ── pruneImages ──────────────────────────────────────────────────────
test('pruneImages ages out files older than the retention window', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  const old = makeFile(dir, 'old.png', 10, now - IMAGE_RETENTION_MS - 1000); // just past 24h
  const fresh = makeFile(dir, 'fresh.png', 10, now - 1000);                  // well inside
  await pruneImages(dir, now);
  assert.ok(!fs.existsSync(old), 'aged-out file deleted');
  assert.ok(fs.existsSync(fresh), 'fresh file kept');
});

test('pruneImages enforces the count cap, evicting oldest first', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  const total = MAX_IMAGE_FILES + 5;
  const paths: string[] = [];
  for (let i = 0; i < total; i++) {
    // Distinct, recent mtimes: i=0 is the oldest.
    paths.push(makeFile(dir, `f${String(i).padStart(3, '0')}.png`, 10, now - (total - i) * 1000));
  }
  await pruneImages(dir, now);
  const remaining = fs.readdirSync(dir);
  assert.equal(remaining.length, MAX_IMAGE_FILES, 'count trimmed to the cap');
  // The 5 oldest are gone; the newest survive.
  for (let i = 0; i < 5; i++) assert.ok(!fs.existsSync(paths[i]), `oldest #${i} evicted`);
  assert.ok(fs.existsSync(paths[total - 1]), 'newest kept');
});

test('pruneImages enforces the total-byte cap, evicting oldest first', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  const big = 50 * 1024 * 1024; // 50 MB each
  const n = 6;                  // 300 MB > 250 MB cap
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    paths.push(makeFile(dir, `b${i}.png`, big, now - (n - i) * 1000));
  }
  await pruneImages(dir, now);
  const remaining = fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).size);
  const totalBytes = remaining.reduce((a, b) => a + b, 0);
  assert.ok(totalBytes <= MAX_IMAGE_TOTAL_BYTES, 'total bytes under the cap');
  assert.ok(!fs.existsSync(paths[0]), 'oldest evicted first for byte cap');
});

test('pruneImages satisfies age, count AND byte limits jointly', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  // Two aged files (must go) + count-cap overflow of fresh files.
  makeFile(dir, 'aged1.png', 10, now - IMAGE_RETENTION_MS - 5000);
  makeFile(dir, 'aged2.png', 10, now - IMAGE_RETENTION_MS - 4000);
  const overflow = MAX_IMAGE_FILES + 3;
  for (let i = 0; i < overflow; i++) {
    makeFile(dir, `fresh${String(i).padStart(3, '0')}.png`, 10, now - (overflow - i) * 100);
  }
  await pruneImages(dir, now);
  const remaining = fs.readdirSync(dir);
  assert.ok(!remaining.includes('aged1.png') && !remaining.includes('aged2.png'), 'aged files gone');
  assert.ok(remaining.length <= MAX_IMAGE_FILES, 'count under the cap');
  const totalBytes = remaining.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(totalBytes <= MAX_IMAGE_TOTAL_BYTES, 'bytes under the cap');
});

test('pruneImages never deletes the protectedPath even at equal mtimes', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  const total = MAX_IMAGE_FILES + 3;
  // All identical mtimes → the sort tie could otherwise evict any of them.
  for (let i = 0; i < total; i++) makeFile(dir, `p${String(i).padStart(3, '0')}.png`, 10, now - 1000);
  const protectedPath = path.join(dir, 'p000.png'); // would sort as "oldest" candidate
  await pruneImages(dir, now, protectedPath);
  assert.ok(fs.existsSync(protectedPath), 'protected file survives the count cap');
  assert.equal(fs.readdirSync(dir).length, MAX_IMAGE_FILES);
});

test('pruneImages ignores a stray subdirectory (never counts or deletes it)', async () => {
  const dir = freshDir();
  const now = 10 * IMAGE_RETENTION_MS;
  fs.mkdirSync(path.join(dir, 'a-subdir'));
  makeFile(dir, 'real.png', 10, now - 1000);
  await pruneImages(dir, now);
  assert.ok(fs.existsSync(path.join(dir, 'a-subdir')), 'subdir untouched');
  assert.ok(fs.existsSync(path.join(dir, 'real.png')), 'file kept');
});

// ── post-write dir cap ───────────────────────────────────────────────
test('after MAX_IMAGE_FILES + 1 saves the dir holds no more than the cap', async () => {
  const dir = freshDir();
  const now = Date.now();
  for (let i = 0; i < MAX_IMAGE_FILES + 1; i++) {
    const res = await saveImage(dir, new Uint8Array([i & 0xff]), 'image/png', now);
    assert.equal(res.ok, true);
  }
  assert.ok(fs.readdirSync(dir).length <= MAX_IMAGE_FILES, 'post-write cap holds');
});
