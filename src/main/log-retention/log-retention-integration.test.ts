// Terminal-log retention WP-9 — the END-TO-END integration backstop.
//
//   npm run build:main
//   node dist/main/main/log-retention/log-retention-integration.test.js
//
// Every prior WP (1-8) proved its own guard in isolation, each with its own
// mocks. THIS test is the one place the REAL stack runs together against a real
// temp directory and a real durable state file, driven by a single OS-idle scan:
//
//   real LogRetentionScheduler (WP-5, idle+cadence gate)
//     → real inventoryBundles  (WP-5, fs.statSync, validate-before-stat,
//                               shared-reference census)
//     → real planRetentionSweep (WP-2, oldest-first age/status/target selection)
//     → real AgentSupervisor.runRetentionSweepPlan → reclaimAgentTerminalHistory
//                               (WP-4, lifecycle lock, POST-DRAIN live recheck)
//     → real reclaimAgentLogFiles (WP-3, worklist-first, beforeFirstUnlink marker)
//     → real markAgentTerminalHistoryReclaimed contract (WP-1 IS-NULL idempotency)
//     → real reader DTOs (WP-6, attach/range/tail/dead-snapshot historyNotice)
//     → real log-retention-state (WP-5, create-once first-sweep notice)
//
// It must FAIL the instant any prior WP's guard is silently removed. The mixed
// fixture (live / dead-old / young / revived-recent / shared-path / a runner that
// appears MID-SCAN, all over target) is chosen so that a mutation to any single
// invariant flips at least one assertion below. The "Mutations to kill" this
// backstop is written against (proved by literal source mutation in the WP-9
// handoff, one at a time):
//   - remove the post-drain live recheck  → mid-runner gets swept
//   - skip the beforeFirstUnlink marker    → swept agent has no marker/notice
//   - let a shared bundle into toSweep     → shared-A appears in the selection
//   - drop the age/status gate             → young/non-terminal enter the selection
//   - reintroduce a whole-file .log read   → the spawned no-whole-file guard fails
//   - delete an agent DB row from retention → the source-grep assertion fails
//
// DB layer: an in-memory Map faithful to WP-1's SQL — `... AND
// terminal_history_reclaimed_at IS NULL` (first non-null value preserved). This
// mirrors the sibling log-retention-executor.test.ts harness; the integration
// value is in wiring every REAL module above together across one real scan.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { Agent, RetentionExecutionResult } from '../../shared/types';
import type { AgentSupervisor as AgentSupervisorType } from '../supervisor/index';
import type { AttachResultSupervisor } from '../terminal-attach-result';

// eslint-disable-next-line @typescript-eslint/no-var-requires
declare const require: any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
declare const __dirname: string;

const { AgentSupervisor } = require('../supervisor/index') as typeof import('../supervisor/index');
const { LogRetentionScheduler } = require('./log-retention-scheduler') as typeof import('./log-retention-scheduler');
const { inventoryBundles } = require('./log-retention-inventory') as typeof import('./log-retention-inventory');
const { computeTerminalAttachResult } = require('../terminal-attach-result') as typeof import('../terminal-attach-result');
const stateModule = require('../lifecycle/log-retention-state') as typeof import('../lifecycle/log-retention-state');

// ── DB module patch (shared singleton: reclaim primitive + supervisor + readers
//    all resolve to dist/main/main/database.js, so one patch reaches all three) ──
interface DbState { agents: Map<string, Agent>; markCalls: string[]; }
function patchDb(state: DbState): () => void {
  const db = require('../database') as Record<string, unknown>;
  const keys = ['getAgent', 'getAllAgents', 'markAgentTerminalHistoryReclaimed'];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.getAgent = (id: string) => state.agents.get(id) ?? null;
  db.getAllAgents = () => Array.from(state.agents.values());
  // Faithful to WP-1: idempotent, own-column-only, never clears (IS NULL guard).
  db.markAgentTerminalHistoryReclaimed = (id: string, iso: string) => {
    state.markCalls.push(id);
    const a = state.agents.get(id);
    if (a && (a.terminalHistoryReclaimedAt === null || a.terminalHistoryReclaimedAt === undefined)) {
      a.terminalHistoryReclaimedAt = iso;
    }
  };
  return () => { for (const k of keys) db[k] = orig[k]; };
}

function makeAgent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id, workspaceId: 'ws', title: id, slug: id, roleDescription: '', workingDirectory: '/tmp',
    command: 'claude', provider: 'claude', isSupervisor: false, isSupervised: true, isWorker: false,
    isResearcher: false, tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'done', isAttached: false, restartCount: 0, lastExitCode: null, pid: null, logPath: null,
    templateId: null, systemPrompt: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    lastOutputAt: null, lastAttachedAt: null, ownerAgentId: null, terminalHistoryReclaimedAt: null, ...over,
  };
}

// ── Minimal harness (mirrors the sibling executor test) ────────────────────────
interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const DAY = 86_400_000;

/** Locate the repo root (holds package.json + src/main) from either the process
 *  cwd (the suite runs from root) or by walking up from __dirname. Same strategy
 *  as no-whole-file-log-read.test.ts so the source-grep is robust to where the
 *  compiled test lives. */
function findRepoRoot(): string {
  const candidates = [process.cwd()];
  let d = __dirname;
  for (let i = 0; i < 12; i++) { candidates.push(d); d = path.dirname(d); }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'src', 'main'))) return c;
  }
  throw new Error('WP-9 integration: could not locate repo root');
}

(async () => {
  // ── ONE shared fixture + scan; every assertion reads from these results ───────
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-integ-logs-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-integ-state-'));
  const state: DbState = { agents: new Map(), markCalls: [] };
  const restoreDb = patchDb(state);
  const sup = new AgentSupervisor() as AgentSupervisorType;
  const priv = sup as unknown as Record<string, any>;
  priv.writeAgentRegistry = () => {};
  priv.releaseChatRing = () => {};
  priv.logsDir = logsDir;

  const NOW = Date.parse('2026-07-27T00:00:00.000Z');
  const managed = (id: string) => path.join(logsDir, `${id}.log`);
  function writeFile(p: string, bytes: number, ageMs: number): void {
    fs.writeFileSync(p, 'x'.repeat(bytes));
    const t = new Date(NOW - ageMs);
    fs.utimesSync(p, t, t);
  }
  function addAgent(id: string, over: Partial<Agent> = {}): Agent {
    const a = makeAgent(id, { logPath: managed(id), ...over });
    state.agents.set(id, a);
    return a;
  }

  // Byte sizes as data so expectations are computed, never hand-arithmeticked.
  const DEAD = { log: 1000, scrollback: 500, checkpoint: 200 };
  const CRASHED = 800;
  const MID = 900;
  const LIVE = 900;
  const YOUNG = 700;
  const REVIVED = 600;
  const SHARED = 300;

  // (1) dead-old — done, no runner, OLD, three managed files → RECLAIMED.
  const deadOld = addAgent('dead-old', { status: 'done' });
  writeFile(deadOld.logPath!, DEAD.log, 30 * DAY);
  writeFile(deadOld.logPath! + '.scrollback', DEAD.scrollback, 30 * DAY);
  writeFile(deadOld.logPath! + '.checkpoint', DEAD.checkpoint, 30 * DAY);

  // (2) crashed-old — crashed, no runner, OLD → RECLAIMED.
  const crashedOld = addAgent('crashed-old', { status: 'crashed' });
  writeFile(crashedOld.logPath!, CRASHED, 20 * DAY);

  // (3) mid-runner — done, NO runner at inventory time (so it enters toSweep),
  // OLDEST so it sorts first. A seeded in-flight checkpoint write inserts a runner
  // DURING the executor's drain-await → the POST-DRAIN recheck (WP-4) must catch
  // it. If the recheck is removed, this file gets swept and the marker is written.
  const midRunner = addAgent('mid-runner', { status: 'done' });
  writeFile(midRunner.logPath!, MID, 40 * DAY);
  const midWrite = new Promise<void>((resolve) => setImmediate(() => {
    priv.windowsRunners.set('mid-runner', { has: true }); // appears mid-scan
    resolve();
  }));
  priv.inFlightCheckpointWrites.set('mid-runner', new Set([midWrite]));

  // (4) live — done BUT a live runner at inventory time → never selected.
  const live = addAgent('live', { status: 'done' });
  writeFile(live.logPath!, LIVE, 30 * DAY);
  priv.windowsRunners.set('live', { has: true });

  // (5) young — done, no runner, but younger than 7d → age gate excludes it.
  const young = addAgent('young', { status: 'done' });
  writeFile(young.logPath!, YOUNG, 1 * DAY);

  // (6) revived-recent — a marked, revived agent that appended recently (< 7d).
  // Proves NO repair pass: the marker is not a selection factor, but age protects
  // the revived history. The pre-existing marker must survive untouched.
  const REVIVED_MARKER = '2026-06-01T00:00:00.000Z';
  const revived = addAgent('revived-recent', { status: 'done', terminalHistoryReclaimedAt: REVIVED_MARKER });
  writeFile(revived.logPath!, REVIVED, 1 * DAY);

  // (7) shared-path — shared-A holds the managed file; shared-B (corrupt) points
  // at shared-A's path. refCount==2 → shared-reference → shared-A never selected;
  // shared-B is out-of-scope for its own id → invalidCount, no bundle.
  const sharedA = addAgent('shared-A', { status: 'done' });
  writeFile(sharedA.logPath!, SHARED, 30 * DAY);
  addAgent('shared-B', { status: 'done', logPath: managed('shared-A') });

  // Target 1 byte → over target for everything, so every ELIGIBLE bundle is swept.
  const TARGET_BYTES = 1;

  const statFn = (p: string): { size: number; mtimeMs: number } | null => {
    try { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; }
    catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  };

  // Capture what the plan actually selected (toSweep) AND every execution result,
  // so a "shared/young bundle enters toSweep" mutation is caught at the SELECTION
  // even when a later line of defense (the primitive) would still refuse it.
  const sweepSelections: string[][] = [];
  const capturedResults: RetentionExecutionResult[] = [];

  const scheduler = new LogRetentionScheduler({
    // Faithful to index.ts: rows from getAllAgents(), hasRunner from the supervisor.
    inventory: (dir: string) => inventoryBundles(
      (require('../database') as typeof import('../database')).getAllAgents().map((a) => ({
        agentId: a.id, status: a.status, logPath: a.logPath, hasRunner: sup.hasRunner(a.id),
      })),
      dir,
      statFn,
    ),
    runSweepPlan: async (toSweep) => {
      sweepSelections.push(toSweep.map((b) => b.agentId));
      const results = await sup.runRetentionSweepPlan(toSweep);
      capturedResults.push(...results);
      return results;
    },
    loadCapBytes: () => TARGET_BYTES,
    getApprovedLogsDir: () => sup.getApprovedLogsDirForRetention(),
    powerMonitor: { getSystemIdleState: () => 'idle', on: () => {}, removeListener: () => {} },
    now: () => NOW,
    readState: () => stateModule.readState(stateDir),
    writeState: (s) => stateModule.writeState(s, stateDir),
  });

  // The ONE idle scan (real idle gate + cadence gate; lastFullScanAt null ⇒ due).
  await scheduler.tick();

  const gauges = scheduler.collectGauges();
  const persisted = stateModule.readState(stateDir);
  const resultFor = (id: string) => capturedResults.find((r) => r.agentId === id);
  const markerOf = (id: string) => state.agents.get(id)!.terminalHistoryReclaimedAt;
  const exists = (p: string) => fs.existsSync(p);

  // Expectations computed from the fixture spec (no hand arithmetic).
  const reclaimedBytes = (DEAD.log + DEAD.scrollback + DEAD.checkpoint) + CRASHED; // 2500
  const reclaimedFiles = 3 + 1; // dead-old ×3 + crashed-old ×1
  const managedBytes = (DEAD.log + DEAD.scrollback + DEAD.checkpoint) + CRASHED + MID + LIVE + YOUNG + REVIVED + SHARED;
  const managedFiles = 3 + 1 + 1 + 1 + 1 + 1 + 1;

  // ── ASSERTIONS ────────────────────────────────────────────────────────────────

  test('exactly ONE scan ran and selected exactly the (done|crashed) && !runner && age≥7d && sole-owner bundles', () => {
    assert.equal(sweepSelections.length, 1, 'one idle scan → one sweep plan');
    const selected = [...sweepSelections[0]].sort();
    assert.deepEqual(selected, ['crashed-old', 'dead-old', 'mid-runner'],
      'ONLY eligible bundles selected — mid-runner is eligible at plan time (its runner appears later)');
    // The negatives: none of these may ever enter the selection.
    for (const id of ['live', 'young', 'revived-recent', 'shared-A', 'shared-B']) {
      assert.ok(!sweepSelections[0].includes(id), `${id} must NOT be selected into toSweep`);
    }
  });

  test('selection is oldest-first by newest mtime (mid-runner 40d, dead-old 30d, crashed-old 20d)', () => {
    assert.deepEqual(sweepSelections[0], ['mid-runner', 'dead-old', 'crashed-old'],
      'planRetentionSweep sorts eligible oldest-first');
  });

  test('dead-old: all files GONE, marker set, outcome removed', () => {
    assert.equal(resultFor('dead-old')!.outcome, 'removed');
    assert.ok(!exists(deadOld.logPath!) && !exists(deadOld.logPath! + '.scrollback') && !exists(deadOld.logPath! + '.checkpoint'),
      'every managed file for dead-old is unlinked');
    const m = markerOf('dead-old');
    assert.ok(typeof m === 'string' && m.length > 0, 'marker is a non-empty ISO string');
  });

  test('crashed-old: file GONE, marker set, outcome removed', () => {
    assert.equal(resultFor('crashed-old')!.outcome, 'removed');
    assert.ok(!exists(crashedOld.logPath!), 'crashed-old .log unlinked');
    assert.ok(typeof markerOf('crashed-old') === 'string' && markerOf('crashed-old')!.length > 0);
  });

  test('mid-runner: a runner appearing MID-SCAN is NOT swept (WP-4 post-drain recheck)', () => {
    const r = resultFor('mid-runner')!;
    assert.equal(r.outcome, 'skipped');
    assert.equal(r.skipReason, 'live-runner', 'the runner that appeared during the drain is caught');
    assert.ok(exists(midRunner.logPath!), 'mid-runner .log NOT unlinked');
    assert.equal(markerOf('mid-runner'), null, 'no marker written for a skipped live agent');
    assert.ok(!state.markCalls.includes('mid-runner'), 'markAgentTerminalHistoryReclaimed never even attempted');
  });

  test('live: a runner present at inventory time is never selected, never swept', () => {
    assert.ok(exists(live.logPath!), 'live .log untouched');
    assert.equal(markerOf('live'), null);
  });

  test('young: a bundle younger than 7d is never swept (age gate)', () => {
    assert.ok(exists(young.logPath!), 'young .log untouched');
    assert.equal(markerOf('young'), null);
  });

  test('revived-recent: not swept (too young) and its pre-existing marker survives UNTOUCHED (no repair pass)', () => {
    assert.ok(exists(revived.logPath!), 'revived .log untouched');
    assert.equal(markerOf('revived-recent'), REVIVED_MARKER, 'the surviving marker is preserved verbatim, never re-stamped');
    assert.ok(!state.markCalls.includes('revived-recent'), 'no re-mark on a revived bundle');
  });

  test('shared-path: a shared-reference bundle is never swept (file intact, no marker)', () => {
    assert.ok(exists(sharedA.logPath!), 'shared-A .log untouched');
    assert.equal(markerOf('shared-A'), null);
  });

  test('readers: attach / range / tail / dead-snapshot all report retention-reclaimed for a swept agent', async () => {
    const notice = { kind: 'retention-reclaimed', reclaimedAt: markerOf('dead-old') };

    const attach = await computeTerminalAttachResult(sup as unknown as AttachResultSupervisor, 'dead-old');
    assert.equal(attach.live, false, 'a swept dead agent has no runner');
    assert.deepEqual(attach.historyNotice, notice, 'attach carries the reclaimed notice');

    const range = await sup.agentReadLogRange('dead-old', 0, 100);
    assert.equal(range.bytes.length, 0, 'reclaimed → empty bytes');
    assert.deepEqual(range.historyNotice, notice, 'range carries the reclaimed notice');

    const tail = await sup.agentReadLogTail('dead-old', 100);
    assert.equal(tail.bytes.length, 0);
    assert.deepEqual(tail.historyNotice, notice, 'tail carries the reclaimed notice');

    const snap = await sup.getAgentDeadSnapshot('dead-old');
    assert.equal(snap.text, '', 'no bytes remain');
    assert.equal(snap.missing, true, 'both fallback files are gone ⇒ missing');
    assert.deepEqual(snap.historyNotice, notice, 'dead-snapshot carries the reclaimed notice');
  });

  test('an un-swept agent (young) discloses NO notice (state derived from the marker, never ENOENT)', async () => {
    // A dead, unmarked agent whose file is still present: absence of a marker —
    // not presence/absence of the file — is what determines reclaimed state.
    const attach = await computeTerminalAttachResult(sup as unknown as AttachResultSupervisor, 'young');
    assert.equal(attach.live, false);
    assert.equal(attach.historyNotice, null, 'a present, unmarked agent has no reclaimed notice');
    const range = await sup.agentReadLogRange('young', 0, 100);
    assert.ok(range.bytes.length > 0, 'the still-present young log yields real bytes');
    assert.equal(range.historyNotice, null, 'a present, unmarked file has no notice');
  });

  test('gauges reflect ACTUAL removed bytes/files (not selected, not attempted)', () => {
    const reclaimed = gauges.find((g) => g.name === 'terminal-log-reclaimed')!;
    assert.equal(reclaimed.bytes, reclaimedBytes, `reclaimed bytes = ${reclaimedBytes} (dead-old + crashed-old only)`);
    assert.equal(reclaimed.count, reclaimedFiles, `reclaimed files = ${reclaimedFiles}`);
    const disk = gauges.find((g) => g.name === 'terminal-log-disk')!;
    assert.equal(disk.bytes, managedBytes, 'managed-disk gauge = every valid distinct bundle (shared counted once)');
    assert.equal(disk.count, managedFiles, 'managed file count across all valid bundles');
  });

  test('state creates firstSweepNotice ONLY because bytes were actually removed, with ACTUAL agents/bytes', () => {
    assert.ok(persisted.lastFullScanAt, 'the completed-scan time is stamped');
    assert.ok(persisted.firstSweepNotice, 'a reclaiming sweep (bytes > 0) creates the first-sweep notice');
    assert.equal(persisted.firstSweepNotice!.bytes, reclaimedBytes, 'notice bytes = ACTUAL reclaimed');
    assert.equal(persisted.firstSweepNotice!.agents, 2, 'exactly two agents actually lost files');
    assert.equal(persisted.firstSweepNotice!.acknowledgedAt, null, 'freshly created, not yet acknowledged');
  });

  test('INVARIANT 1 — no retention module imports or calls dbDeleteAgent (source grep)', () => {
    const root = findRepoRoot();
    const retentionModules = [
      'src/main/log-retention/log-retention-policy.ts',
      'src/main/log-retention/log-retention-inventory.ts',
      'src/main/log-retention/log-retention-scheduler.ts',
      'src/main/lifecycle/log-retention-state.ts',
      'src/main/lifecycle/log-retention-ipc.ts',
      'src/main/supervisor/log-readers/reclaim-log-files.ts',
      'src/main/supervisor/log-readers/history-notice.ts',
    ];
    // Catches `deleteAgent`, the `dbDeleteAgent` alias, and any casing.
    const OFFENDER = /delete_?agent/i;
    for (const rel of retentionModules) {
      const full = path.join(root, rel);
      assert.ok(fs.existsSync(full), `retention module present: ${rel}`);
      const src = fs.readFileSync(full, 'utf8');
      // Strip line comments so prose can safely discuss the invariant.
      const code = src.split('\n').map((l) => l.split('//')[0]).join('\n');
      assert.ok(!OFFENDER.test(code), `retention module ${rel} must never import/call a row-deleting function`);
    }
  });

  test('INVARIANT 3 — the no-whole-file-log-read guard stays green', () => {
    const root = findRepoRoot();
    const guard = path.join(root, 'dist/main/main/supervisor/log-readers/no-whole-file-log-read.test.js');
    assert.ok(fs.existsSync(guard), 'the compiled whole-file-read guard exists (build:main ran)');
    const r = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `no-whole-file-log-read guard must pass:\n${r.stdout}\n${r.stderr}`);
  });

  // ── Runner ──────────────────────────────────────────────────────────────────
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  restoreDb();
  try { fs.rmSync(logsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
