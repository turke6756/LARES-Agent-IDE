// Planning-surface WP-P5C — durable plan-execution baseline-ref primitives.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/plan-baseline-refs.test.js
//
// The ref assembly/parse round-trip is pure and driven with fixed strings. The
// probe / force-create / resolve / enumerate / reconcile primitives drive a REAL git
// in throwaway temp repos, because "unborn HEAD → unborn (not an error)", "bare repo
// rejected", "force to the pinned oid → idempotent", and "an orphan ref (no run row)
// is swept while a known ref survives" are exactly the behaviors a fake could paper
// over.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import {
  PLAN_BASELINE_PREFIX,
  planBaselineRef,
  parsePlanBaselineRef,
  probePlanBaseline,
  forceCreatePlanBaselineRef,
  resolvePlanBaselineRef,
  enumeratePlanBaselineRefs,
  reconcilePlanBaselineOrphans,
} from './plan-baseline-refs';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-planref-'): string {
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
function mkRepoOneCommit(): { repo: string; head: string } {
  const repo = mkTmpDir();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'c1']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  return { repo, head };
}

// ── pure ref assembly / parse ──────────────────────────────────────────────────

test('planBaselineRef encodes both ids under the prefix (never raw)', () => {
  const ref = planBaselineRef('plan-abc', 'run-xyz');
  assert.ok(ref.startsWith(`${PLAN_BASELINE_PREFIX}/`));
  assert.ok(!ref.includes('plan-abc'));
  assert.ok(!ref.includes('run-xyz'));
});

test('planBaselineRef round-trips through parsePlanBaselineRef', () => {
  for (const [pid, rid] of [['plan-1', 'run-1'], ['weird/id with spaces', 'r@{2}'], ['한글', 'r-7']] as const) {
    const parsed = parsePlanBaselineRef(planBaselineRef(pid, rid));
    assert.deepEqual(parsed, { planId: pid, runId: rid });
  }
});

test('parsePlanBaselineRef returns null for a non-baseline / mangled ref', () => {
  assert.equal(parsePlanBaselineRef('refs/heads/main'), null);
  assert.equal(parsePlanBaselineRef(`${PLAN_BASELINE_PREFIX}/only-one-segment`), null);
  assert.equal(parsePlanBaselineRef(`${PLAN_BASELINE_PREFIX}/a/b/c`), null);
  assert.equal(parsePlanBaselineRef(`${PLAN_BASELINE_PREFIX}/!!!/@@@`), null);
});

test('planBaselineRef rejects empty ids', () => {
  assert.throws(() => planBaselineRef('', 'r'), /planId/);
  assert.throws(() => planBaselineRef('p', ''), /runId/);
});

// ── probe: head / unborn / non-repo / bare ─────────────────────────────────────

test('probePlanBaseline returns head + the pinned HEAD oid for a repo with commits', async () => {
  const { repo, head } = mkRepoOneCommit();
  const probe = await probePlanBaseline({ repoRoot: repo, gitExe: EXE });
  assert.deepEqual(probe, { ok: true, kind: 'head', headOid: head });
});

test('probePlanBaseline returns unborn for an initialized repo with no commits', async () => {
  const repo = mkTmpDir();
  git(repo, ['init', '-q']);
  const probe = await probePlanBaseline({ repoRoot: repo, gitExe: EXE });
  assert.deepEqual(probe, { ok: true, kind: 'unborn' });
});

test('probePlanBaseline rejects a non-repository directory', async () => {
  const dir = mkTmpDir();
  const probe = await probePlanBaseline({ repoRoot: dir, gitExe: EXE });
  assert.deepEqual(probe, { ok: false, reason: 'not-a-repo' });
});

test('probePlanBaseline rejects a bare repository', async () => {
  const bare = mkTmpDir();
  git(bare, ['init', '-q', '--bare']);
  const probe = await probePlanBaseline({ repoRoot: bare, gitExe: EXE });
  assert.deepEqual(probe, { ok: false, reason: 'bare-repo' });
});

// ── force-create / resolve ─────────────────────────────────────────────────────

test('forceCreatePlanBaselineRef pins the oid and is idempotent on retry', async () => {
  const { repo, head } = mkRepoOneCommit();
  const ref = planBaselineRef('plan-1', 'run-1');
  const first = await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref, oid: head });
  assert.equal(first.ok, true);
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref }), head);
  // Retry (crash between ref + txn) re-lands on the same value — never a foreign clobber.
  const again = await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref, oid: head });
  assert.equal(again.ok, true);
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref }), head);
});

test('forceCreatePlanBaselineRef rejects a non-oid target without touching refs', async () => {
  const { repo } = mkRepoOneCommit();
  const ref = planBaselineRef('plan-1', 'run-bad');
  const res = await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref, oid: 'not-an-oid' });
  assert.equal(res.ok, false);
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref }), null);
});

test('resolvePlanBaselineRef returns null for a ref that does not exist', async () => {
  const { repo } = mkRepoOneCommit();
  const ref = planBaselineRef('plan-1', 'run-absent');
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref }), null);
});

// ── enumerate + orphan reconciliation ──────────────────────────────────────────

test('enumeratePlanBaselineRefs lists exactly the created baseline refs', async () => {
  const { repo, head } = mkRepoOneCommit();
  const r1 = planBaselineRef('plan-1', 'run-1');
  const r2 = planBaselineRef('plan-1', 'run-2');
  await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: r1, oid: head });
  await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: r2, oid: head });
  const listed = (await enumeratePlanBaselineRefs({ repoRoot: repo, gitExe: EXE })).sort();
  assert.deepEqual(listed, [r1, r2].sort());
});

test('reconcilePlanBaselineOrphans deletes refs with no run row and retains known ones', async () => {
  const { repo, head } = mkRepoOneCommit();
  const known = planBaselineRef('plan-1', 'run-known');
  const orphan = planBaselineRef('plan-1', 'run-orphan');
  await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: known, oid: head });
  await forceCreatePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: orphan, oid: head });

  const result = await reconcilePlanBaselineOrphans({
    repoRoot: repo, gitExe: EXE, knownRunIds: new Set(['run-known']),
  });
  assert.deepEqual(result.deleted, [orphan]);
  assert.deepEqual(result.retained, [known]);
  // The orphan is gone; the known ref survives (an archived run keeps its ref too).
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: orphan }), null);
  assert.equal(await resolvePlanBaselineRef({ repoRoot: repo, gitExe: EXE, ref: known }), head);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('No internal git available — cannot run plan-baseline-refs tests.');
    process.exit(1);
  }
  EXE = internal.execPath;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
