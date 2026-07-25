// Git-Native WP-G3.3 — retention + distill-before-prune + loose-object maintenance.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/retention.test.js
//
// The distill-before-prune ordering proofs, the accepted-task thinning, and the
// pruned-edge refusal drive a REAL git in throwaway temp repos — "distill FIRST,
// then delete refs" and "a deleted ref no longer resolves" are exactly the
// behaviors a fake could paper over. The maintenance idle-only / threshold / lock
// branches use the real CheckpointQueue plus a fake runGit where a real
// `git maintenance` run would be slow or unobservable. Pure helpers
// (decidePruneEdges / parseNumstat / parseCountObjects / capUtf8) are unit-tested.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, GitCommandError, type GitRunResult } from './git-command';
import { CheckpointQueue } from './checkpoint-queue';
import { CheckpointService } from './checkpoint-service';
import type { RunGitLike } from './checkpoint-service';
import type { TurnRecord } from '../database';
import {
  TURN_RECORD_EXPORT_ALLOWLIST,
  TURN_RECORD_EXPORT_EXCLUDED,
} from '../database';
import {
  runRetentionPass,
  runLooseObjectMaintenance,
  reportStorage,
  decidePruneEdges,
  parseNumstat,
  parseCountObjects,
  capUtf8,
  type RetentionTurnStore,
  type RetentionDeps,
} from './retention';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-retention-'): string {
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
function refOid(repo: string, ref: string): string | null {
  try { return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(); } catch { return null; }
}

const WS = 'WS';
const AGENT = 'agent';
function beforeRef(turn: string): string { return `refs/lares/checkpoints/${WS}/${AGENT}/${turn}/before`; }
function afterRef(turn: string): string { return `refs/lares/checkpoints/${WS}/${AGENT}/${turn}/after`; }

/**
 * A repo with a base commit plus a BEFORE and an AFTER commit that differ in a
 * witnessed path `w.txt` (and an unattributed path `u.txt`, so the window diff is
 * strictly bigger than the witnessed one). Points the turn's before/after refs at
 * those commits. Returns the repo + the two OIDs.
 */
function mkRepoWithEdges(turn: string): { repo: string; beforeOid: string; afterOid: string } {
  const repo = mkTmpDir();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'w.txt'), 'before-witnessed\n');
  fs.writeFileSync(path.join(repo, 'u.txt'), 'before-unattributed\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'before']);
  const beforeOid = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'w.txt'), 'after-witnessed-CHANGED\n');
  fs.writeFileSync(path.join(repo, 'u.txt'), 'after-unattributed-CHANGED\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'after']);
  const afterOid = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['update-ref', beforeRef(turn), beforeOid]);
  git(repo, ['update-ref', afterRef(turn), afterOid]);
  return { repo, beforeOid, afterOid };
}

// ── in-memory turn store ────────────────────────────────────────────────────────

class FakeTurnStore implements RetentionTurnStore {
  rows = new Map<string, Record<string, unknown>>();
  seed(id: string, extra: Record<string, unknown> = {}): void {
    this.rows.set(id, {
      id, workspaceId: WS, turnSeq: this.rows.size + 1, agentId: AGENT, agentTitle: null,
      ownerAgentId: null, ownerBrickGeneration: null, sessionId: null, taskLabel: null,
      startedAt: null, endedAt: null, status: 'accepted',
      beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
      beforeReady: false, afterReady: false, beforeQuality: null, afterQuality: null,
      beforeRawFilterBypassed: false, beforeFilteredPaths: null,
      beforePrunedAt: null, afterPrunedAt: null,
      touched: null, diffStats: null, compactDiff: null, compactDiffProvenance: null,
      failureReason: null,
      ...extra,
    });
  }
  listTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => ({ ...r } as unknown as TurnRecord));
  }
  getTurnRecord(id: string): TurnRecord | null {
    const r = this.rows.get(id);
    return r ? ({ ...r } as unknown as TurnRecord) : null;
  }
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, updates);
    return { ...r } as unknown as TurnRecord;
  }
}

/** A runGit wrapper that records each invocation's joined args (for ordering proofs). */
function recordingRunGit(): { runGit: RunGitLike; log: string[] } {
  const log: string[] = [];
  const runGit: RunGitLike = (cwd, args, opts) => {
    log.push(args.join(' '));
    return realRunGit(cwd, args, opts);
  };
  return { runGit, log };
}

function silentLogger() {
  const warns: string[] = [];
  return { warns, logger: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} } };
}

const OLD_TS = 1_000; // long before any plausible `now`
const NOW = 10_000_000_000_000; // fixed far-future clock

function baseDeps(repo: string, store: FakeTurnStore, runGit: RunGitLike, queue?: CheckpointQueue): RetentionDeps {
  return {
    workspaceId: WS,
    repoRoot: repo,
    gitExe: EXE,
    queue: queue ?? new CheckpointQueue(),
    commonDirQueueKey: repo,
    runGit,
    turnStore: store,
    now: () => NOW,
    retentionMs: 5 * 24 * 60 * 60 * 1000,
    platform: process.platform,
  };
}

// ══ pure helpers ══════════════════════════════════════════════════════════════

test('decidePruneEdges: dense window keeps every edge', () => {
  const row = { status: 'accepted', endedAt: NOW - 100 } as unknown as TurnRecord;
  assert.deepEqual(decidePruneEdges(row, NOW, 1000), { before: false, after: false });
});

test('decidePruneEdges: aged accepted turn thins to the AFTER boundary snapshot', () => {
  const row = { status: 'accepted', endedAt: OLD_TS } as unknown as TurnRecord;
  assert.deepEqual(decidePruneEdges(row, NOW, 1000), { before: true, after: false });
});

test('decidePruneEdges: aged non-accepted turn prunes BOTH edges', () => {
  const row = { status: 'stopped', endedAt: OLD_TS } as unknown as TurnRecord;
  assert.deepEqual(decidePruneEdges(row, NOW, 1000), { before: true, after: true });
});

test('decidePruneEdges: an OPEN turn or a timestamp-less turn is never eligible', () => {
  assert.deepEqual(decidePruneEdges({ status: 'open', endedAt: OLD_TS } as never, NOW, 1000), { before: false, after: false });
  assert.deepEqual(decidePruneEdges({ status: 'accepted', endedAt: null, startedAt: null } as never, NOW, 1000), { before: false, after: false });
});

test('parseNumstat sums text lines and tallies binary files', () => {
  const s = parseNumstat('3\t1\tw.txt\n10\t0\tsrc/a.ts\n-\t-\timg.png\n');
  assert.equal(s.files, 3);
  assert.equal(s.insertions, 13);
  assert.equal(s.deletions, 1);
  assert.equal(s.binaryFiles, 1);
});

test('parseCountObjects reads count/size/pack fields', () => {
  const c = parseCountObjects('count: 42\nsize: 168\nin-pack: 7\npacks: 1\nsize-pack: 9\n');
  assert.equal(c.count, 42);
  assert.equal(c.sizeKb, 168);
  assert.equal(c.inPack, 7);
  assert.equal(c.packs, 1);
  assert.equal(c.sizePackKb, 9);
});

test('capUtf8 leaves small text intact and caps oversize text on a char boundary', () => {
  assert.deepEqual(capUtf8('hello', 100), { text: 'hello', truncated: false });
  const big = 'x'.repeat(1000);
  const capped = capUtf8(big, 200);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text, 'utf8') <= 200);
  assert.ok(capped.text.includes('truncated'));
  // Never introduces a raw NUL / other C0 control byte (tab/newline excepted).
  const hasC0 = [...capped.text].some((ch) => {
    const c = ch.charCodeAt(0);
    return c < 32 && c !== 9 && c !== 10 && c !== 13;
  });
  assert.equal(hasC0, false, 'compact_diff cap introduces no raw control byte');
});

// ══ distill-before-prune (REAL git) ═════════════════════════════════════════════

test('G3 gate: pruning a ref FIRST back-fills diff_stats + compact_diff, THEN deletes both refs', async () => {
  const T = 'T1';
  const { repo, beforeOid, afterOid } = mkRepoWithEdges(T);
  const store = new FakeTurnStore();
  store.seed(T, {
    status: 'stopped', endedAt: OLD_TS, // aged + non-accepted → both edges pruned
    beforeOid, afterOid, beforeRef: beforeRef(T), afterRef: afterRef(T),
    beforeReady: true, afterReady: true,
    touched: [{ path: 'w.txt', op: 'write' }],
  });
  const { runGit, log } = recordingRunGit();

  const res = await runRetentionPass(baseDeps(repo, store, runGit));

  // Distillation happened and is witnessed-provenance.
  const row = store.rows.get(T)!;
  assert.ok(row.compactDiff != null, 'compact_diff back-filled');
  assert.ok((row.compactDiff as string).includes('w.txt'), 'compact_diff is the witnessed-path diff');
  assert.ok(!(row.compactDiff as string).includes('u.txt'), 'compact_diff excludes the unattributed path');
  assert.equal(row.compactDiffProvenance, 'witnessed');
  const stats = row.diffStats as { witnessed: { files: number }; window: { files: number } };
  assert.equal(stats.witnessed.files, 1, 'witnessed stat = 1 file');
  assert.equal(stats.window.files, 2, 'window stat = both files');

  // Refs deleted; prune hints set.
  assert.equal(refOid(repo, beforeRef(T)), null, 'before ref deleted');
  assert.equal(refOid(repo, afterRef(T)), null, 'after ref deleted');
  assert.equal(row.beforePrunedAt, NOW);
  assert.equal(row.afterPrunedAt, NOW);
  assert.equal(res.prunedTurns, 1);

  // ORDERING: the delete (`update-ref --stdin`) comes strictly AFTER every diff.
  const firstDelete = log.findIndex((l) => l.startsWith('update-ref --stdin'));
  const lastDiff = log.map((l) => l.includes(' diff ')).lastIndexOf(true);
  assert.ok(firstDelete >= 0, 'a delete op ran');
  assert.ok(lastDiff >= 0, 'a diff op ran');
  assert.ok(firstDelete > lastDiff, 'no ref deleted before distillation completed');
});

test('accepted-task thinning: aged accepted turn prunes BEFORE only, keeps the AFTER boundary', async () => {
  const T = 'T2';
  const { repo, beforeOid, afterOid } = mkRepoWithEdges(T);
  const store = new FakeTurnStore();
  store.seed(T, {
    status: 'accepted', endedAt: OLD_TS,
    beforeOid, afterOid, beforeRef: beforeRef(T), afterRef: afterRef(T),
    beforeReady: true, afterReady: true,
    touched: [{ path: 'w.txt', op: 'write' }],
  });

  await runRetentionPass(baseDeps(repo, store, realRunGit));

  const row = store.rows.get(T)!;
  assert.equal(refOid(repo, beforeRef(T)), null, 'before ref pruned');
  assert.equal(refOid(repo, afterRef(T)), afterOid, 'after boundary snapshot KEPT');
  assert.equal(row.beforePrunedAt, NOW);
  assert.equal(row.afterPrunedAt, null, 'after edge not marked pruned');
  assert.ok(row.compactDiff != null, 'still distilled before pruning the before edge');
});

test('dense window: a recent turn is kept — no distill, no delete', async () => {
  const T = 'T3';
  const { repo, beforeOid, afterOid } = mkRepoWithEdges(T);
  const store = new FakeTurnStore();
  store.seed(T, {
    status: 'stopped', endedAt: NOW - 1000, // inside the 5-day window
    beforeOid, afterOid, beforeRef: beforeRef(T), afterRef: afterRef(T),
    beforeReady: true, afterReady: true,
    touched: [{ path: 'w.txt', op: 'write' }],
  });
  const { runGit, log } = recordingRunGit();

  const res = await runRetentionPass(baseDeps(repo, store, runGit));

  assert.equal(res.outcomes[0].action, 'kept');
  assert.equal(refOid(repo, beforeRef(T)), beforeOid, 'before ref intact');
  assert.equal(refOid(repo, afterRef(T)), afterOid, 'after ref intact');
  assert.equal(store.rows.get(T)!.compactDiff, null, 'no distillation for a kept turn');
  assert.ok(!log.some((l) => l.startsWith('update-ref --stdin')), 'no delete issued');
});

test('distill-unavailable: an aged turn with a dead AFTER edge is NEVER pruned', async () => {
  const T = 'T4';
  const { repo, beforeOid, afterOid } = mkRepoWithEdges(T);
  // Simulate the after ref already gone (user-deleted / previously pruned).
  git(repo, ['update-ref', '-d', afterRef(T)]);
  const store = new FakeTurnStore();
  store.seed(T, {
    status: 'stopped', endedAt: OLD_TS,
    beforeOid, afterOid, beforeRef: beforeRef(T), afterRef: afterRef(T),
    beforeReady: true, afterReady: true, // ready is a HINT — rev-parse is authority
    touched: [{ path: 'w.txt', op: 'write' }],
  });

  const res = await runRetentionPass(baseDeps(repo, store, realRunGit));

  assert.equal(res.outcomes[0].action, 'distill-unavailable');
  assert.equal(refOid(repo, beforeRef(T)), beforeOid, 'surviving before ref NOT deleted without distillation');
  assert.equal(store.rows.get(T)!.beforePrunedAt, null);
  assert.equal(store.rows.get(T)!.compactDiff, null, 'nothing distilled');
});

test('a pruned edge is refused by diff (live rev-parse + readiness)', async () => {
  const T = 'T5';
  const { repo, beforeOid, afterOid } = mkRepoWithEdges(T);
  const store = new FakeTurnStore();
  store.seed(T, {
    status: 'stopped', endedAt: OLD_TS,
    beforeOid, afterOid, beforeRef: beforeRef(T), afterRef: afterRef(T),
    beforeReady: true, afterReady: true,
    touched: [{ path: 'w.txt', op: 'write' }],
  });
  await runRetentionPass(baseDeps(repo, store, realRunGit));
  assert.equal(refOid(repo, beforeRef(T)), null, 'precondition: before ref pruned');

  // The CheckpointService diff surface must refuse the pruned edge, even though the
  // DB still says ready=1 (readiness is a hint; the live rev-parse is authority).
  const prunedRow = store.getTurnRecord(T)!;
  const svc = new CheckpointService({
    queue: new CheckpointQueue(),
    gitExe: EXE,
    store: {
      getTurnRecord: () => prunedRow,
      updateTurnRecord: () => prunedRow,
      listTurnRecords: () => [prunedRow],
    },
  });
  const diffs = await svc.generateDiffs(T, repo);
  assert.equal(diffs.witnessed.available, false, 'witnessed diff refused');
  assert.equal(diffs.window.available, false, 'window diff refused');
  assert.equal(diffs.witnessed.reason, 'before-edge-unusable');
});

// ══ loose-object maintenance ════════════════════════════════════════════════════

test('maintenance: below threshold → does not run, no maintenance git call', async () => {
  const { repo } = mkRepoWithEdges('M0');
  const store = new FakeTurnStore();
  const { runGit, log } = recordingRunGit();
  const deps = { ...baseDeps(repo, store, runGit), looseObjectThreshold: 1_000_000 };

  const r = await runLooseObjectMaintenance(deps);

  assert.equal(r.ran, false);
  assert.equal(r.reason, 'below-threshold');
  assert.ok(!log.some((l) => l.startsWith('maintenance run')), 'never invoked git maintenance');
});

test('maintenance: over threshold + idle → runs under MAINTENANCE slot, mutates NO config', async () => {
  const { repo } = mkRepoWithEdges('M1');
  const store = new FakeTurnStore();
  const configPath = path.join(repo, '.git', 'config');
  const before = fs.readFileSync(configPath, 'utf8');
  const { runGit, log } = recordingRunGit();
  const deps = { ...baseDeps(repo, store, runGit), looseObjectThreshold: 0 };

  const r = await runLooseObjectMaintenance(deps);

  assert.equal(r.ran, true, 'ran');
  assert.equal(r.reason, 'ok');
  assert.ok(log.some((l) => l === 'maintenance run --task=loose-objects'), 'exact task invoked, no extra tasks');
  assert.ok(!log.some((l) => l.includes('--aggressive')), 'never aggressive GC');
  assert.ok(!log.some((l) => l.startsWith('maintenance start')), 'never maintenance start');
  const after = fs.readFileSync(configPath, 'utf8');
  assert.equal(after, before, 'git config unchanged (spike-verify: run writes no user config)');
});

test('maintenance: over threshold but key NOT idle → MAINTENANCE item expires (not-idle), nonfatal', async () => {
  const { repo } = mkRepoWithEdges('M2');
  const store = new FakeTurnStore();
  const queue = new CheckpointQueue();
  // Occupy the key with a higher-priority (RESTORE) op that outlives the tiny
  // maintenance deadline, so the MAINTENANCE item can never reach the front. The
  // held op is backed by a REF'd timer so the event loop stays alive long enough for
  // the (unref'd) maintenance deadline to fire — the queue unrefs its own timers.
  let release!: () => void;
  let holdTimer!: ReturnType<typeof setTimeout>;
  const held = new Promise<void>((res) => { release = res; holdTimer = setTimeout(res, 1000); });
  const lockRun = queue.withLock(repo, () => held);

  const { runGit, log } = recordingRunGit();
  const deps = {
    ...baseDeps(repo, store, runGit, queue),
    now: Date.now, // real clock so the 40 ms deadline is a real 40 ms
    looseObjectThreshold: 0,
    maintenanceRuntimeDeadlineMs: 40,
  };

  const r = await runLooseObjectMaintenance(deps);

  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not-idle', 'expired before the key went idle');
  assert.ok(!log.some((l) => l.startsWith('maintenance run')), 'maintenance never executed while busy');
  clearTimeout(holdTimer);
  release();
  await lockRun;
});

test('maintenance: a git lock during the run is NONFATAL (git-nonzero, no throw)', async () => {
  const store = new FakeTurnStore();
  // Fake runGit: count-objects reports over-threshold; the maintenance run throws a
  // lock error (the queue thunk catches it → ok:false, never propagates).
  const runGit: RunGitLike = async (_cwd, args): Promise<GitRunResult> => {
    if (args[0] === 'count-objects') return { code: 0, stdout: 'count: 9999\n', stderr: '' };
    if (args[0] === 'maintenance') throw new GitCommandError('lock', 'cannot lock ref', 128, 'index.lock');
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = { ...baseDeps('/nonexistent-repo', store, runGit), looseObjectThreshold: 0 };

  let r!: Awaited<ReturnType<typeof runLooseObjectMaintenance>>;
  await assert.doesNotReject(async () => { r = await runLooseObjectMaintenance(deps); });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'git-nonzero', 'lock surfaced as a nonfatal non-run');
});

// ══ storage reporting ═══════════════════════════════════════════════════════════

test('storage report is metadata-only — never carries compact_diff / touched bytes', async () => {
  const { repo, beforeOid, afterOid } = mkRepoWithEdges('S1');
  const store = new FakeTurnStore();
  store.seed('S1', {
    status: 'accepted', beforeReady: true, afterReady: true,
    beforeOid, afterOid, beforeRef: beforeRef('S1'), afterRef: afterRef('S1'),
    touched: [{ path: 'w.txt', op: 'write' }], compactDiff: 'SECRET WORKSPACE BYTES',
  });
  store.seed('S2', { status: 'accepted', beforeReady: true, beforePrunedAt: NOW });

  const report = await reportStorage(baseDeps(repo, store, realRunGit));

  assert.equal(report.workspaceId, WS);
  assert.equal(report.turnRecords, 2);
  assert.equal(report.prunedTurns, 1, 'S2 has a pruned edge');
  assert.equal(report.liveBeforeEdges, 1, 'only S1 has a live (unpruned) before edge');
  assert.ok(typeof report.looseObjectCount === 'number');
  // The report object must not leak any raw-byte column.
  const keys = Object.keys(report);
  for (const banned of ['compactDiff', 'compact_diff', 'touched', 'beforeFilteredPaths', 'before_filtered_paths']) {
    assert.ok(!keys.includes(banned), `report must not include ${banned}`);
  }
  assert.ok(!JSON.stringify(report).includes('SECRET WORKSPACE BYTES'), 'no workspace bytes in the report');
});

test('export path omits compact_diff (invariant §7)', () => {
  assert.ok(!TURN_RECORD_EXPORT_ALLOWLIST.includes('compact_diff' as never), 'allowlist excludes compact_diff');
  assert.ok((TURN_RECORD_EXPORT_EXCLUDED as readonly string[]).includes('compact_diff'));
  assert.ok((TURN_RECORD_EXPORT_EXCLUDED as readonly string[]).includes('touched'));
  assert.ok((TURN_RECORD_EXPORT_EXCLUDED as readonly string[]).includes('before_filtered_paths'));
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G3.3 retention tests need real git.');
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
