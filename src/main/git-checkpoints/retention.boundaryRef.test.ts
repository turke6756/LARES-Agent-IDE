// Save-card SC-WP-3F — durable boundary-ref retention lifecycle.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/retention.boundaryRef.test.js
//
// `partitionBoundaryRefs` is pure and driven with fixed records. `reconcileBoundaryRefs`
// and the "does not draw pin quota" property drive a REAL git in throwaway temp repos:
// "the active ref still resolves; the committed/superseded/abandoned refs are gone" and
// "an object reachable only from an active boundary ref costs ZERO pin quota" are exactly
// the behaviors a fake could paper over.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit } from './git-command';
import {
  partitionBoundaryRefs,
  type BoundaryRefRecord,
} from './protection-policy';
import { reconcileBoundaryRefs } from './retention';
import {
  finalizationRef,
  forceCreateFinalizationRef,
  resolveFinalizationRef,
} from './finalization-refs';
import { accountAndSelectPins } from './pin-accounting';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-bref-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(EXE, args, { cwd, input }).toString();
}
function refOid(repo: string, ref: string): string | null {
  try { return git(repo, ['rev-parse', '--verify', ref]).trim(); } catch { return null; }
}
/** A one-commit repo. */
function mkRepo(): { repo: string; head: string } {
  const repo = mkTmpDir();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'c1']);
  return { repo, head: git(repo, ['rev-parse', 'HEAD']).trim() };
}
/** Build a commit reachable from NOWHERE but the ref we point at it, via plumbing —
 *  no branch touches its blob, so its objects are reachable only through a boundary
 *  ref. Returns { commit, blob } where `blob` is the unique file's blob oid. */
function danglingCommitWithUniqueBlob(repo: string, tag: string): { commit: string; blob: string } {
  const blob = git(repo, ['hash-object', '-w', '--stdin'], `unique-${tag}\n`).trim();
  const tree = git(repo, ['mktree'], `100644 blob ${blob}\t${tag}.txt\n`).trim();
  const commit = git(repo, ['commit-tree', tree, '-m', `boundary-${tag}`]).trim();
  return { commit, blob };
}

// ── partitionBoundaryRefs (pure) ─────────────────────────────────────────────────

function rec(boundaryRef: string | null, lifecycleStatus: BoundaryRefRecord['lifecycleStatus']): BoundaryRefRecord {
  return { boundaryRef, lifecycleStatus };
}

test('partitionBoundaryRefs keeps active refs protected and releases the three terminal states', () => {
  const part = partitionBoundaryRefs([
    rec('refs/lares/finalizations/A/1', 'active'),
    rec('refs/lares/finalizations/B/1', 'committed'),
    rec('refs/lares/finalizations/C/1', 'superseded'),
    rec('refs/lares/finalizations/D/1', 'abandoned'),
  ]);
  assert.deepEqual(part.protectedRefs, ['refs/lares/finalizations/A/1']);
  assert.deepEqual(part.releasableRefs, [
    'refs/lares/finalizations/B/1',
    'refs/lares/finalizations/C/1',
    'refs/lares/finalizations/D/1',
  ]);
});

test('partitionBoundaryRefs ignores rows with no ref and de-duplicates + sorts', () => {
  const part = partitionBoundaryRefs([
    rec(null, 'active'),
    rec('', 'committed'),
    rec('refs/lares/finalizations/Z/2', 'active'),
    rec('refs/lares/finalizations/Z/2', 'active'), // dup active
    rec('refs/lares/finalizations/Y/1', 'committed'),
    rec('refs/lares/finalizations/Y/1', 'committed'), // dup releasable
  ]);
  assert.deepEqual(part.protectedRefs, ['refs/lares/finalizations/Z/2']);
  assert.deepEqual(part.releasableRefs, ['refs/lares/finalizations/Y/1']);
});

test('partitionBoundaryRefs never releases a ref that any row still marks active', () => {
  // Defensive: one ref string appearing both active and terminal stays protected.
  const part = partitionBoundaryRefs([
    rec('refs/lares/finalizations/S/1', 'superseded'),
    rec('refs/lares/finalizations/S/1', 'active'),
  ]);
  assert.deepEqual(part.protectedRefs, ['refs/lares/finalizations/S/1']);
  assert.deepEqual(part.releasableRefs, []);
});

// ── reconcileBoundaryRefs (real git) ─────────────────────────────────────────────

test('reconcileBoundaryRefs retains the active ref and releases committed/superseded/abandoned', async () => {
  const { repo, head } = mkRepo();
  const active = finalizationRef('pkg-active', 1);
  const committed = finalizationRef('pkg-committed', 1);
  const superseded = finalizationRef('pkg-superseded', 1);
  const abandoned = finalizationRef('pkg-abandoned', 1);
  for (const ref of [active, committed, superseded, abandoned]) {
    await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: head });
  }

  const result = await reconcileBoundaryRefs({
    repoRoot: repo,
    gitExe: EXE,
    runGit,
    listBoundaryRefRecords: () => [
      rec(active, 'active'),
      rec(committed, 'committed'),
      rec(superseded, 'superseded'),
      rec(abandoned, 'abandoned'),
    ],
  });

  assert.equal(result.releaseOk, true);
  assert.deepEqual(result.protectedRefs, [active]);
  assert.deepEqual([...result.releasedRefs].sort(), [committed, superseded, abandoned].sort());

  // The active ref is RETAINED; each terminal-lifecycle ref is RELEASED (deleted).
  assert.equal(await resolveFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: active }), head);
  assert.equal(refOid(repo, committed), null);
  assert.equal(refOid(repo, superseded), null);
  assert.equal(refOid(repo, abandoned), null);
});

test('reconcileBoundaryRefs is a no-op when nothing has left active', async () => {
  const { repo, head } = mkRepo();
  const active = finalizationRef('pkg-only-active', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: active, oid: head });

  let deleteCalls = 0;
  const result = await reconcileBoundaryRefs({
    repoRoot: repo,
    gitExe: EXE,
    runGit,
    listBoundaryRefRecords: () => [rec(active, 'active')],
    deleteRefs: async (refs) => { deleteCalls++; return { ok: true, code: 0, stderr: refs.join(',') }; },
  });

  assert.equal(deleteCalls, 0, 'no delete batch is issued when nothing is releasable');
  assert.deepEqual(result, { protectedRefs: [active], releasedRefs: [], releaseOk: true });
  assert.equal(await resolveFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: active }), head);
});

test('reconcileBoundaryRefs surfaces a nonfatal delete failure', async () => {
  const { repo } = mkRepo();
  const superseded = finalizationRef('pkg-fail', 1);
  const result = await reconcileBoundaryRefs({
    repoRoot: repo,
    gitExe: EXE,
    runGit,
    listBoundaryRefRecords: () => [rec(superseded, 'superseded')],
    deleteRefs: async () => ({ ok: false, code: 1, stderr: 'lock contention' }),
  });
  assert.equal(result.releaseOk, false);
  assert.deepEqual(result.releasedRefs, [superseded]);
  assert.deepEqual(result.protectedRefs, []);
});

// ── the protected set does NOT draw down the pin quota ────────────────────────────

test('an object reachable only from an active boundary ref costs ZERO pin quota', async () => {
  const { repo } = mkRepo();
  // A blob reachable ONLY through a dangling commit we pin with a boundary ref.
  const { commit, blob } = danglingCommitWithUniqueBlob(repo, 'pinned');
  const boundaryRef = finalizationRef('pkg-reachable', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: boundaryRef, oid: commit });

  // partitionBoundaryRefs is the source of the protected reachable-root set.
  const { protectedRefs } = partitionBoundaryRefs([rec(boundaryRef, 'active')]);
  assert.deepEqual(protectedRefs, [boundaryRef]);

  const now = 1_000_000;
  const candidate = {
    turnId: 't1',
    edge: 'after' as const,
    dirtyEntries: [{ entryId: 'e1', rawWorktreeBlobOid: blob }],
    normalPruneEligibleAt: now, // extension live
  };

  // With the active boundary ref as a reachable root, the blob is reachable → 0 cost.
  const withPin = await accountAndSelectPins({
    repoRoot: repo, candidates: [candidate], reachableRoots: ['HEAD', ...protectedRefs], now, runGit, gitExe: EXE,
  });
  assert.equal(withPin.retainedEdges.length, 1);
  assert.equal(withPin.retainedEdges[0].estimatedBytes, 0, 'reachable-from-boundary blob draws zero pin quota');

  // With the ref RELEASED (protected set empty), the same blob is unreachable → charged.
  const released = await accountAndSelectPins({
    repoRoot: repo, candidates: [candidate], reachableRoots: ['HEAD'], now, runGit, gitExe: EXE,
  });
  assert.equal(released.retainedEdges.length, 1);
  assert.ok(released.retainedEdges[0].estimatedBytes > 0, 'once released the blob is charged against the quota');
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-3F boundary-ref tests need real git.');
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
