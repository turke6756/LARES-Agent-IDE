// WP3 (plans/cross-workspace-collaboration.md — "WP3 — Revival lifecycle +
// revive_agent") — AgentSupervisor.reviveAgent lifecycle, over a real supervisor
// with the runner + reconcile gate + session-reader stubbed.
//
// Coverage (the plan's "WP3 tests" bullet):
//   - both `done` and `crashed` revive; live/`restarting` → revive-not-terminal;
//   - a queued message SURVIVES stop→relaunch (staged AFTER stop, with the
//     get_my_context orientation preamble prepended);
//   - reconcileGate === null → revive-ownership-unverified (503), no stop/relaunch;
//   - gate matrix: proceed / terminate-then-continue → ok; non-WSL reattach →
//     revive-ownership-blocked; WSL reattach → reaches relaunch (no duplicate);
//     leave-unmanaged / blocked → revive-ownership-blocked; gate throw →
//     revive-ownership-unverified;
//   - StopResult.outcome:'failed' → revive-stop-failed, no relaunch;
//   - agent deleted between stop and relaunch → revive-relaunch-failed, staged
//     prompt cleaned up, `revived` NOT recorded; manual restart still no-ops;
//   - ordinary worker revival NOT blocked by a live supervisor; supervisor-target
//     successor guard + force;
//   - missing session/jsonl → revive-no-session; gemini → revive-unsupported-provider;
//     codex unresolvable → revive-no-session; missing ws/cwd → gone codes;
//   - runner still live → revive-runner-live;
//   - a revived agent gets a FRESHLY minted capability; the old token no longer
//     resolves.
//
//   npm run build:main
//   node dist/main/main/supervisor/revive-agent.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor, buildRevivalWakeMessage } from './index';
import { WindowsRunner } from './windows-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { agentCapabilities } from '../security/agent-capabilities';
import type { Agent } from '../../shared/types';
import type { GateAction, GateResolution } from './ownership';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── runner stub (relaunch always "succeeds") ────────────────────────────────────

function patchRunner(): () => void {
  const orig = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _cwd: string, _cmd: string, _args: string[], _log: string, _direct: boolean,
    _extraEnv?: Record<string, string>,
  ) {
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  return () => { (WindowsRunner.prototype as { launch: unknown }).launch = orig; };
}

// ── DB patch (credential-propagation.test.ts shape, extended for revive) ─────────

function patchDb(workspacePath: string | null, agents: Agent[], events: Array<{ id: string; type: string; payload: string }>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'applyStatusTransition', 'updateAgentPid',
    'getAgent', 'getAgentsByWorkspace', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getAgentTemplate', 'getFileActivities', 'insertAgentSession',
    'getCurrentBrick', 'getContinuationAttempt', 'incrementRestartCount',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.getWorkspace = (id: string) => (workspacePath === null ? null : { id, path: workspacePath, defaultCommand: 'claude' });
  db.createAgent = () => { throw new Error('createAgent not expected in revive test'); };
  db.updateAgentStatus = (id: string, status: string) => {
    const a = agents.find(x => x.id === id);
    if (a) (a as unknown as { status: string }).status = status;
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agents.find(a => a.id === id) ?? null;
  db.getAgentsByWorkspace = (wsId: string) => agents.filter(a => a.workspaceId === wsId);
  db.addEvent = (id: string, type: string, payload: string) => { events.push({ id, type, payload }); };
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => agents;
  db.getAllAgents = () => agents;
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];
  db.insertAgentSession = () => {};
  db.getCurrentBrick = () => null;
  db.getContinuationAttempt = () => null;
  db.incrementRestartCount = () => {};
  patchApplyStatusTransition(db);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

// ── supervisor with heavy side effects neutralized ──────────────────────────────

function makeSupervisor(): AgentSupervisor {
  const s = new AgentSupervisor();
  const anyS = s as unknown as Record<string, unknown>;
  anyS.writeAgentRegistry = () => {};
  anyS.reclaimTerminalCheckpoint = () => {};
  anyS.ensureSpoolTailer = () => {};
  anyS.healLegacyStateDirScaffold = () => {};
  anyS.setupFileTracker = () => null;
  anyS.sweepStaleSyspromptFiles = () => {};
  anyS.buildContinuationBrickBlock = () => '';
  anyS.notifyTerminalRebound = () => {};
  return s;
}

function fakeGate(action: GateAction): { resolve(): Promise<GateResolution> } {
  return { resolve: async () => ({ action, reason: 'test', pids: [] }) };
}

function setGate(s: AgentSupervisor, gate: unknown): void {
  (s as unknown as { reconcileGate: unknown }).reconcileGate = gate;
}

/** Stub the session-log reader's on-disk existence probe (used by assertResumable
 *  AND the launch-time resume guard). */
function setSessionExists(s: AgentSupervisor, exists: boolean): void {
  (s as unknown as { sessionLogReader: { sessionFileExists: unknown } }).sessionLogReader.sessionFileExists = () => exists;
}

function getPending(s: AgentSupervisor, id: string): { text: string } | undefined {
  return (s as unknown as { pendingInitialPrompts: Map<string, { text: string }> }).pendingInitialPrompts.get(id);
}

async function revive(
  s: AgentSupervisor, id: string, opts: { force?: boolean; message?: string } = {},
): Promise<{ ok: true; result: { revived: true; queued: boolean } } | { ok: false; code?: string; statusCode?: number }> {
  try {
    const result = await s.reviveAgent(id, opts);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code, statusCode: (err as { statusCode?: number }).statusCode };
  }
}

// ── harness ─────────────────────────────────────────────────────────────────────

interface Harness {
  supervisor: AgentSupervisor;
  agents: Agent[];
  events: Array<{ id: string; type: string; payload: string }>;
  workspacePath: string;
}

async function withHarness(fn: (h: Harness) => Promise<void>, opts: { workspaceExists?: boolean } = {}): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-'));
  const agents: Agent[] = [];
  const events: Array<{ id: string; type: string; payload: string }> = [];
  const restoreDb = patchDb(opts.workspaceExists === false ? null : workspacePath, agents, events);
  const restoreRunner = patchRunner();
  agentCapabilities.clear();
  const supervisor = makeSupervisor();
  setGate(supervisor, fakeGate('proceed'));
  setSessionExists(supervisor, true);
  try {
    await fn({ supervisor, agents, events, workspacePath });
  } finally {
    restoreRunner();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

/** A terminal claude worker whose cwd IS the (existing) workspace path. */
function terminalWorker(workspacePath: string, over: Partial<Agent> = {}): Agent {
  return makeAgent('agent-1', {
    provider: 'claude',
    isWorker: true,
    isSupervisor: false,
    isSupervised: false,
    workspaceId: 'ws-1',
    workingDirectory: workspacePath,
    logPath: path.join(workspacePath, 'a.log'),
    resumeSessionId: 'sess-1',
    status: 'done',
    ...over,
  });
}

/** Replace stopAgentLocked + resumeAgentAfterStopLocked with recording spies so a
 *  negative test can assert neither ran (or drive a specific StopResult). */
function spyLifecycle(
  s: AgentSupervisor,
  stopResult: { outcome: string } | (() => Promise<{ outcome: string }>),
): { stops: number; resumes: number } {
  const counters = { stops: 0, resumes: 0 };
  (s as unknown as { stopAgentLocked: unknown }).stopAgentLocked = async () => {
    counters.stops++;
    return typeof stopResult === 'function' ? await stopResult() : stopResult;
  };
  (s as unknown as { resumeAgentAfterStopLocked: unknown }).resumeAgentAfterStopLocked = async () => {
    counters.resumes++;
  };
  return counters;
}

// ── happy path: done + crashed ──────────────────────────────────────────────────

for (const status of ['done', 'crashed'] as const) {
  test(`a ${status} claude worker revives → { revived, queued:false } + 'revived' event`, () => withHarness(async (h) => {
    const agent = terminalWorker(h.workspacePath, { status });
    h.agents.push(agent);
    const res = await revive(h.supervisor, agent.id);
    assert.ok(res.ok, `expected success; got ${JSON.stringify(res)}`);
    assert.deepEqual(res.result, { revived: true, queued: false });
    assert.ok(h.events.some(e => e.id === agent.id && e.type === 'revived'), `a 'revived' event was recorded`);
  }));
}

test('a live (idle) agent → revive-not-terminal (409), no stop/relaunch', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { status: 'idle' });
  h.agents.push(agent);
  const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal(res.ok, false);
  assert.equal((res as { code?: string }).code, 'revive-not-terminal');
  assert.equal((res as { statusCode?: number }).statusCode, 409);
  assert.equal(spy.stops, 0, 'a non-terminal target is never stopped');
}));

test('a restarting agent → revive-not-terminal (409)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { status: 'restarting' });
  h.agents.push(agent);
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-not-terminal');
}));

test('a missing agent → revive-agent-missing (404)', () => withHarness(async (h) => {
  const res = await revive(h.supervisor, 'nope');
  assert.equal((res as { code?: string }).code, 'revive-agent-missing');
  assert.equal((res as { statusCode?: number }).statusCode, 404);
}));

test('a still-live runner → revive-runner-live (409)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { status: 'crashed' });
  h.agents.push(agent);
  (h.supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners.set(agent.id, {});
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-runner-live');
}));

// ── message survives stop → relaunch, with the orientation preamble ─────────────

test('a queued message is staged AFTER stop with the get_my_context preamble and survives to relaunch', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  // Real stop, but capture the staged prompt at the moment relaunch is entered.
  let stagedAtRelaunch: string | undefined;
  (h.supervisor as unknown as { resumeAgentAfterStopLocked: unknown }).resumeAgentAfterStopLocked = async () => {
    stagedAtRelaunch = getPending(h.supervisor, agent.id)?.text;
  };
  const res = await revive(h.supervisor, agent.id, { message: 'apply the migration to staging' });
  assert.ok(res.ok, `expected success; got ${JSON.stringify(res)}`);
  assert.equal(res.result.queued, true);
  assert.equal(stagedAtRelaunch, buildRevivalWakeMessage('apply the migration to staging'),
    'the wake message survived the stop and was staged (with preamble) before relaunch');
  assert.ok(/get_my_context/.test(stagedAtRelaunch ?? ''), 'the staged text carries the orientation preamble');
}));

// ── ownership gate: null → fail closed, no stop/relaunch ─────────────────────────

test('reconcileGate === null → revive-ownership-unverified (503), no stop/relaunch', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  setGate(h.supervisor, null);
  const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-ownership-unverified');
  assert.equal((res as { statusCode?: number }).statusCode, 503);
  assert.equal(spy.stops, 0, 'fail-closed before any stop');
  assert.equal(spy.resumes, 0, 'fail-closed before any relaunch');
}));

test('gate.resolve throwing → revive-ownership-unverified (503)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  setGate(h.supervisor, { resolve: async () => { throw new Error('native unavailable'); } });
  const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-ownership-unverified');
  assert.equal(spy.stops, 0);
}));

// ── gate action matrix ───────────────────────────────────────────────────────────

for (const action of ['proceed', 'terminate-then-continue'] as const) {
  test(`gate '${action}' → revive proceeds to relaunch`, () => withHarness(async (h) => {
    const agent = terminalWorker(h.workspacePath);
    h.agents.push(agent);
    setGate(h.supervisor, fakeGate(action));
    const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
    const res = await revive(h.supervisor, agent.id);
    assert.ok(res.ok, `expected success for gate ${action}; got ${JSON.stringify(res)}`);
    assert.equal(spy.stops, 1);
    assert.equal(spy.resumes, 1);
  }));
}

for (const action of ['leave-unmanaged', 'blocked'] as const) {
  test(`gate '${action}' → revive-ownership-blocked (409), no stop/relaunch`, () => withHarness(async (h) => {
    const agent = terminalWorker(h.workspacePath);
    h.agents.push(agent);
    setGate(h.supervisor, fakeGate(action));
    const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
    const res = await revive(h.supervisor, agent.id);
    assert.equal((res as { code?: string }).code, 'revive-ownership-blocked');
    assert.equal((res as { statusCode?: number }).statusCode, 409);
    assert.equal(spy.stops, 0);
  }));
}

test(`gate 'reattach' on a NON-WSL (windows) cwd → revive-ownership-blocked (409)`, () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath); // windows cwd
  h.agents.push(agent);
  setGate(h.supervisor, fakeGate('reattach'));
  const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-ownership-blocked');
  assert.equal(spy.stops, 0);
}));

test(`gate 'reattach' on a WSL cwd → proceeds to relaunch (tested reattach path)`, () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { workingDirectory: '/home/x/proj' });
  h.agents.push(agent);
  setGate(h.supervisor, fakeGate('reattach'));
  // cwd '/home/x/proj' does not exist on the host; force the existence probe true
  // so we reach the gate. (fs is the shared module object index.ts imports.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realFs = require('fs');
  const origExists = realFs.existsSync;
  realFs.existsSync = () => true;
  try {
    const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
    const res = await revive(h.supervisor, agent.id);
    assert.ok(res.ok, `expected success for WSL reattach; got ${JSON.stringify(res)}`);
    assert.equal(spy.stops, 1, 'exactly one stop (no duplicate session)');
    assert.equal(spy.resumes, 1, 'exactly one relaunch (no duplicate session)');
  } finally { realFs.existsSync = origExists; }
}));

// ── StopResult verification ──────────────────────────────────────────────────────

test(`StopResult 'failed' → revive-stop-failed (409), no relaunch`, () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  const spy = spyLifecycle(h.supervisor, { outcome: 'failed' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-stop-failed');
  assert.equal((res as { statusCode?: number }).statusCode, 409);
  assert.equal(spy.resumes, 0, 'a failed stop never relaunches');
}));

test(`StopResult 'not_found' → revive-agent-missing (404)`, () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  spyLifecycle(h.supervisor, { outcome: 'not_found' });
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-agent-missing');
}));

// ── relaunch failure: staged prompt cleaned, no 'revived' event ──────────────────

test('agent deleted between stop and relaunch → revive-relaunch-failed (500), staged prompt cleaned, no revived event', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  // Real stop; then vanish the agent so the REAL resume tail throws.
  (h.supervisor as unknown as { stopAgentLocked: unknown }).stopAgentLocked = async () => {
    const i = h.agents.findIndex(a => a.id === agent.id);
    if (i >= 0) h.agents.splice(i, 1);
    return { outcome: 'already_stopped' };
  };
  const res = await revive(h.supervisor, agent.id, { message: 'do the thing' });
  assert.equal((res as { code?: string }).code, 'revive-relaunch-failed');
  assert.equal((res as { statusCode?: number }).statusCode, 500);
  assert.equal(getPending(h.supervisor, agent.id), undefined, 'the staged prompt was cleaned up');
  assert.ok(!h.events.some(e => e.type === 'revived'), `'revived' is NOT recorded on a failed relaunch`);
}));

test('manual restartAgent on a vanishing agent still no-ops silently', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { status: 'idle' });
  h.agents.push(agent);
  (h.supervisor as unknown as { stopAgentLocked: unknown }).stopAgentLocked = async () => {
    const i = h.agents.findIndex(a => a.id === agent.id);
    if (i >= 0) h.agents.splice(i, 1);
    return { outcome: 'stopped' };
  };
  // Must not throw (manual restart swallows a missing-agent tail).
  await h.supervisor.restartAgent(agent.id);
}));

// ── successor guard (supervisor targets only) ────────────────────────────────────

test('an ordinary worker revives even when a live supervisor exists in its workspace', () => withHarness(async (h) => {
  const worker = terminalWorker(h.workspacePath, { id: 'w-1', isWorker: true, isSupervisor: false });
  const liveSup = makeAgent('sup-live', { workspaceId: 'ws-1', isSupervisor: true, status: 'working' });
  h.agents.push(worker, liveSup);
  const res = await revive(h.supervisor, 'w-1');
  assert.ok(res.ok, `worker revival must not be blocked by a live supervisor; got ${JSON.stringify(res)}`);
}));

test('a done supervisor with a live successor supervisor → revive-live-successor (409)', () => withHarness(async (h) => {
  const doneSup = terminalWorker(h.workspacePath, { id: 'sup-old', isWorker: false, isSupervisor: true, status: 'done' });
  const liveSup = makeAgent('sup-new', { workspaceId: 'ws-1', isSupervisor: true, status: 'idle' });
  h.agents.push(doneSup, liveSup);
  const res = await revive(h.supervisor, 'sup-old');
  assert.equal((res as { code?: string }).code, 'revive-live-successor');
  assert.equal((res as { statusCode?: number }).statusCode, 409);
}));

test('force revives a done supervisor past a live successor', () => withHarness(async (h) => {
  const doneSup = terminalWorker(h.workspacePath, { id: 'sup-old', isWorker: false, isSupervisor: true, status: 'done' });
  const liveSup = makeAgent('sup-new', { workspaceId: 'ws-1', isSupervisor: true, status: 'idle' });
  h.agents.push(doneSup, liveSup);
  const res = await revive(h.supervisor, 'sup-old', { force: true });
  assert.ok(res.ok, `force must bypass the successor guard; got ${JSON.stringify(res)}`);
}));

// ── assertResumable (WP3.2) ──────────────────────────────────────────────────────

test('claude with no resumeSessionId → revive-no-session (422)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { resumeSessionId: null });
  h.agents.push(agent);
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-no-session');
  assert.equal((res as { statusCode?: number }).statusCode, 422);
}));

test('claude with a resumeSessionId but no jsonl on disk → revive-no-session (422)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  setSessionExists(h.supervisor, false);
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-no-session');
}));

test('gemini → revive-unsupported-provider (422), message names supported providers', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { provider: 'gemini' });
  h.agents.push(agent);
  let caught: { code?: string; statusCode?: number; message?: string } | null = null;
  try { await h.supervisor.reviveAgent(agent.id, {}); }
  catch (err) { caught = err as { code?: string; statusCode?: number; message?: string }; }
  assert.ok(caught, 'gemini revival throws');
  assert.equal(caught!.code, 'revive-unsupported-provider');
  assert.equal(caught!.statusCode, 422);
  assert.ok(/claude/.test(caught!.message ?? '') && /codex/.test(caught!.message ?? ''),
    'the error names the supported providers');
}));

test('grok → revive-unsupported-provider (422), message names grok as not-yet-session-mapped', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { provider: 'grok' });
  h.agents.push(agent);
  let caught: { code?: string; statusCode?: number; message?: string } | null = null;
  try { await h.supervisor.reviveAgent(agent.id, {}); }
  catch (err) { caught = err as { code?: string; statusCode?: number; message?: string }; }
  assert.ok(caught, 'grok revival throws');
  assert.equal(caught!.code, 'revive-unsupported-provider');
  assert.equal(caught!.statusCode, 422);
  // Regression (plan §1.7): grok falls into the same default: branch as gemini,
  // and the message now names grok explicitly so the copy is not misleading.
  assert.ok(/grok/.test(caught!.message ?? ''), 'the error names grok');
  assert.ok(/claude/.test(caught!.message ?? '') && /codex/.test(caught!.message ?? ''),
    'the error still names the supported providers');
}));

test('grok revive rejects WITHOUT synthesizing a cwd-based session identity', () => withHarness(async (h) => {
  // Boundary (plan §4.3): assertResumable hits the default: branch for grok and
  // throws BEFORE any codex session resolution. A grok agent must never have a
  // cwd-matching rollout synthesized as its "session" — resolveCodexResumeSessionId
  // (which falls back to the cwd rollout scan) must not be consulted at all.
  const agent = terminalWorker(h.workspacePath, { provider: 'grok' });
  h.agents.push(agent);
  let codexResolveCalls = 0;
  (h.supervisor as unknown as { resolveCodexResumeSessionId: unknown }).resolveCodexResumeSessionId = () => {
    codexResolveCalls++;
    return 'SHOULD-NOT-BE-SYNTHESIZED';
  };
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-unsupported-provider',
    'grok is rejected at the unsupported-provider gate, not routed through codex resolution');
  assert.equal(codexResolveCalls, 0, 'no cwd-based codex session identity may be synthesized for grok');
}));

test('a fresh grok launch does not scan ~/.codex (discovery gate declines non-codex providers)', () => {
  // Boundary (plan §4.3): the post-launch codex SQLite/rollout discovery is
  // gated by shouldDiscoverCodexSession, which is provider === 'codex' only.
  // grok — resume or fresh — never enters that scan, so no ~/.codex read runs
  // for a grok launch.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shouldDiscoverCodexSession } = require('./session-id-discovery') as {
    shouldDiscoverCodexSession: (o: { provider: string; resume: boolean; freshSession: boolean }) => boolean;
  };
  assert.equal(shouldDiscoverCodexSession({ provider: 'grok', resume: false, freshSession: false }), false,
    'a fresh grok launch does not run codex session discovery');
  assert.equal(shouldDiscoverCodexSession({ provider: 'grok', resume: false, freshSession: true }), false,
    'a fresh-session grok launch still does not scan ~/.codex');
  assert.equal(shouldDiscoverCodexSession({ provider: 'grok', resume: true, freshSession: false }), false,
    'a resume-shaped grok launch (not that grok resumes) still does not scan ~/.codex');
  // Positive control: codex DOES trigger discovery on a fresh launch.
  assert.equal(shouldDiscoverCodexSession({ provider: 'codex', resume: false, freshSession: false }), true,
    'control: codex fresh launch triggers discovery');
});

test('codex whose session cannot be resolved → revive-no-session (422)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { provider: 'codex', resumeSessionId: null });
  h.agents.push(agent);
  // resolveCodexResumeSessionId falls back to a cwd rollout scan; force null.
  (h.supervisor as unknown as { resolveCodexResumeSessionId: unknown }).resolveCodexResumeSessionId = () => null;
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-no-session');
}));

test('a codex agent whose session DOES resolve is resumable', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { provider: 'codex', resumeSessionId: 'codex-sess' });
  h.agents.push(agent);
  (h.supervisor as unknown as { resolveCodexResumeSessionId: unknown }).resolveCodexResumeSessionId = () => 'codex-sess';
  const spy = spyLifecycle(h.supervisor, { outcome: 'already_stopped' });
  const res = await revive(h.supervisor, agent.id);
  assert.ok(res.ok, `codex with a resolvable session should revive; got ${JSON.stringify(res)}`);
  assert.equal(spy.resumes, 1);
}));

// ── missing workspace / cwd ──────────────────────────────────────────────────────

test('missing workspace → revive-workspace-gone (410)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-workspace-gone');
  assert.equal((res as { statusCode?: number }).statusCode, 410);
}, { workspaceExists: false }));

test('missing cwd → revive-cwd-gone (410)', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath, { workingDirectory: path.join(h.workspacePath, 'does-not-exist') });
  h.agents.push(agent);
  const res = await revive(h.supervisor, agent.id);
  assert.equal((res as { code?: string }).code, 'revive-cwd-gone');
  assert.equal((res as { statusCode?: number }).statusCode, 410);
}));

// ── capability: fresh mint on revive, old token dead ─────────────────────────────

test('a revived agent gets a freshly minted capability; the pre-revive token no longer resolves', () => withHarness(async (h) => {
  const agent = terminalWorker(h.workspacePath);
  h.agents.push(agent);
  // Mint an "old" token for the agent (as its prior launch would have).
  const oldToken = agentCapabilities.mint({ agentId: agent.id, workspaceId: agent.workspaceId, privilegeLane: 'worker' });
  assert.ok(agentCapabilities.resolve(oldToken), 'the old token resolves before revive');
  const res = await revive(h.supervisor, agent.id);
  assert.ok(res.ok, `expected success; got ${JSON.stringify(res)}`);
  assert.equal(agentCapabilities.resolve(oldToken), null, 'the pre-revive token no longer resolves');
  const fresh = agentCapabilities.tokenForAgent(agent.id);
  assert.ok(fresh && fresh !== oldToken, 'a fresh, different token was minted on relaunch');
  assert.equal(agentCapabilities.resolve(fresh!)?.privilegeLane, 'worker', 'the fresh token resolves to the worker lane');
}));

// ── Runner ────────────────────────────────────────────────────────────────────
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
