// Save-card SC-WP-3C — durable finalization boundary-ref primitives.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/finalization-refs.test.js
//
// The ref assembly/parse round-trip is pure and driven with fixed strings. The
// force-create / resolve / enumerate / delete primitives drive a REAL git in
// throwaway temp repos, because "force to the computed oid → idempotent" and
// "resolve returns null when the ref is gone" are exactly the behaviors a fake
// could paper over.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import {
  FINALIZATIONS_PREFIX,
  finalizationRef,
  parseFinalizationRef,
  forceCreateFinalizationRef,
  resolveFinalizationRef,
  enumerateFinalizationRefs,
  deleteFinalizationRefs,
} from './finalization-refs';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-finref-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function git(cwd: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd }).toString();
}
/** A repo with two commits; returns the repo + the two commit OIDs. */
function mkRepoTwoCommits(): { repo: string; c1: string; c2: string } {
  const repo = mkTmpDir();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'c1']);
  const c1 = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'c2']);
  const c2 = git(repo, ['rev-parse', 'HEAD']).trim();
  return { repo, c1, c2 };
}
function refOid(repo: string, ref: string): string | null {
  try { return git(repo, ['rev-parse', '--verify', ref]).trim(); } catch { return null; }
}

// ── pure ref assembly / parse ──────────────────────────────────────────────────

test('finalizationRef encodes the packageId and emits the revision verbatim', () => {
  const ref = finalizationRef('pkg-abc', 3);
  assert.ok(ref.startsWith(`${FINALIZATIONS_PREFIX}/`));
  assert.ok(ref.endsWith('/3'));
  // packageId is base64url-encoded — never appears raw, never introduces a slash.
  assert.ok(!ref.includes('pkg-abc'));
});

test('finalizationRef round-trips through parseFinalizationRef', () => {
  for (const [pkg, rev] of [['pkg-1', 1], ['weird/id with spaces', 42], ['한글', 7]] as const) {
    const parsed = parseFinalizationRef(finalizationRef(pkg, rev));
    assert.deepEqual(parsed, { packageId: pkg, revision: rev });
  }
});

test('finalizationRef rejects a non-positive or non-integer revision', () => {
  assert.throws(() => finalizationRef('p', 0));
  assert.throws(() => finalizationRef('p', -1));
  assert.throws(() => finalizationRef('p', 1.5));
});

test('parseFinalizationRef rejects non-finalization / malformed refs', () => {
  assert.equal(parseFinalizationRef('refs/heads/main'), null);
  assert.equal(parseFinalizationRef('refs/lares/checkpoints/x/y/z/after'), null);
  assert.equal(parseFinalizationRef(`${FINALIZATIONS_PREFIX}/enc/0`), null); // zero revision
  assert.equal(parseFinalizationRef(`${FINALIZATIONS_PREFIX}/enc/01`), null); // leading zero
  assert.equal(parseFinalizationRef(`${FINALIZATIONS_PREFIX}/enc/abc`), null); // non-numeric
  assert.equal(parseFinalizationRef(`${FINALIZATIONS_PREFIX}/enc/1/extra`), null); // too deep
});

// ── real-git primitives ─────────────────────────────────────────────────────────

test('forceCreateFinalizationRef creates the ref at the boundary oid', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-create', 1);
  const res = await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 });
  assert.equal(res.ok, true);
  assert.equal(refOid(repo, ref), c1);
});

test('forceCreateFinalizationRef is idempotent — re-force to the same oid is a no-op success', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-idem', 1);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 })).ok, true);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 })).ok, true);
  assert.equal(refOid(repo, ref), c1);
});

test('forceCreateFinalizationRef force-moves an existing ref to the computed oid', async () => {
  // A retry that recomputes the same ref at a NEW boundary oid must land on the new
  // oid (force-to-computed), never fail on a stale expected-old.
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-move', 1);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 })).ok, true);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c2 })).ok, true);
  assert.equal(refOid(repo, ref), c2);
});

test('forceCreateFinalizationRef rejects an invalid oid and a nonexistent oid', async () => {
  const { repo } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-bad', 1);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: 'not-an-oid' })).ok, false);
  const missing = 'a'.repeat(40);
  assert.equal((await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: missing })).ok, false);
  assert.equal(refOid(repo, ref), null); // nothing created
});

test('resolveFinalizationRef returns the oid when present and null when gone', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-resolve', 1);
  assert.equal(await resolveFinalizationRef({ repoRoot: repo, gitExe: EXE, ref }), null);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 });
  assert.equal(await resolveFinalizationRef({ repoRoot: repo, gitExe: EXE, ref }), c1);
  git(repo, ['update-ref', '-d', ref]);
  assert.equal(await resolveFinalizationRef({ repoRoot: repo, gitExe: EXE, ref }), null);
});

test('enumerateFinalizationRefs lists only finalization refs', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const r1 = finalizationRef('pkg-enum-a', 1);
  const r2 = finalizationRef('pkg-enum-b', 2);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: r1, oid: c1 });
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: r2, oid: c2 });
  // A checkpoint-namespace ref must NOT be enumerated.
  git(repo, ['update-ref', 'refs/lares/checkpoints/x/y/z/after', c1]);
  const refs = await enumerateFinalizationRefs({ repoRoot: repo, gitExe: EXE });
  assert.deepEqual([...refs].sort(), [r1, r2].sort());
});

test('deleteFinalizationRefs removes a batch atomically', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const r1 = finalizationRef('pkg-del-a', 1);
  const r2 = finalizationRef('pkg-del-b', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: r1, oid: c1 });
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: r2, oid: c2 });
  const del = await deleteFinalizationRefs({ repoRoot: repo, gitExe: EXE, refs: [r1, r2] });
  assert.equal(del.ok, true);
  assert.equal(refOid(repo, r1), null);
  assert.equal(refOid(repo, r2), null);
});

test('deleteFinalizationRefs on an empty batch is a no-op success', async () => {
  const { repo } = mkRepoTwoCommits();
  assert.deepEqual(await deleteFinalizationRefs({ repoRoot: repo, gitExe: EXE, refs: [] }), {
    ok: true, code: 0, stderr: '',
  });
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-3C ref tests need real git.');
    process.exit(1);
  }
  EXE = internal.execPath;

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
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
