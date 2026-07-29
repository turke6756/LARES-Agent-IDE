// WP-4 (terminal-log retention) — the supervisor executor: lifecycle lock,
// post-drain live recheck, checkpoint reservation, and the two narrow seams.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-retention-executor.test.js
//
// This is the SAFETY-CRITICAL work package: a mistake here deletes a live
// agent's terminal log or writes a marker that lies. The tests below are the
// executable form of WP-4's "Mutations to kill":
//   - allowing `idle` (non-terminal) status                     → non-terminal-skip
//   - removing/inverting either runner-map check                → wsl-only / win-only blocks
//   - moving the recheck BEFORE the await                       → runner-appears-during-drain
//   - a save allowed during a reservation                       → save-refused-while-reserved
//   - the marker re-added as a save/load guard                  → revived-can-save-and-load
//   - a single-promise map losing an overlapping save           → overlapping-saves-both-awaited
//   - a direct unlinkSync bypassing the primitive               → marker-honesty (hook == unlink)
//
// Harness mirrors lifecycle-stop.test.ts: patch the `../database` module
// exports, construct a real AgentSupervisor, override `logsDir` to a temp dir,
// and drive the internal maps directly. `writeTerminalCheckpoint` is patched
// per-test (its props are writable) only where write timing must be controlled.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, AgentStatus, RetentionExecutionResult } from '../../shared/types';
import type { AgentSupervisor as AgentSupervisorType } from './index';
import type { RetentionBundle } from '../log-retention/log-retention-policy';

declare const require: any;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as typeof import('./index');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cpModule = require('./log-readers/terminal-checkpoint') as {
  writeTerminalCheckpoint: (logPath: string, cp: unknown) => Promise<void>;
  readTerminalCheckpoint: (logPath: string) => Promise<unknown>;
};
const origWriteCheckpoint = cpModule.writeTerminalCheckpoint;

// ── DB module patch ───────────────────────────────────────────────────────────
interface DbState {
  agents: Map<string, Agent>;
  markCalls: string[]; // agentIds passed to markAgentTerminalHistoryReclaimed
}
function patchDb(state: DbState): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = ['getAgent', 'getAllAgents', 'markAgentTerminalHistoryReclaimed'];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.getAgent = (id: string) => state.agents.get(id) ?? null;
  db.getAllAgents = () => Array.from(state.agents.values());
  // Faithful to WP-1: `... AND terminal_history_reclaimed_at IS NULL` — the first
  // non-null value is preserved (idempotent), later calls are no-ops.
  db.markAgentTerminalHistoryReclaimed = (id: string, iso: string) => {
    state.markCalls.push(id);
    const a = state.agents.get(id);
    if (a && (a.terminalHistoryReclaimedAt === null || a.terminalHistoryReclaimedAt === undefined)) {
      a.terminalHistoryReclaimedAt = iso;
    }
  };
  return () => { for (const k of keys) db[k] = orig[k]; };
}

// ── Minimal test harness ────────────────────────────────────────────────────
interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

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

interface Harness {
  sup: AgentSupervisorType;
  priv: Record<string, any>;
  logsDir: string;
  state: DbState;
  /** Register an agent whose managed logPath is `<logsDir>/<id>.log`. */
  addAgent(id: string, over?: Partial<Agent>): Agent;
  managedPath(id: string): string;
  cleanup(): void;
}
function setup(): Harness {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-exec-'));
  const state: DbState = { agents: new Map(), markCalls: [] };
  const restoreDb = patchDb(state);
  const sup = new AgentSupervisor();
  const priv = sup as unknown as Record<string, any>;
  priv.writeAgentRegistry = () => {};
  priv.releaseChatRing = () => {};
  priv.logsDir = logsDir; // override the real AppData dir
  const managedPath = (id: string): string => path.join(logsDir, `${id}.log`);
  return {
    sup, priv, logsDir, state,
    addAgent: (id, over = {}) => {
      const a = makeAgent(id, { logPath: managedPath(id), ...over });
      state.agents.set(id, a);
      return a;
    },
    managedPath,
    cleanup: () => { restoreDb(); cpModule.writeTerminalCheckpoint = origWriteCheckpoint; try { fs.rmSync(logsDir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

// ── Seams ─────────────────────────────────────────────────────────────────────

test('getApprovedLogsDirForRetention returns the exact dir the executor validates against', () => {
  const h = setup();
  try {
    assert.equal(h.sup.getApprovedLogsDirForRetention(), h.logsDir);
  } finally { h.cleanup(); }
});

test('agentTerminalHistoryNotice: string marker → notice; undefined/null/empty/non-string → null', () => {
  const h = setup();
  try {
    h.addAgent('a', { terminalHistoryReclaimedAt: '2026-07-20T00:00:00.000Z' });
    assert.deepEqual(h.sup.agentTerminalHistoryNotice('a'), { kind: 'retention-reclaimed', reclaimedAt: '2026-07-20T00:00:00.000Z' });

    h.addAgent('b', { terminalHistoryReclaimedAt: null });
    assert.equal(h.sup.agentTerminalHistoryNotice('b'), null, 'null → null');

    h.addAgent('c', { terminalHistoryReclaimedAt: undefined });
    assert.equal(h.sup.agentTerminalHistoryNotice('c'), null, 'undefined (WP-1 optional) → null');

    h.addAgent('d', { terminalHistoryReclaimedAt: '' });
    assert.equal(h.sup.agentTerminalHistoryNotice('d'), null, 'empty string → null');

    h.addAgent('e', { terminalHistoryReclaimedAt: 12345 as unknown as string });
    assert.equal(h.sup.agentTerminalHistoryNotice('e'), null, 'non-string → null + diagnostic');

    assert.equal(h.sup.agentTerminalHistoryNotice('missing'), null, 'missing row → null');
  } finally { h.cleanup(); }
});

// ── Live recheck (the safety core) ─────────────────────────────────────────────

test('a runner appearing DURING the drain (after the await starts) → skip live-runner, ZERO marker, ZERO unlink', async () => {
  const h = setup();
  try {
    const a = h.addAgent('mid', { status: 'done' });
    // Real files exist — if the recheck were skipped/moved-before-await, they'd be unlinked.
    fs.writeFileSync(a.logPath as string, 'LOG');
    fs.writeFileSync(a.logPath + '.scrollback', 'SB');

    // A pending in-flight write whose RESOLUTION inserts a runner. Because it
    // resolves on a macrotask, a runner is NOT present when the locked body is
    // entered — only after the drain's `await` yields. A recheck-before-await
    // mutation would proceed and delete the files.
    const writeP = new Promise<void>((resolve) => setImmediate(() => {
      h.priv.windowsRunners.set('mid', { has: true });
      resolve();
    }));
    h.priv.inFlightCheckpointWrites.set('mid', new Set([writeP]));

    const res = await h.sup.reclaimAgentTerminalHistory('mid');

    assert.equal(res.outcome, 'skipped');
    assert.equal(res.skipReason, 'live-runner', 'the runner that appeared during the drain is caught');
    assert.deepEqual(h.state.markCalls, [], 'ZERO marker writes');
    assert.ok(fs.existsSync(a.logPath as string), '.log NOT unlinked');
    assert.ok(fs.existsSync(a.logPath + '.scrollback'), '.scrollback NOT unlinked');
    assert.equal(a.terminalHistoryReclaimedAt, null, 'marker column untouched');
  } finally { h.cleanup(); }
});

test('a runner ONLY in wslRunners blocks the sweep (live-runner)', async () => {
  const h = setup();
  try {
    const a = h.addAgent('wsl-only', { status: 'crashed' });
    fs.writeFileSync(a.logPath as string, 'X');
    h.priv.wslRunners.set('wsl-only', { has: true });
    const res = await h.sup.reclaimAgentTerminalHistory('wsl-only');
    assert.equal(res.skipReason, 'live-runner');
    assert.ok(fs.existsSync(a.logPath as string), 'not unlinked');
    assert.deepEqual(h.state.markCalls, []);
  } finally { h.cleanup(); }
});

test('a runner ONLY in windowsRunners blocks the sweep (live-runner)', async () => {
  const h = setup();
  try {
    const a = h.addAgent('win-only', { status: 'done' });
    fs.writeFileSync(a.logPath as string, 'X');
    h.priv.windowsRunners.set('win-only', { has: true });
    const res = await h.sup.reclaimAgentTerminalHistory('win-only');
    assert.equal(res.skipReason, 'live-runner');
    assert.ok(fs.existsSync(a.logPath as string), 'not unlinked');
  } finally { h.cleanup(); }
});

test('a throwing runner-map access fails CLOSED (runner-check-failed), never assumes no runner', async () => {
  const h = setup();
  try {
    const a = h.addAgent('boom', { status: 'done' });
    fs.writeFileSync(a.logPath as string, 'X');
    h.priv.windowsRunners = { has: () => { throw new Error('map wedged'); } };
    const res = await h.sup.reclaimAgentTerminalHistory('boom');
    assert.equal(res.outcome, 'skipped');
    assert.equal(res.skipReason, 'runner-check-failed');
    assert.ok(fs.existsSync(a.logPath as string), 'fail-closed → not unlinked');
    assert.deepEqual(h.state.markCalls, []);
  } finally { h.cleanup(); }
});

// ── Status gate ─────────────────────────────────────────────────────────────

test('non-terminal status (idle) skips — never eligible', async () => {
  const h = setup();
  try {
    const a = h.addAgent('busy', { status: 'idle' });
    fs.writeFileSync(a.logPath as string, 'X');
    const res = await h.sup.reclaimAgentTerminalHistory('busy');
    assert.equal(res.outcome, 'skipped');
    assert.equal(res.skipReason, 'non-terminal');
    assert.ok(fs.existsSync(a.logPath as string), 'idle log not unlinked');
    assert.deepEqual(h.state.markCalls, []);
  } finally { h.cleanup(); }
});

test('working / waiting statuses also skip as non-terminal', async () => {
  const h = setup();
  try {
    for (const status of ['working', 'waiting', 'restarting'] as AgentStatus[]) {
      const id = `st-${status}`;
      const a = h.addAgent(id, { status });
      fs.writeFileSync(a.logPath as string, 'X');
      const res = await h.sup.reclaimAgentTerminalHistory(id);
      assert.equal(res.skipReason, 'non-terminal', `${status} → non-terminal`);
      assert.ok(fs.existsSync(a.logPath as string));
    }
    assert.deepEqual(h.state.markCalls, []);
  } finally { h.cleanup(); }
});

// ── Pre-primitive skips are attributed ─────────────────────────────────────────

test('missing row → attributed skip (missing-row)', async () => {
  const h = setup();
  try {
    const res = await h.sup.reclaimAgentTerminalHistory('ghost');
    assert.deepEqual(res, { agentId: 'ghost', outcome: 'skipped', skipReason: 'missing-row', removed: [], failed: [] });
  } finally { h.cleanup(); }
});

test('out-of-scope stored path → attributed skip (invalid-path), no unlink', async () => {
  const h = setup();
  try {
    const strayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-'));
    const strayLog = path.join(strayDir, 'x.log');
    fs.writeFileSync(strayLog, 'X');
    h.addAgent('x', { status: 'done', logPath: strayLog }); // NOT under logsDir
    const res = await h.sup.reclaimAgentTerminalHistory('x');
    assert.equal(res.outcome, 'skipped');
    assert.equal(res.skipReason, 'invalid-path');
    assert.ok(fs.existsSync(strayLog), 'out-of-scope file untouched');
    assert.deepEqual(h.state.markCalls, []);
    fs.rmSync(strayDir, { recursive: true, force: true });
  } finally { h.cleanup(); }
});

test('wrong-basename stored path (right dir, wrong name) → invalid-path', async () => {
  const h = setup();
  try {
    const wrong = path.join(h.logsDir, 'someone-else.log');
    fs.writeFileSync(wrong, 'X');
    h.addAgent('y', { status: 'done', logPath: wrong });
    const res = await h.sup.reclaimAgentTerminalHistory('y');
    assert.equal(res.skipReason, 'invalid-path');
    assert.ok(fs.existsSync(wrong), 'mismatched-basename file untouched');
  } finally { h.cleanup(); }
});

// ── Actual reclamation + marker honesty ────────────────────────────────────────

test('eligible dead agent → files unlinked, marker written via the primitive hook, outcome removed', async () => {
  const h = setup();
  try {
    const a = h.addAgent('gone', { status: 'done' });
    fs.writeFileSync(a.logPath as string, 'A'.repeat(10));
    fs.writeFileSync(a.logPath + '.scrollback', 'B'.repeat(5));
    fs.writeFileSync(a.logPath + '.checkpoint', 'C');
    const res = await h.sup.reclaimAgentTerminalHistory('gone');
    assert.equal(res.outcome, 'removed');
    assert.equal(res.removed.length, 3, 'three files removed');
    assert.deepEqual(h.state.markCalls, ['gone'], 'marker written exactly once, via beforeFirstUnlink');
    assert.ok(typeof a.terminalHistoryReclaimedAt === 'string' && a.terminalHistoryReclaimedAt.length > 0, 'marker is an ISO string');
    assert.ok(!fs.existsSync(a.logPath as string) && !fs.existsSync(a.logPath + '.scrollback'), 'files gone');
    // The disclosure now shows for this agent.
    assert.deepEqual(h.sup.agentTerminalHistoryNotice('gone'), { kind: 'retention-reclaimed', reclaimedAt: a.terminalHistoryReclaimedAt });
  } finally { h.cleanup(); }
});

test('empty bundle (no files) → no-files outcome, hook NOT fired, ZERO marker (marker == actual reclamation)', async () => {
  const h = setup();
  try {
    h.addAgent('empty', { status: 'done' }); // managed path but nothing on disk
    const res = await h.sup.reclaimAgentTerminalHistory('empty');
    assert.equal(res.outcome, 'no-files');
    assert.deepEqual(res.removed, []);
    assert.deepEqual(h.state.markCalls, [], 'no marker written when nothing is reclaimed');
  } finally { h.cleanup(); }
});

test('a failed-save residue (only .checkpoint.tmp) is reclaimed, marker written', async () => {
  const h = setup();
  try {
    const a = h.addAgent('tmp', { status: 'crashed' });
    fs.writeFileSync(a.logPath + '.checkpoint.tmp', 'leftover');
    const res = await h.sup.reclaimAgentTerminalHistory('tmp');
    assert.equal(res.outcome, 'removed');
    assert.deepEqual(res.removed.map((r) => r.path), [a.logPath + '.checkpoint.tmp']);
    assert.ok(!fs.existsSync(a.logPath + '.checkpoint.tmp'), '.checkpoint.tmp reclaimed');
    assert.deepEqual(h.state.markCalls, ['tmp']);
  } finally { h.cleanup(); }
});

// ── Checkpoint reservation ──────────────────────────────────────────────────

test('save is REFUSED while a reservation is active (returns false, writes nothing)', async () => {
  const h = setup();
  try {
    const a = h.addAgent('reserved', { status: 'done' });
    h.priv.lastTerminalEpoch.set('reserved', 'E1');
    let writeCalls = 0;
    cpModule.writeTerminalCheckpoint = async () => { writeCalls++; };
    h.priv.retentionReservations.add('reserved');
    const ok = await h.sup.saveTerminalCheckpoint('reserved', 'E1', 'data', 0);
    assert.equal(ok, false, 'save refused while reserved');
    assert.equal(writeCalls, 0, 'no write attempted');
    assert.equal(h.priv.inFlightCheckpointWrites.has('reserved'), false, 'nothing registered');
    assert.ok(!fs.existsSync(a.logPath + '.checkpoint'), 'no checkpoint file');
  } finally { h.cleanup(); }
});

test('load is REFUSED while a reservation is active (returns null)', async () => {
  const h = setup();
  try {
    const a = h.addAgent('reserved2', { status: 'done' });
    h.priv.lastTerminalEpoch.set('reserved2', 'E1');
    // Seed a valid, loadable checkpoint on disk.
    fs.writeFileSync(a.logPath + '.checkpoint', JSON.stringify({ epoch: 'E1', serialized: 'S', appliedOffset: 0 }));
    assert.deepEqual(await h.sup.loadTerminalCheckpoint('reserved2', 100), { serialized: 'S', appliedOffset: 0 }, 'precondition: loadable when unreserved');
    h.priv.retentionReservations.add('reserved2');
    assert.equal(await h.sup.loadTerminalCheckpoint('reserved2', 100), null, 'refused while reserved');
  } finally { h.cleanup(); }
});

test('two overlapping in-flight saves (newer resolves first) → reclaim awaits BOTH, neither lost', async () => {
  const h = setup();
  try {
    const a = h.addAgent('overlap', { status: 'done' });
    h.priv.lastTerminalEpoch.set('overlap', 'E1');
    const deferreds: Array<{ resolve: () => void }> = [];
    cpModule.writeTerminalCheckpoint = () => new Promise<void>((resolve) => { deferreds.push({ resolve }); });

    // Two overlapping saves; both register SYNCHRONOUSLY into the per-agent Set.
    const saveA = h.sup.saveTerminalCheckpoint('overlap', 'E1', 'a', 0);
    const saveB = h.sup.saveTerminalCheckpoint('overlap', 'E1', 'b', 0);
    assert.equal(h.priv.inFlightCheckpointWrites.get('overlap').size, 2, 'both writes registered — a single-promise map would hold only one');

    let reclaimSettled = false;
    const reclaimP = h.sup.reclaimAgentTerminalHistory('overlap').then((r) => { reclaimSettled = true; return r; });
    await flush(); // let reclaim reach the allSettled await

    // Newer (B) resolves first. If the reclaim tracked only a single (latest)
    // promise, it would now proceed and settle — the older write (A) lost.
    deferreds[1].resolve();
    await flush();
    assert.equal(reclaimSettled, false, 'reclaim still waiting for the older, still-pending write A');

    deferreds[0].resolve();
    const res = await reclaimP;
    assert.equal(reclaimSettled, true, 'reclaim proceeds only after BOTH writes settled');
    assert.equal(res.outcome, 'no-files');
    assert.equal(await saveA, true);
    assert.equal(await saveB, true);
    assert.equal(h.priv.inFlightCheckpointWrites.has('overlap'), false, 'Set drained in finally');
  } finally { h.cleanup(); }
});

// ── Revival: the marker must NEVER gate save/load ─────────────────────────────

test('revived agent: marker persists, a NEW epoch can BOTH save AND load, and disclosure is still shown', async () => {
  const h = setup();
  try {
    // Marker persists from an earlier sweep; the agent is revived with a NEW epoch
    // reusing the SAME logPath.
    const a = h.addAgent('revived', { status: 'done', terminalHistoryReclaimedAt: '2026-07-10T00:00:00.000Z' });
    h.priv.lastTerminalEpoch.set('revived', 'E2'); // new epoch
    // Real save + load (no stub) — proves neither method consults the marker.
    const saved = await h.sup.saveTerminalCheckpoint('revived', 'E2', 'REPLAY', 7);
    assert.equal(saved, true, 'a marked-but-revived agent CAN save under its new epoch');
    assert.ok(fs.existsSync(a.logPath + '.checkpoint'), 'checkpoint written');
    const loaded = await h.sup.loadTerminalCheckpoint('revived', 100);
    assert.deepEqual(loaded, { serialized: 'REPLAY', appliedOffset: 7 }, 'and CAN load it back');
    // Disclosure still surfaces the earlier reclamation.
    assert.deepEqual(h.sup.agentTerminalHistoryNotice('revived'), { kind: 'retention-reclaimed', reclaimedAt: '2026-07-10T00:00:00.000Z' });
  } finally { h.cleanup(); }
});

// ── Sweep plan: sequential, yield every 25, order preserved, no yield mid-agent ─

test('runRetentionSweepPlan: preserves oldest-first order and injects a yield every 25 agents only', async () => {
  const h = setup();
  try {
    const N = 60;
    const bundles: RetentionBundle[] = [];
    for (let i = 0; i < N; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`;
      h.addAgent(id, { status: 'done' }); // managed path, no files → no-files
      bundles.push({ agentId: id, totalBytes: 0, fileCount: 0, newestMtimeMs: null, preliminaryEligible: true });
    }
    let yields = 0;
    const spy = (cb: () => void): void => { yields++; setImmediate(cb); };
    const results = await h.sup.runRetentionSweepPlan(bundles, { setImmediateFn: spy });

    assert.deepEqual(results.map((r) => r.agentId), bundles.map((b) => b.agentId), 'order preserved 1:1');
    assert.equal(yields, 2, '60 agents → yields after #25 and #50 only (never per-agent, never mid-agent)');
    assert.ok(results.every((r) => r.outcome === 'no-files'));
  } finally { h.cleanup(); }
});

test('runRetentionSweepPlan: an empty plan does nothing and never yields', async () => {
  const h = setup();
  try {
    let yields = 0;
    const results = await h.sup.runRetentionSweepPlan([], { setImmediateFn: () => { yields++; } });
    assert.deepEqual(results, []);
    assert.equal(yields, 0);
  } finally { h.cleanup(); }
});

// ── reclaimedAgents telemetry count ───────────────────────────────────────────

test('countReclaimedAgents counts only results with removed.length > 0 (not skips, not no-files)', () => {
  const mk = (agentId: string, removed: number, outcome: RetentionExecutionResult['outcome']): RetentionExecutionResult => ({
    agentId, outcome, removed: Array.from({ length: removed }, (_, i) => ({ path: `${agentId}.${i}`, bytes: 1 })), failed: [],
  });
  const results: RetentionExecutionResult[] = [
    mk('a', 2, 'removed'),
    mk('b', 0, 'no-files'),
    mk('c', 0, 'skipped'),
    mk('d', 1, 'partial'),
  ];
  assert.equal(AgentSupervisor.countReclaimedAgents(results), 2, 'only a + d actually removed a file');
  assert.equal(AgentSupervisor.countReclaimedAgents([]), 0);
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
