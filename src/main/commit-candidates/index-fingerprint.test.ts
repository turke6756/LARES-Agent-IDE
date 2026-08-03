// SC-WP-3G — index fingerprint (bundle contract v1 §9.3).
//
//   npm run build:main
//   node dist/main/main/commit-candidates/index-fingerprint.test.js
//
// Fake-buffer cases pin the canonical shape: order-independence, staged-mutation
// sensitivity, unmerged rejection, non-UTF-8 path-byte preservation, and the
// optional `write-tree` secondary. One real-git case drives the genuine seam so
// the fingerprint + write-tree OID come from actual `ls-files`/`write-tree`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import type { GitRunBytesResult, GitRunResult, RunGitOptions } from '../git-checkpoints/git-command';
import {
  computeIndexFingerprint,
  type IndexFingerprintRunGit,
  type IndexFingerprintRunGitBytes,
} from './index-fingerprint';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

/** Build one raw `ls-files --stage -z` record: `<mode> <oid> <stage>\t<pathBytes>\0`. */
function stageRecord(mode: string, oid: string, stage: string, pathBytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} ${oid} ${stage}\t`, 'ascii'),
    pathBytes,
    Buffer.from([0]),
  ]);
}

function bytesRunGit(stdout: Buffer, code = 0): IndexFingerprintRunGitBytes {
  return async (_cwd: string, _args: string[], _opts: RunGitOptions): Promise<GitRunBytesResult> =>
    ({ code, stdout, stderr: '' });
}

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

// ── order-independence + mutation sensitivity ────────────────────────────────

test('fingerprint is independent of git emission order for the same staged set', async () => {
  const recA = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const recB = stageRecord('100644', OID_B, '0', Buffer.from('src/b.ts', 'utf8'));
  const forward = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(Buffer.concat([recA, recB])) });
  const reversed = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(Buffer.concat([recB, recA])) });
  assert.equal(forward.fingerprint, reversed.fingerprint);
  assert.equal(forward.hasUnmerged, false);
  assert.equal(forward.entries.length, 2);
});

test('a changed staged blob oid flips the fingerprint', async () => {
  const rec1 = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const rec2 = stageRecord('100644', OID_C, '0', Buffer.from('src/a.ts', 'utf8'));
  const one = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec1) });
  const two = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec2) });
  assert.notEqual(one.fingerprint, two.fingerprint);
});

test('a changed staged mode flips the fingerprint', async () => {
  const rec1 = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const rec2 = stageRecord('100755', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const one = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec1) });
  const two = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec2) });
  assert.notEqual(one.fingerprint, two.fingerprint);
});

test('an empty index fingerprints to a stable value with no entries', async () => {
  const res = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(Buffer.alloc(0)) });
  assert.equal(res.entries.length, 0);
  assert.equal(res.hasUnmerged, false);
  assert.match(res.fingerprint, /^[0-9a-f]{64}$/);
});

// ── unmerged rejection ───────────────────────────────────────────────────────

test('unmerged stages set hasUnmerged and skip the write-tree secondary', async () => {
  const p = Buffer.from('src/conflict.ts', 'utf8');
  const stdout = Buffer.concat([
    stageRecord('100644', OID_A, '1', p),
    stageRecord('100644', OID_B, '2', p),
    stageRecord('100644', OID_C, '3', p),
  ]);
  let wroteTree = false;
  const runGit: IndexFingerprintRunGit = async () => { wroteTree = true; return { code: 0, stdout: OID_A + '\n', stderr: '' }; };
  const res = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(stdout), runGit });
  assert.equal(res.hasUnmerged, true);
  assert.equal(res.writeTreeOid, null);
  assert.equal(wroteTree, false, 'write-tree must never run against an unmerged index');
});

// ── write-tree secondary ─────────────────────────────────────────────────────

test('a merged index records the write-tree secondary OID', async () => {
  const rec = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const runGit: IndexFingerprintRunGit = async (_cwd, args) => {
    assert.deepEqual(args, ['write-tree']);
    return { code: 0, stdout: 'd'.repeat(40) + '\n', stderr: '' };
  };
  const res = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec), runGit });
  assert.equal(res.writeTreeOid, 'd'.repeat(40));
});

test('withWriteTree:false suppresses the secondary even when a runGit is provided', async () => {
  const rec = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  let called = false;
  const runGit: IndexFingerprintRunGit = async () => { called = true; return { code: 0, stdout: OID_A + '\n', stderr: '' }; };
  const res = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec), runGit, withWriteTree: false });
  assert.equal(res.writeTreeOid, null);
  assert.equal(called, false);
});

test('a non-zero write-tree exit leaves the fingerprint intact and the secondary null', async () => {
  const rec = stageRecord('100644', OID_A, '0', Buffer.from('src/a.ts', 'utf8'));
  const runGit: IndexFingerprintRunGit = async () => ({ code: 128, stdout: '', stderr: 'boom' });
  const res = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec), runGit });
  assert.equal(res.writeTreeOid, null);
  assert.match(res.fingerprint, /^[0-9a-f]{64}$/);
});

// ── non-UTF-8 path preservation ──────────────────────────────────────────────

test('non-UTF-8 path bytes are preserved authoritatively in the fingerprint', async () => {
  const rawPath = Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff, 0xfe, 0x2e, 0x74, 0x73]); // src/\xff\xfe.ts
  const nearPath = Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff, 0xfd, 0x2e, 0x74, 0x73]); // one byte differs
  const rec = stageRecord('100644', OID_A, '0', rawPath);
  const recNear = stageRecord('100644', OID_A, '0', nearPath);
  const one = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec) });
  const two = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(rec) });
  const near = await computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(recNear) });
  assert.equal(one.fingerprint, two.fingerprint, 'identical bytes fingerprint identically');
  assert.notEqual(one.fingerprint, near.fingerprint, 'a single differing path byte flips the fingerprint');
  assert.equal(one.entries[0].pathBytesBase64, rawPath.toString('base64'));
});

// ── ls-files failure ─────────────────────────────────────────────────────────

test('a non-zero ls-files exit throws rather than fabricating a fingerprint', async () => {
  await assert.rejects(
    computeIndexFingerprint({ repoRoot: '/x', runGitBytes: bytesRunGit(Buffer.alloc(0), 128) }),
  );
});

// ── real git integration ─────────────────────────────────────────────────────

const trash: string[] = [];
function mkRepo(exe: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-idxfp-'));
  trash.push(repo);
  const g = (args: string[]) => execFileSync(exe, args, { cwd: repo }).toString();
  g(['init', '-q']);
  g(['config', 'user.email', 't@lares.local']);
  g(['config', 'user.name', 'Lares Test']);
  return repo;
}

test('real git: fingerprint tracks the staged index and emits a write-tree OID', async () => {
  const internal = await resolveInternalGit();
  if (!internal) { console.log('  SKIP real-git case — no compatible git resolved.'); return; }
  const exe = internal.execPath;
  const repo = mkRepo(exe);
  const g = (args: string[]) => execFileSync(exe, args, { cwd: repo }).toString();

  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  g(['add', 'a.txt']);

  const runGitBytes: IndexFingerprintRunGitBytes = (cwd, args, opts) =>
    realRunGitBytes(cwd, args, { ...opts, gitExe: exe }) as Promise<GitRunBytesResult>;
  const runGit: IndexFingerprintRunGit = (cwd, args, opts) =>
    realRunGit(cwd, args, { ...opts, gitExe: exe }) as Promise<GitRunResult>;

  const first = await computeIndexFingerprint({ repoRoot: repo, runGitBytes, runGit });
  assert.equal(first.hasUnmerged, false);
  assert.equal(first.entries.length, 1);
  assert.match(first.writeTreeOid ?? '', /^[0-9a-f]{40,64}$/);

  // Re-fingerprinting the unchanged index is stable.
  const again = await computeIndexFingerprint({ repoRoot: repo, runGitBytes, runGit });
  assert.equal(first.fingerprint, again.fingerprint);

  // Staging a second file changes the fingerprint AND the write-tree OID.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'beta\n');
  g(['add', 'b.txt']);
  const second = await computeIndexFingerprint({ repoRoot: repo, runGitBytes, runGit });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.writeTreeOid, second.writeTreeOid);
});

test('real git: an unmerged (conflicted) index is rejected as unmerged', async () => {
  const internal = await resolveInternalGit();
  if (!internal) { console.log('  SKIP real-git unmerged case — no compatible git resolved.'); return; }
  const exe = internal.execPath;
  const repo = mkRepo(exe);
  const g = (args: string[]) => execFileSync(exe, args, { cwd: repo }).toString();

  fs.writeFileSync(path.join(repo, 'c.txt'), 'base\n');
  g(['add', 'c.txt']); g(['commit', '-q', '-m', 'base']);
  // The default branch may be `main` or `master`; capture it before branching.
  const base = g(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  g(['checkout', '-q', '-b', 'left']);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'left\n');
  g(['commit', '-q', '-am', 'left']);
  g(['checkout', '-q', base]);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'right\n');
  g(['commit', '-q', '-am', 'right']);
  try { g(['merge', 'left']); } catch { /* expected conflict, leaves unmerged stages */ }

  const runGitBytes: IndexFingerprintRunGitBytes = (cwd, args, opts) =>
    realRunGitBytes(cwd, args, { ...opts, gitExe: exe }) as Promise<GitRunBytesResult>;
  const res = await computeIndexFingerprint({ repoRoot: repo, runGitBytes });
  assert.equal(res.hasUnmerged, true);
  assert.equal(res.writeTreeOid, null);
});

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
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
