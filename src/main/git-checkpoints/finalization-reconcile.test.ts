// Save-card SC-WP-3C — finalization boundary-ref startup reconciliation
// (reconcileFinalizationRefs, in commit-reconciler.ts).
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/finalization-reconcile.test.js
//
// Drives a REAL git in throwaway temp repos (orphan-ref GC + resolve-or-downgrade
// need genuine refs) with an in-memory active-finalization store. Proves both
// directions of the restart contract: delete every finalization ref with no active
// row, and downgrade a `ready` active row whose ref no longer resolves.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { finalizationRef, forceCreateFinalizationRef } from './finalization-refs';
import {
  reconcileFinalizationRefs,
  type ActiveFinalizationRow,
  type FinalizationReconcileStore,
} from './commit-reconciler';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function git(cwd: string, args: string[]): string { return execFileSync(EXE, args, { cwd }).toString(); }
function refOid(repo: string, ref: string): string | null {
  try { return git(repo, ['rev-parse', '--verify', ref]).trim(); } catch { return null; }
}
function mkRepoTwoCommits(): { repo: string; c1: string; c2: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-finrecon-'));
  trash.push(repo);
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

class FakeReconcileStore implements FinalizationReconcileStore {
  rows: (ActiveFinalizationRow & { repositoryKey: string })[] = [];
  downgrades: { id: string; status: string }[] = [];
  seed(repositoryKey: string, row: ActiveFinalizationRow): void {
    this.rows.push({ ...row, repositoryKey });
  }
  listActiveFinalizations(repositoryKey: string): ActiveFinalizationRow[] {
    return this.rows.filter((r) => r.repositoryKey === repositoryKey).map((r) => ({
      id: r.id, packageId: r.packageId, packageRevision: r.packageRevision,
      boundaryRef: r.boundaryRef, boundaryStatus: r.boundaryStatus,
    }));
  }
  setPackageFinalizationBoundaryStatus(id: string, status: never): void {
    this.downgrades.push({ id, status: status as unknown as string });
    const r = this.rows.find((x) => x.id === id);
    if (r) r.boundaryStatus = status as unknown as ActiveFinalizationRow['boundaryStatus'];
  }
}

// ── orphan-ref GC ─────────────────────────────────────────────────────────────

test('an orphan ref (no active row) is deleted; a ref with an active row is kept', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const kept = finalizationRef('pkg-keep', 1);
  const orphan = finalizationRef('pkg-orphan', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: kept, oid: c1 });
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: orphan, oid: c2 });

  const store = new FakeReconcileStore();
  store.seed('repo-1', { id: 'fin-keep', packageId: 'pkg-keep', packageRevision: 1, boundaryRef: kept, boundaryStatus: 'ready' });

  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res.deletedOrphanRefs, [orphan]);
  assert.equal(refOid(repo, orphan), null, 'orphan ref deleted');
  assert.equal(refOid(repo, kept), c1, 'referenced ref kept');
});

test('a finalization ref with NO active row at all is GC\'d', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const orphan = finalizationRef('pkg-solo', 5);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: orphan, oid: c1 });
  const store = new FakeReconcileStore(); // empty
  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res.deletedOrphanRefs, [orphan]);
  assert.equal(refOid(repo, orphan), null);
});

// ── ready-row downgrade ─────────────────────────────────────────────────────────

test('a ready active row whose ref no longer resolves is downgraded to unavailable', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const present = finalizationRef('pkg-present', 1);
  const missing = finalizationRef('pkg-missing', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: present, oid: c1 });
  // `missing` ref intentionally never created — its ready row is dangling.

  const store = new FakeReconcileStore();
  store.seed('repo-1', { id: 'fin-present', packageId: 'pkg-present', packageRevision: 1, boundaryRef: present, boundaryStatus: 'ready' });
  store.seed('repo-1', { id: 'fin-missing', packageId: 'pkg-missing', packageRevision: 1, boundaryRef: missing, boundaryStatus: 'ready' });

  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res.downgraded, ['fin-missing']);
  assert.deepEqual(store.downgrades, [{ id: 'fin-missing', status: 'unavailable' }]);
  // The resolvable present row is untouched.
  assert.ok(!store.downgrades.some((d) => d.id === 'fin-present'));
});

test('an already-unavailable active row is not re-probed for downgrade', async () => {
  const { repo } = mkRepoTwoCommits();
  const missing = finalizationRef('pkg-un', 1);
  const store = new FakeReconcileStore();
  store.seed('repo-1', { id: 'fin-un', packageId: 'pkg-un', packageRevision: 1, boundaryRef: missing, boundaryStatus: 'unavailable' });
  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res.downgraded, []);
  assert.deepEqual(store.downgrades, []);
});

test('downgrade is scoped by repository key — another repo\'s rows are never probed here', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const mine = finalizationRef('pkg-mine', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref: mine, oid: c1 });
  const store = new FakeReconcileStore();
  store.seed('repo-1', { id: 'fin-mine', packageId: 'pkg-mine', packageRevision: 1, boundaryRef: mine, boundaryStatus: 'ready' });
  // A ready row for a DIFFERENT repo whose ref is absent HERE — must not be downgraded
  // by this repo's pass (its own repo will handle it).
  store.seed('repo-2', { id: 'fin-other', packageId: 'pkg-other', packageRevision: 1, boundaryRef: finalizationRef('pkg-other', 1), boundaryStatus: 'ready' });

  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res.downgraded, []);
  assert.deepEqual(store.downgrades, []);
});

test('a clean repo with matching refs reconciles to a no-op', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const ref = finalizationRef('pkg-clean', 1);
  await forceCreateFinalizationRef({ repoRoot: repo, gitExe: EXE, ref, oid: c1 });
  const store = new FakeReconcileStore();
  store.seed('repo-1', { id: 'fin-clean', packageId: 'pkg-clean', packageRevision: 1, boundaryRef: ref, boundaryStatus: 'ready' });
  const res = await reconcileFinalizationRefs({ repoRoot: repo, repositoryKey: 'repo-1', gitExe: EXE, store });
  assert.deepEqual(res, { deletedOrphanRefs: [], downgraded: [] });
  assert.equal(refOid(repo, ref), c1);
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-3C reconcile tests need real git.');
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
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
