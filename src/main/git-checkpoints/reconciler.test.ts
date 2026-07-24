// Git-Native WP-G1.8 — ref/DB crash-consistency reconciliation + temp-artifact sweeper.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/reconciler.test.js
//
// The ref-reconciliation proofs drive a REAL git in throwaway temp repos (create /
// adopt / unexpected-target conflict), because "create-only with expected-zero old
// OID, verify, mark ready" is exactly the behavior a fake could paper over. The
// dangling-open close, the temp-artifact sweeper (aged delete / fresh untouched /
// stat-can't-prove-stale / delete-failure-is-logged), and the paired-ref deletion
// mechanism use deterministic fakes (a fake store, a fake clock, a fake fs).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit } from './git-command';
import type { RecoveryOperation, TurnRecord, TurnStatus } from '../database';
import {
  reconcileWorkspaceRefs,
  closeDanglingOpenTurns,
  reconcileWorkspace,
  deleteRefPair,
  sweepTempArtifacts,
  type ReconcilerTurnStore,
  type ReconcilerRecoveryStore,
  type SweepFs,
  type ReconLogger,
} from './reconciler';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-recon-'): string {
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
  try { return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(); } catch { return null; }
}

// ── in-memory stores (mirror the WP-A0 semantics the reconciler relies on) ──────

class FakeTurnStore implements ReconcilerTurnStore {
  rows = new Map<string, Record<string, unknown>>();
  seed(id: string, workspaceId: string, extra: Record<string, unknown> = {}): void {
    this.rows.set(id, {
      id, workspaceId, status: 'accepted',
      beforeReady: false, afterReady: false,
      beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
      beforeQuality: null, afterQuality: null, failureReason: null,
      ...extra,
    });
  }
  listTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => ({ ...r } as unknown as TurnRecord));
  }
  // Terminal-bypass writer — mirrors dbReconcileTurnRecord (no status guard).
  reconcileTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    if ('status' in updates) throw new Error('reconcileTurnRecord may never change status');
    Object.assign(r, updates);
    return { ...r } as unknown as TurnRecord;
  }
  closeTurn(
    id: string,
    status: Exclude<TurnStatus, 'open'>,
    extra?: Record<string, unknown>,
    endedAt?: number | null,
  ): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.status !== 'open') return { ...r } as unknown as TurnRecord; // idempotent
    Object.assign(r, extra ?? {}, { status, endedAt: endedAt ?? 0 });
    return { ...r } as unknown as TurnRecord;
  }
}

class FakeRecoveryStore implements ReconcilerRecoveryStore {
  rows = new Map<string, Record<string, unknown>>();
  seed(id: string, workspaceId: string, extra: Record<string, unknown> = {}): void {
    this.rows.set(id, {
      id, workspaceId, status: 'completed', preReady: false,
      preOid: null, preRef: null, failureReason: null, ...extra,
    });
  }
  listRecoveryOperations(workspaceId: string): RecoveryOperation[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => ({ ...r } as unknown as RecoveryOperation));
  }
  updateRecoveryOperation(id: string, updates: Record<string, unknown>): RecoveryOperation | null {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, updates);
    return { ...r } as unknown as RecoveryOperation;
  }
}

function silentLogger(): { logger: ReconLogger; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    logger: { info: () => {}, warn: (m) => warns.push(m), error: (m) => errors.push(m) },
  };
}

const BEFORE_REF = 'refs/lares/checkpoints/WS/agent/turn/before';

// ══ ref reconciliation (REAL git) ═══════════════════════════════════════════════

test('kill after candidate-persist / before ref-create → reconciler CREATES ref + marks ready', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const store = new FakeTurnStore();
  // Terminal row with a persisted candidate but before_ready=0 and NO ref on disk.
  store.seed('T', 'WS', { status: 'accepted', beforeOid: c1, beforeRef: BEFORE_REF, beforeReady: false });
  assert.equal(refOid(repo, BEFORE_REF), null, 'precondition: ref absent');

  const summary = await reconcileWorkspaceRefs({ workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store, recoveryStore: new FakeRecoveryStore() });

  assert.equal(summary.created, 1);
  assert.equal(summary.adopted, 0);
  assert.equal(summary.conflicts.length, 0);
  assert.equal(refOid(repo, BEFORE_REF), c1, 'ref now points at the persisted candidate');
  assert.equal(store.rows.get('T')!.beforeReady, true, 'edge marked ready');
  assert.equal(store.rows.get('T')!.beforeQuality, 'reconciled', 'quality backfilled');
  assert.equal(store.rows.get('T')!.status, 'accepted', 'terminal status untouched');
});

test('kill after ref-create / before verify → reconciler ADOPTS the matching ref', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  git(repo, ['update-ref', BEFORE_REF, c1]); // ref already created, matching the candidate
  const store = new FakeTurnStore();
  store.seed('T', 'WS', { beforeOid: c1, beforeRef: BEFORE_REF, beforeReady: false });

  const summary = await reconcileWorkspaceRefs({ workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store, recoveryStore: new FakeRecoveryStore() });

  assert.equal(summary.adopted, 1);
  assert.equal(summary.created, 0);
  assert.equal(store.rows.get('T')!.beforeReady, true);
  assert.equal(refOid(repo, BEFORE_REF), c1, 'ref unchanged');
});

test('ref exists with an UNEXPECTED target → visible failure, NO overwrite, edge stays non-ready', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  git(repo, ['update-ref', BEFORE_REF, c2]); // ref points somewhere ELSE than the candidate c1
  const store = new FakeTurnStore();
  store.seed('T', 'WS', { beforeOid: c1, beforeRef: BEFORE_REF, beforeReady: false });
  const { logger, errors } = silentLogger();

  const summary = await reconcileWorkspaceRefs({ workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store, recoveryStore: new FakeRecoveryStore(), logger });

  assert.equal(summary.created, 0);
  assert.equal(summary.adopted, 0);
  assert.equal(summary.conflicts.length, 1, 'one conflict recorded');
  assert.equal(summary.conflicts[0].expected, c1);
  assert.equal(summary.conflicts[0].actual, c2);
  assert.equal(summary.conflicts[0].surface, 'turn-before');
  assert.equal(refOid(repo, BEFORE_REF), c2, 'ref NOT overwritten — still the unexpected target');
  assert.equal(store.rows.get('T')!.beforeReady, false, 'edge left non-ready');
  assert.equal(store.rows.get('T')!.failureReason, 'reconcile-ref-conflict:before');
  assert.ok(errors.some((m) => /REF CONFLICT/.test(m)), 'conflict logged visibly');
});

test('a non-ready edge with NO persisted candidate (abandoned) is left untouched', async () => {
  const { repo } = mkRepoTwoCommits();
  const store = new FakeTurnStore();
  store.seed('T', 'WS', { beforeOid: null, beforeRef: null, beforeReady: false }); // degraded/abandoned
  const summary = await reconcileWorkspaceRefs({ workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store, recoveryStore: new FakeRecoveryStore() });
  assert.equal(summary.created, 0);
  assert.equal(summary.adopted, 0);
  assert.equal(summary.conflicts.length, 0);
  assert.equal(store.rows.get('T')!.beforeReady, false, 'nothing to adopt → still non-ready');
});

test('recovery_operations.pre non-ready edge is reconciled + marked pre_ready', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const preRef = 'refs/lares/recovery/WS/op/pre';
  const recovery = new FakeRecoveryStore();
  recovery.seed('OP', 'WS', { preOid: c1, preRef, preReady: false });

  const summary = await reconcileWorkspaceRefs({
    workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: new FakeTurnStore(), recoveryStore: recovery,
  });

  assert.equal(summary.created, 1);
  assert.equal(refOid(repo, preRef), c1);
  assert.equal(recovery.rows.get('OP')!.preReady, true);
});

test('reconcileWorkspace: edges reconciled THEN dangling open rows closed crashed', async () => {
  const { repo, c1 } = mkRepoTwoCommits();
  const store = new FakeTurnStore();
  store.seed('done', 'WS', { status: 'accepted', beforeOid: c1, beforeRef: BEFORE_REF, beforeReady: false });
  store.seed('open1', 'WS', { status: 'open' });
  store.seed('open2', 'WS', { status: 'open' });

  const r = await reconcileWorkspace({ workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store, recoveryStore: new FakeRecoveryStore(), now: () => 777 });

  assert.equal(r.refs.created, 1, 'the persisted-non-ready edge was reconciled');
  assert.equal(r.closedOpen, 2, 'both dangling open rows closed');
  assert.equal(store.rows.get('open1')!.status, 'crashed');
  assert.equal(store.rows.get('open2')!.status, 'crashed');
  assert.equal(store.rows.get('done')!.status, 'accepted');
  assert.equal(store.rows.get('done')!.beforeReady, true);
});

test('closeDanglingOpenTurns is idempotent and routes through a custom close seam', async () => {
  const store = new FakeTurnStore();
  store.seed('o1', 'WS', { status: 'open' });
  store.seed('t1', 'WS', { status: 'accepted' });
  assert.equal(closeDanglingOpenTurns({ workspaceId: 'WS', turnStore: store, now: () => 1 }), 1);
  assert.equal(store.rows.get('o1')!.status, 'crashed');
  assert.equal(closeDanglingOpenTurns({ workspaceId: 'WS', turnStore: store, now: () => 1 }), 0, 'second pass finds nothing open');

  // The pluggable close seam (G1.7 passes coordinator.reconcileOpenTurns).
  const { repo } = mkRepoTwoCommits();
  const store2 = new FakeTurnStore();
  store2.seed('o', 'WS', { status: 'open' });
  let seamCalledWith = '';
  const r = await reconcileWorkspace({
    workspaceId: 'WS', repoRoot: repo, gitExe: EXE, turnStore: store2, recoveryStore: new FakeRecoveryStore(),
    closeOpenTurns: (wsId) => { seamCalledWith = wsId; return 99; },
  });
  assert.equal(seamCalledWith, 'WS', 'close seam invoked with the workspace id');
  assert.equal(r.closedOpen, 99, 'the seam return is surfaced');
  assert.equal(store2.rows.get('o')!.status, 'open', 'custom seam owns the close — store left as-is');
});

// ══ paired-ref deletion (REAL git, atomic) ══════════════════════════════════════

test('deleteRefPair removes both edges atomically via update-ref --stdin', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const beforeRef = 'refs/lares/checkpoints/WS/a/t/before';
  const afterRef = 'refs/lares/checkpoints/WS/a/t/after';
  git(repo, ['update-ref', beforeRef, c1]);
  git(repo, ['update-ref', afterRef, c2]);

  const res = await deleteRefPair({
    repoRoot: repo, gitExe: EXE, runGit: realRunGit,
    deletions: [{ ref: beforeRef, oldOid: c1 }, { ref: afterRef, oldOid: c2 }],
  });
  assert.equal(res.ok, true);
  assert.equal(refOid(repo, beforeRef), null, 'before edge deleted');
  assert.equal(refOid(repo, afterRef), null, 'after edge deleted');
});

test('deleteRefPair is all-or-nothing: a stale expected old-OID aborts the whole batch', async () => {
  const { repo, c1, c2 } = mkRepoTwoCommits();
  const beforeRef = 'refs/lares/checkpoints/WS/a/t/before';
  const afterRef = 'refs/lares/checkpoints/WS/a/t/after';
  git(repo, ['update-ref', beforeRef, c1]);
  git(repo, ['update-ref', afterRef, c2]);

  // Second deletion carries the WRONG expected old-OID → the transaction must fail
  // and neither ref may be deleted.
  const res = await deleteRefPair({
    repoRoot: repo, gitExe: EXE, runGit: realRunGit,
    deletions: [{ ref: beforeRef, oldOid: c1 }, { ref: afterRef, oldOid: c1 /* wrong */ }],
  });
  assert.equal(res.ok, false, 'batch failed');
  assert.equal(refOid(repo, beforeRef), c1, 'before edge NOT deleted (atomic abort)');
  assert.equal(refOid(repo, afterRef), c2, 'after edge NOT deleted (atomic abort)');
});

// ══ temp-artifact sweeper (fake fs + fake clock) ═════════════════════════════════

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A fake fs whose files carry a controllable mtime and an optional unlink error. */
function makeFakeFs(files: Record<string, { mtimeMs: number; unlinkThrows?: string }>): {
  fsx: SweepFs; deleted: string[]; present(): string[];
} {
  const deleted: string[] = [];
  const fsx: SweepFs = {
    readdirSync: () => Object.keys(files),
    statSync: (p) => {
      const name = path.basename(p);
      const f = files[name];
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: f.mtimeMs };
    },
    unlinkSync: (p) => {
      const name = path.basename(p);
      const f = files[name];
      if (f?.unlinkThrows) throw Object.assign(new Error(f.unlinkThrows), { code: f.unlinkThrows });
      delete files[name];
      deleted.push(name);
    },
  };
  return { fsx, deleted, present: () => Object.keys(files) };
}

test('sweeper deletes an aged orphan index + its .lock; leaves a fresh one untouched', () => {
  const NOW = 10_000_000;
  const GRACE = 1000;
  const files = {
    [`lares-idx-${UUID_A}`]: { mtimeMs: NOW - GRACE - 1 },      // aged → delete
    [`lares-idx-${UUID_A}.lock`]: { mtimeMs: NOW - GRACE - 1 }, // aged → delete
    [`lares-idx-${UUID_B}`]: { mtimeMs: NOW - GRACE + 500 },    // fresh → keep
    'unrelated-file.txt': { mtimeMs: 0 },                       // never matched
  };
  const { fsx, present } = makeFakeFs(files);
  const s = sweepTempArtifacts({ tmpDir: '/tmp', graceMs: GRACE, now: () => NOW, fsx });

  assert.deepEqual(s.deleted.sort(), [`lares-idx-${UUID_A}`, `lares-idx-${UUID_A}.lock`].sort());
  assert.deepEqual(s.skippedFresh, [`lares-idx-${UUID_B}`]);
  assert.ok(present().includes(`lares-idx-${UUID_B}`), 'fresh artifact untouched');
  assert.ok(present().includes('unrelated-file.txt'), 'unrelated file never considered');
});

test('sweeper NEVER deletes anything at exactly the grace boundary (age < grace only)', () => {
  const NOW = 10_000_000;
  const GRACE = 1000;
  const files = { [`lares-idx-${UUID_A}`]: { mtimeMs: NOW - GRACE } }; // age == grace → NOT older
  const { fsx } = makeFakeFs(files);
  const s = sweepTempArtifacts({ tmpDir: '/tmp', graceMs: GRACE, now: () => NOW, fsx });
  assert.deepEqual(s.deleted, []);
  assert.deepEqual(s.skippedFresh, [`lares-idx-${UUID_A}`]);
});

test('sweeper skips a file it cannot stat (cannot prove stale)', () => {
  const files = { [`lares-idx-${UUID_A}`]: { mtimeMs: 0 } };
  const fsx: SweepFs = {
    readdirSync: () => Object.keys(files),
    statSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    unlinkSync: () => { throw new Error('should never be called'); },
  };
  const s = sweepTempArtifacts({ tmpDir: '/tmp', graceMs: 1, now: () => 1e9, fsx });
  assert.deepEqual(s.unreadable, [`lares-idx-${UUID_A}`]);
  assert.deepEqual(s.deleted, []);
});

test('sweeper LOGS (does not throw) when an aged artifact fails to delete', () => {
  const NOW = 10_000_000;
  const files = { [`lares-idx-${UUID_A}`]: { mtimeMs: 0, unlinkThrows: 'EBUSY' } };
  const { fsx } = makeFakeFs(files);
  const { logger, warns } = silentLogger();
  let s!: ReturnType<typeof sweepTempArtifacts>;
  assert.doesNotThrow(() => { s = sweepTempArtifacts({ tmpDir: '/tmp', graceMs: 1, now: () => NOW, fsx, logger }); });
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].name, `lares-idx-${UUID_A}`);
  assert.equal(s.deleted.length, 0);
  assert.ok(warns.some((m) => /could not delete/.test(m)), 'delete failure logged');
});

test('sweeper tolerates an unreadable temp dir (returns an empty summary, no throw)', () => {
  const fsx: SweepFs = {
    readdirSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    statSync: () => { throw new Error('unused'); },
    unlinkSync: () => { throw new Error('unused'); },
  };
  let s!: ReturnType<typeof sweepTempArtifacts>;
  assert.doesNotThrow(() => { s = sweepTempArtifacts({ tmpDir: '/nope', fsx }); });
  assert.deepEqual(s.deleted, []);
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G1.8 ref tests need real git.');
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
