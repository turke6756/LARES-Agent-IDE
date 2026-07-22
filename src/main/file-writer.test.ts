// Conditional-write (CAS) tests for writeFileContents (edit-loss plan §4.1,
// R6), Windows path type on real temp files. The WSL branch shares the same
// checkWriteConflict logic but needs a live WSL bridge, so it is exercised
// only via the shared helper here.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/file-writer.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileContents, classifyWriteError } from './file-writer';
import { contentHash } from '../shared/content-hash';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-file-writer-cas-'));
let fileCounter = 0;
function freshFile(initial?: string): string {
  const p = path.join(ROOT, `doc-${++fileCounter}.md`);
  if (initial !== undefined) fs.writeFileSync(p, initial, 'utf-8');
  return p;
}

const DISK = 'on disk\r\ncontent\r\n';
const DRAFT = 'my draft\ncontent\n';
const EXTERNAL = 'external agent wrote this\n';

// ── Unconditional writes (expectedHash undefined) ────────────────────

test('expectedHash undefined: writes unconditionally over anything (force path)', async () => {
  const p = freshFile(EXTERNAL);
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(p, 'utf-8'), DRAFT);
});

// ── CAS: matching hash proceeds ──────────────────────────────────────

test('matching expectedHash: writes and returns ok with path', async () => {
  const p = freshFile(DISK);
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT, contentHash(DISK));
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.path);
  assert.equal(fs.readFileSync(p, 'utf-8'), DRAFT);
});

// ── CAS: mismatch refuses, carries fresh bytes, disk untouched ───────

test('mismatched expectedHash: conflict result, fresh bytes returned, NO write', async () => {
  const p = freshFile(EXTERNAL); // disk moved after our baseline
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT, contentHash(DISK));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.conflict === true, 'must be a conflict result');
  if (!r.ok && r.conflict) assert.equal(r.freshContent, EXTERNAL);
  // Disk retains the external bytes — nothing was written.
  assert.equal(fs.readFileSync(p, 'utf-8'), EXTERNAL);
});

// ── CAS: null = expect absent ────────────────────────────────────────

test('expectedHash null + file absent: writes (creates the file)', async () => {
  const p = freshFile(); // never created
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT, null);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(p, 'utf-8'), DRAFT);
});

test('expectedHash null + file EXISTS: conflict with the fresh bytes, no write', async () => {
  const p = freshFile(EXTERNAL);
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT, null);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.conflict === true, 'must be a conflict result');
  if (!r.ok && r.conflict) assert.equal(r.freshContent, EXTERNAL);
  assert.equal(fs.readFileSync(p, 'utf-8'), EXTERNAL);
});

test('expectedHash set + file VANISHED: conflict (existence mismatch), empty fresh bytes', async () => {
  const p = freshFile(); // expected present, actually absent
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT, contentHash(DISK));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.conflict === true, 'must be a conflict result');
  if (!r.ok && r.conflict) assert.equal(r.freshContent, '');
  assert.equal(fs.existsSync(p), false, 'file must not be recreated');
});

// ── Error classification (§4.4 consumers) ────────────────────────────

test('oversized content: code too-large, classified before any CAS read', async () => {
  const p = freshFile(DISK);
  const big = 'x'.repeat(5 * 1024 * 1024 + 1);
  const r = await writeFileContents(p, ROOT, 'windows', big, contentHash(DISK));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.conflict);
  if (!r.ok && !r.conflict) assert.equal(r.code, 'too-large');
  assert.equal(fs.readFileSync(p, 'utf-8'), DISK);
});

test('missing parent directory: code not-found', async () => {
  const p = path.join(ROOT, 'no-such-dir', 'doc.md');
  const r = await writeFileContents(p, ROOT, 'windows', DRAFT);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.conflict);
  if (!r.ok && !r.conflict) assert.equal(r.code, 'not-found');
});

test('classifyWriteError: errno + message mapping', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(classifyWriteError(errno('EACCES')), 'permission');
  assert.equal(classifyWriteError(errno('EPERM')), 'permission');
  assert.equal(classifyWriteError(errno('ENOENT')), 'not-found');
  assert.equal(classifyWriteError(new Error('File is too large to write (6.0MB). Limit is 5MB.')), 'too-large');
  assert.equal(classifyWriteError(new Error('Parent directory does not exist')), 'not-found');
  assert.equal(classifyWriteError(errno('EBUSY')), 'io');
  assert.equal(classifyWriteError(new Error('anything else')), 'io');
  assert.equal(classifyWriteError('not-an-error'), 'io');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
