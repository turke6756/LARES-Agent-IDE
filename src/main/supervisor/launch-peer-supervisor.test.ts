// WP4.1/WP4.2 (plans/cross-workspace-collaboration.md — "WP4 — Peer-supervisor
// launch mode") — AgentSupervisor.launchAgent's `launchMode` canonicalization,
// exercised over a REAL supervisor with the runner + scaffolding stubbed.
//
// Coverage (the plan's "WP4 tests" bullet, supervisor half):
//   - launchMode:'supervisor-peer' resolves the .lares/supervisor CWD (asserted on
//     the resolved workingDirectory, not just the stored flags), forces
//     isSupervisor:true, clears isSupervised/isWorker/ownerAgentId (no owner edge
//     even when ownerAgentId is supplied), and NEVER nests;
//   - is_researcher + peer → peer-mode-incompatible (400); persona + peer likewise;
//   - worker mode is unchanged: the owner edge is honored/validated as before.
//
//   npm run build:main
//   node dist/main/main/supervisor/launch-peer-supervisor.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor } from './index';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { agentCapabilities } from '../security/agent-capabilities';
import type { Agent, LaunchAgentInput } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── DB patch (credential-propagation.test.ts shape) ─────────────────────────────

function patchDb(workspacePath: string, created: Agent[], existing: Agent[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'applyStatusTransition', 'updateAgentPid',
    'getAgent', 'getAgentsByWorkspace', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'updateAgentHookStatus',
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getAgentTemplate', 'getFileActivities', 'insertAgentSession',
    'getCurrentBrick', 'getContinuationAttempt', 'incrementRestartCount',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.getWorkspace = (id: string) => ({ id, path: workspacePath, defaultCommand: 'claude' });
  db.createAgent = (input: Partial<Agent>) => {
    const a = makeAgent(`created-${created.length}`, input);
    created.push(a);
    return a;
  };
  db.updateAgentStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) =>
    created.find(a => a.id === id) ?? existing.find(a => a.id === id) ?? null;
  db.getAgentsByWorkspace = (wsId: string) =>
    [...existing, ...created].filter(a => a.workspaceId === wsId);
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => [...existing, ...created];
  db.getAllAgents = () => [...existing, ...created];
  db.getSupervisorAgent = () => null;
  db.updateAgentHookStatus = () => {};
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

// ── supervisor with ALL scaffold/launch side effects neutralized ────────────────

interface LaunchedCapture { agent: Agent | null; }

function makeSupervisor(cap: LaunchedCapture): AgentSupervisor {
  const s = new AgentSupervisor();
  const anyS = s as unknown as Record<string, unknown>;
  // base heavy side effects (credential-propagation.test.ts shape)
  anyS.writeAgentRegistry = () => {};
  anyS.reclaimTerminalCheckpoint = () => {};
  anyS.ensureSpoolTailer = () => {};
  anyS.healLegacyStateDirScaffold = () => {};
  anyS.setupFileTracker = () => null;
  anyS.sweepStaleSyspromptFiles = () => {};
  anyS.buildContinuationBrickBlock = () => '';
  // launchAgent scaffold surface (supervisor lane) — all filesystem/provider IO
  anyS.ensureWorkspaceScripts = () => {};
  anyS.ensureSupervisorScaffold = () => {};
  anyS.ensureWorkerScaffold = () => {};
  anyS.ensureResearchStoreScaffold = () => {};
  anyS.ensureProviderDirTrust = () => {};
  anyS.retireStaleRootMcpConfig = () => {};
  anyS.loadAgentMd = () => null;
  // the launch-time hook canary reaches the real StatusMonitor — stub the method
  (s as unknown as { monitor: Record<string, unknown> }).monitor.recordHookCanary = () => {};
  // Capture the agent handed to the runner-facing launch method instead of
  // spawning. The agent carries the RESOLVED workingDirectory (agentCwd).
  anyS.launchWindowsAgent = async (agent: Agent) => { cap.agent = agent; };
  anyS.launchWslAgent = async (agent: Agent) => { cap.agent = agent; };
  return s;
}

async function withHarness(
  fn: (deps: {
    supervisor: AgentSupervisor; created: Agent[]; existing: Agent[];
    workspacePath: string; captured: LaunchedCapture;
  }) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-sup-'));
  const created: Agent[] = [];
  const existing: Agent[] = [];
  const captured: LaunchedCapture = { agent: null };
  const restoreDb = patchDb(workspacePath, created, existing);
  agentCapabilities.clear();
  try {
    await fn({ supervisor: makeSupervisor(captured), created, existing, workspacePath, captured });
  } finally {
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

function baseInput(over: Partial<LaunchAgentInput> = {}): LaunchAgentInput {
  return { workspaceId: 'ws-own', title: 'Peer Sup', provider: 'claude', ...over };
}

// ── supervisor-peer canonicalization ────────────────────────────────────────────

test('supervisor-peer resolves the .lares/supervisor cwd (not just the flags)', () => withHarness(async (h) => {
  const agent = await h.supervisor.launchAgent(baseInput({ launchMode: 'supervisor-peer' }));
  const expected = path.join(h.workspacePath, '.lares', 'supervisor');
  assert.equal(agent.workingDirectory, expected,
    `resolved cwd must be the supervisor state dir; got ${agent.workingDirectory}`);
  // the SAME resolved cwd reaches the runner-facing launch method
  assert.ok(h.captured.agent, 'a launch was dispatched');
  assert.equal(h.captured.agent!.workingDirectory, expected, 'the launched agent carries the resolved supervisor cwd');
  assert.equal(path.basename(agent.workingDirectory), 'supervisor');
}));

test('supervisor-peer forces isSupervisor:true, clears isSupervised/isWorker, no owner edge', () => withHarness(async (h) => {
  const agent = await h.supervisor.launchAgent(baseInput({
    launchMode: 'supervisor-peer',
    // hostile/leftover flags that peer mode must override:
    isSupervised: true, isWorker: true, isSupervisor: false,
  }));
  assert.equal(agent.isSupervisor, true, 'peer is a supervisor');
  assert.equal(agent.isSupervised, false, 'peer is not supervised');
  assert.equal(agent.isWorker, false, 'peer is not a worker');
  assert.equal(agent.isResearcher, false, 'peer is not a researcher');
  assert.equal(agent.ownerAgentId ?? null, null, 'a peer has NO owner edge (top-level)');
}));

test('supervisor-peer drops a supplied ownerAgentId (never nests), even a VALID one', () => withHarness(async (h) => {
  // A valid, same-workspace, non-terminal owner would normally be honored in
  // worker mode; peer mode must still drop it (a peer is top-level).
  const owner = makeAgent('owner-1', { workspaceId: 'ws-own', isSupervisor: true, status: 'idle' });
  h.existing.push(owner);
  const agent = await h.supervisor.launchAgent(baseInput({
    launchMode: 'supervisor-peer', ownerAgentId: 'owner-1',
  }));
  assert.equal(agent.ownerAgentId ?? null, null, 'the owner edge is dropped in peer mode');
  assert.equal(agent.isSupervisor, true);
}));

// ── incompatible combinations → peer-mode-incompatible (400) ────────────────────

function launchErr(fn: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number } | null> {
  return fn().then(() => null, (err) => err as { code?: string; statusCode?: number });
}

test('is_researcher + supervisor-peer → peer-mode-incompatible (400), never launched', () => withHarness(async (h) => {
  const err = await launchErr(() => h.supervisor.launchAgent(baseInput({
    launchMode: 'supervisor-peer', isResearcher: true,
  })));
  assert.ok(err, 'the launch throws');
  assert.equal(err!.code, 'peer-mode-incompatible');
  assert.equal(err!.statusCode, 400);
  assert.equal(h.captured.agent, null, 'no launch was dispatched');
  assert.equal(h.created.length, 0, 'no agent row was created');
}));

test('persona + supervisor-peer → peer-mode-incompatible (400)', () => withHarness(async (h) => {
  const err = await launchErr(() => h.supervisor.launchAgent(baseInput({
    launchMode: 'supervisor-peer', persona: 'some-persona',
  })));
  assert.ok(err, 'the launch throws');
  assert.equal(err!.code, 'peer-mode-incompatible');
  assert.equal(err!.statusCode, 400);
  assert.equal(h.created.length, 0);
}));

// ── worker mode is unchanged (owner edge honored + validated) ────────────────────

test('worker mode (default) honors a valid same-workspace owner edge', () => withHarness(async (h) => {
  const owner = makeAgent('owner-2', { workspaceId: 'ws-own', isSupervisor: true, status: 'idle' });
  h.existing.push(owner);
  const agent = await h.supervisor.launchAgent(baseInput({
    title: 'Worker', isWorker: true, ownerAgentId: 'owner-2',
  }));
  assert.equal(agent.isSupervisor ?? false, false, 'a worker is not a supervisor');
  assert.equal(agent.ownerAgentId, 'owner-2', 'the owner edge is honored in worker mode');
  // resolved cwd is the worker lane, NOT the supervisor dir
  assert.equal(path.basename(agent.workingDirectory), 'claude',
    `a worker resolves the per-provider worker cwd; got ${agent.workingDirectory}`);
}));

test('worker mode drops an INVALID (foreign-workspace) owner edge without throwing', () => withHarness(async (h) => {
  const foreignOwner = makeAgent('owner-foreign', { workspaceId: 'ws-other', isSupervisor: true, status: 'idle' });
  h.existing.push(foreignOwner);
  const agent = await h.supervisor.launchAgent(baseInput({
    title: 'Worker', isWorker: true, ownerAgentId: 'owner-foreign',
  }));
  assert.equal(agent.ownerAgentId ?? null, null, 'a cross-workspace owner edge is dropped (not trusted)');
}));

// ── Runner ──────────────────────────────────────────────────────────────────────
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
