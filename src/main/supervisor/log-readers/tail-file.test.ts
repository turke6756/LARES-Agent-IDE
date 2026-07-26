// Unit tests for the WP-2 (B) bounded async log readers (tail-file.ts).
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/tail-file.test.js
//
// Covers the three DISTINCT contracts:
//   readFileTail   — rune-aligns the HEAD only when truncated; adjusted startOffset.
//   readFileRange  — EXACT bytes, NO alignment; pages join losslessly.
//   readLastLines  — backward-paged last-N, no scan ceiling.
// Plus: short-read loop reassembly, page-boundary multibyte integrity, the
// `normalizeLines` contract, ENOENT semantics, and fd-always-closed.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { open as realOpen } from 'fs/promises';
import assert from 'node:assert/strict';

declare const require: any;

import {
  readFileTail,
  readFileRange,
  readLastLines,
  normalizeLines,
} from './tail-file';

// ── Minimal test harness ─────────────────────────────────────────────
interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tail-file-'));
}
function writeBuf(dir: string, name: string, buf: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** Grab the shared FileHandle prototype so tests can spy/patch `read`/`close`. */
async function fileHandleProto(): Promise<any> {
  const dir = freshDir();
  const p = writeBuf(dir, 'proto-probe', Buffer.from('x'));
  const fh = await realOpen(p, 'r');
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  return proto;
}

// ── Tests ─────────────────────────────────────────────────────────────

test('short-read loop: partial fh.read results are reassembled into the exact range', async () => {
  const dir = freshDir();
  const content = Buffer.from('0123456789abcdef'); // 16 ASCII bytes
  const p = writeBuf(dir, 'short.log', content);

  const proto = await fileHandleProto();
  const origRead = proto.read;
  // Cap every read at 3 bytes to force the short-read while-loop to iterate.
  proto.read = function (buffer: any, offset: number, length: number, position: number) {
    if (Buffer.isBuffer(buffer) && typeof length === 'number') {
      return origRead.call(this, buffer, offset, Math.min(length, 3), position);
    }
    return origRead.apply(this, arguments as any);
  };
  try {
    const range = await readFileRange(p, 2, 14);
    assert.equal(range.bytes.toString('utf8'), '23456789abcd', 'range reassembled across short reads');
    assert.equal(range.startOffset, 2);
    assert.equal(range.endOffset, 14);

    const tail = await readFileTail(p, 5); // last 5 bytes, no truncation alignment issue (ASCII)
    assert.equal(tail.bytes.toString('utf8'), 'bcdef', 'tail reassembled across short reads');
    assert.equal(tail.startOffset, 11);
    assert.equal(tail.endOffset, 16);
    assert.equal(tail.truncated, true);
  } finally {
    proto.read = origRead;
  }
});

test('readFileTail: rune-aligns the head off UTF-8 continuation bytes + reports adjusted startOffset', async () => {
  const dir = freshDir();
  // 'AAAAAAAAAA' (10) + '€' (E2 82 AC @ 10,11,12) + 'BBBB' (13..16). size 17.
  const content = Buffer.concat([Buffer.from('A'.repeat(10)), Buffer.from('€', 'utf8'), Buffer.from('BBBB')]);
  const p = writeBuf(dir, 'rune.log', content);

  // maxBytes 6 → start = 17 - 6 = 11, which is the 0x82 continuation byte.
  const r = await readFileTail(p, 6);
  assert.equal(r.truncated, true, 'truncated');
  // Head-align skips the two continuation bytes (0x82, 0xAC) → starts at 'B' (offset 13).
  assert.equal(r.startOffset, 13, 'startOffset advanced past the partial rune');
  assert.equal(r.endOffset, 17);
  assert.equal(r.fileSize, 17);
  assert.equal(r.bytes.toString('utf8'), 'BBBB', 'no partial-rune replacement char at head');
  assert.notEqual(r.bytes[0] & 0xc0, 0x80, 'first byte is not a continuation byte');
});

test('readFileTail: file smaller than maxBytes → whole file, not truncated, no alignment', async () => {
  const dir = freshDir();
  const content = Buffer.from('€ hello', 'utf8'); // leads with a multibyte char
  const p = writeBuf(dir, 'small.log', content);
  const r = await readFileTail(p, 1_000_000);
  assert.equal(r.truncated, false);
  assert.equal(r.startOffset, 0);
  assert.equal(r.endOffset, content.length);
  assert.ok(r.bytes.equals(content), 'whole file returned byte-exact');
});

test('readFileRange: EXACT bytes with NO alignment (returns partial rune bytes verbatim)', async () => {
  const dir = freshDir();
  const content = Buffer.concat([Buffer.from('A'.repeat(10)), Buffer.from('€', 'utf8'), Buffer.from('BBBB')]);
  const p = writeBuf(dir, 'exact.log', content);

  // Read [11, 17): starts mid-'€' (0x82). NO alignment — bytes come back verbatim.
  const r = await readFileRange(p, 11, 17);
  assert.equal(r.truncated, false);
  assert.equal(r.startOffset, 11);
  assert.equal(r.endOffset, 17);
  assert.ok(r.bytes.equals(Buffer.from([0x82, 0xac, 0x42, 0x42, 0x42, 0x42])), 'exact bytes, no rune alignment');
});

test('readFileRange: a multibyte char split at an 8 MB page boundary rejoins across two consecutive pages', async () => {
  const dir = freshDir();
  const BOUNDARY = 8_000_000;
  // Place '€' so the boundary falls between its 1st and 2nd byte:
  //   euro bytes at [BOUNDARY-1, BOUNDARY, BOUNDARY+1].
  const before = Buffer.alloc(BOUNDARY - 1, 0x61); // 'a' * (BOUNDARY-1)
  const euro = Buffer.from('€', 'utf8');
  const after = Buffer.alloc(1000, 0x62); // 'b' * 1000
  const content = Buffer.concat([before, euro, after]);
  const p = writeBuf(dir, 'page8mb.log', content);

  const page1 = await readFileRange(p, 0, BOUNDARY);
  const page2 = await readFileRange(p, BOUNDARY, content.length);
  assert.equal(page1.endOffset, BOUNDARY, 'page1 ends exactly at the boundary');
  assert.equal(page2.startOffset, BOUNDARY, 'page2 starts exactly at the boundary (contiguous)');

  const joined = Buffer.concat([page1.bytes, page2.bytes]).toString('utf8');
  assert.ok(joined.includes('€'), 'the split multibyte char reconstructs across the two pages');
  // Decoding either page ALONE would corrupt the euro; the join must not.
  assert.equal(joined.indexOf('�'), -1, 'no replacement char after joining pages');
});

test('readLastLines: exact last-N across a 64 KB page boundary (oracle: whole-file split/slice)', async () => {
  const dir = freshDir();
  // 5000 numbered lines, each ~20 bytes → ~100 KB, spanning >1 page (65536).
  const lines: string[] = [];
  for (let i = 1; i <= 5000; i++) lines.push(`line-${String(i).padStart(6, '0')}-payload`);
  const text = lines.join('\n') + '\n';
  const p = writeBuf(dir, 'many.log', Buffer.from(text, 'utf8'));

  const N = 10;
  const got = await readLastLines(p, N);
  const expected = text.split('\n').slice(-N).join('\n'); // same semantics as the swapped call sites
  assert.equal(got, expected, 'last-N matches whole-file oracle across the page boundary');
});

test('readLastLines: multibyte char straddling a 64 KB page boundary decodes intact', async () => {
  const dir = freshDir();
  // euro straddling the last-page boundary (size-65536): after=65535 bytes.
  const after = Buffer.alloc(65535, 0x61); // 'a'
  const euro = Buffer.from('€', 'utf8');
  const before = Buffer.alloc(65535, 0x62); // 'b'
  const content = Buffer.concat([before, euro, after]); // no newlines → one logical line
  const p = writeBuf(dir, 'page64k.log', content);

  const got = await readLastLines(p, 1_000_000); // huge N → pages back through the whole file
  const expected = content.toString('utf8').split('\n').slice(-1_000_000).join('\n');
  assert.equal(got, expected, 'concat-then-decode preserves the straddling rune');
  assert.ok(got.includes('€'), 'euro present and intact');
  assert.equal(got.indexOf('�'), -1, 'no replacement char');
});

test('readLastLines: newline-free 20 MB file returns the whole line (proves NO scan ceiling)', async () => {
  const dir = freshDir();
  const size = 20 * 1024 * 1024;
  const content = Buffer.alloc(size, 0x61); // 20 MB of 'a', zero newlines
  const p = writeBuf(dir, 'huge-noeol.log', content);

  const got = await readLastLines(p, 50);
  assert.equal(got.length, size, 'entire newline-free file returned (no ceiling)');
  assert.equal(got.charCodeAt(0), 0x61);
  assert.equal(got.charCodeAt(size - 1), 0x61);
});

test('normalizeLines: zero / negative / NaN / non-integer normalize to 50; positive integers pass', () => {
  assert.equal(normalizeLines(0), 50);
  assert.equal(normalizeLines(-5), 50);
  assert.equal(normalizeLines(Number.NaN), 50);
  assert.equal(normalizeLines(1.5), 50);
  assert.equal(normalizeLines(500), 500);
  assert.equal(normalizeLines(50), 50);
  assert.equal(normalizeLines(1), 1);
});

test('ENOENT: readFileTail/readFileRange → empty range; readLastLines → ""', async () => {
  const missing = path.join(freshDir(), 'does-not-exist.log');

  const t = await readFileTail(missing, 1000);
  assert.equal(t.bytes.length, 0);
  assert.equal(t.fileSize, 0);
  assert.equal(t.truncated, false);

  const r = await readFileRange(missing, 5, 10);
  assert.equal(r.bytes.length, 0);
  assert.equal(r.startOffset, 5);
  assert.equal(r.endOffset, 5);

  assert.equal(await readLastLines(missing, 10), '');
});

test('fd always closed: each reader closes its handle exactly once', async () => {
  const dir = freshDir();
  const p = writeBuf(dir, 'closed.log', Buffer.from('one\ntwo\nthree\n'));

  // `close` is an OWN property on each FileHandle instance (not on the shared
  // prototype), so spy at the `fs/promises.open` boundary and wrap each handle's
  // own close. tsc compiles the reader's `open(...)` as a late property access on
  // the shared module object, so mutating `.open` here is visible to the reader.
  const fsp = require('fs/promises');
  const origOpen = fsp.open;
  let opened = 0; let closed = 0;
  fsp.open = async (...args: any[]) => {
    const fh = await origOpen(...args);
    opened++;
    const oc = fh.close.bind(fh);
    fh.close = async (...a: any[]) => { closed++; return oc(...a); };
    return fh;
  };
  try {
    await readFileTail(p, 1000);
    await readFileRange(p, 0, 5);
    await readLastLines(p, 2);
    assert.equal(opened, 3, 'three handles opened');
    assert.equal(closed, 3, 'one close per reader invocation');
  } finally {
    fsp.open = origOpen;
  }
});

// ── Runner ────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
