// Tests for the agentCwd ensure-exists + path-injection guard added in
// launchAgent (src/main/supervisor/index.ts, just after agentCwd resolution).
//
// Covers:
//   1. Supervised codex launch on Windows mkdirs `.dashboard/workers/codex/`
//      that the claude-only scaffolder would otherwise skip.
//   2. Explicit `working_directory` that escapes the workspace root is
//      rejected with a clear error instead of silently mkdir-ing arbitrary
//      tree depth.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/launch-cwd.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent } from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── DB module patching ───────────────────────────────────────────────
// Wider than agent-supervisor.test.ts's patchDb because `launchAgent`
// itself touches getWorkspace / createAgent / getAgentTemplate /
// getTeamMembership / updateAgentResumeSessionId, none of which the
// launch-seed tests exercise.
function patchDb(workspacePath: string, createdAgents: Agent[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getAgentTemplate', 'getFileActivities',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.getWorkspace = (id: string) => ({
    id,
    path: workspacePath,
    defaultCommand: 'claude --dangerously-skip-permissions --chrome',
  });
  db.createAgent = (input: Partial<Agent>) => {
    const a = makeAgent(`agent-${createdAgents.length}`, input);
    createdAgents.push(a);
    return a;
  };
  db.updateAgentStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => createdAgents.find(a => a.id === id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => createdAgents;
  db.getAllAgents = () => createdAgents;
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];

  return () => {
    for (const k of keys) db[k] = orig[k];
  };
}

// Stub runner.launch on both prototypes so launchAgent doesn't actually
// spawn pty-host. The Windows runner needs a non-null _pid so the
// `updateAgentPid` path doesn't choke.
function patchRunners(): () => void {
  const origWin = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (this: WindowsRunner) {
    (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  const origWsl = (WslRunner.prototype as { launch: unknown }).launch;
  (WslRunner.prototype as { launch: unknown }).launch = async function (this: WslRunner) {
    (this as unknown as { _alive: boolean })._alive = true;
  };
  return () => {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWin;
    (WslRunner.prototype as { launch: unknown }).launch = origWsl;
  };
}

function makeSupervisor(): AgentSupervisor {
  const s = new AgentSupervisor();
  // Suppress writes to ~/.claude/agent-registry.json triggered by emit('statusChanged').
  (s as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  return s;
}

// ── Tests ────────────────────────────────────────────────────────────

test('launchAgent mkdirs .dashboard/workers/<provider>/ for a supervised codex launch (Windows)', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cwd-codex-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor();

    const expectedCwd = path.join(workspacePath, '.dashboard', 'workers', 'codex');
    assert.equal(
      fs.existsSync(expectedCwd),
      false,
      `precondition: ${expectedCwd} must not exist before launch`,
    );

    await supervisor.launchAgent({
      workspaceId: 'ws-1',
      title: 'codex worker',
      provider: 'codex',
      isSupervised: true,
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
    });

    assert.ok(
      fs.existsSync(expectedCwd),
      `expected ${expectedCwd} to exist after launchAgent (this is the bug — claude-only scaffolder never mkdirs codex)`,
    );
    assert.ok(
      fs.statSync(expectedCwd).isDirectory(),
      `${expectedCwd} must be a directory`,
    );
    assert.equal(created.length, 1, 'one agent row should be created');
    assert.equal(
      created[0].workingDirectory,
      expectedCwd,
      'agentCwd persisted on the agent row must match the mkdir target',
    );
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('launchAgent rejects working_directory that escapes the workspace root', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cwd-ws-'));
  const escapePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cwd-escape-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor();

    await assert.rejects(
      supervisor.launchAgent({
        workspaceId: 'ws-1',
        title: 'hostile',
        provider: 'claude',
        workingDirectory: escapePath,
      }),
      /outside workspace root/i,
      'expected throw with "outside workspace root" when working_directory points elsewhere',
    );

    // The escape dir was a pre-existing tmpdir — confirm we didn't leak any
    // .dashboard subtree into it (i.e. the throw happened before mkdir).
    assert.equal(
      fs.existsSync(path.join(escapePath, '.dashboard')),
      false,
      'guard must throw before any mkdir under the escape path',
    );
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(escapePath, { recursive: true, force: true });
  }
});

// Stub the scaffold / dir-trust side-effects on an AgentSupervisor instance so a
// launchAgent call in these command-resolution tests writes nothing outside the
// tmp workspace and never seeds the user's global ~/.claude.json dir-trust.
function stubLaunchSideEffects(supervisor: AgentSupervisor): void {
  const s = supervisor as unknown as Record<string, unknown>;
  s.ensureResearcherScaffold = () => {};
  s.ensureWorkerScaffold = () => {};
  s.ensureResearchStoreScaffold = () => {};
  s.ensureProviderDirTrust = () => {};
  s.loadAgentMd = () => null;
}

test('researcher resolved command carries --chrome (cic is the researcher-only fallback browser)', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cwd-rsch-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor();
    stubLaunchSideEffects(supervisor);
    await supervisor.launchAgent({
      workspaceId: 'ws-1',
      title: 'researcher',
      provider: 'claude',
      isResearcher: true,
    });
    assert.equal(created.length, 1, 'one agent row should be created');
    assert.match(
      created[0].command,
      /--chrome\b/,
      `researcher command must carry --chrome so claude-in-chrome stays available as the lane's fallback browser; got: ${created[0].command}`,
    );
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('non-researcher (worker) resolved command strips --chrome even from a legacy --chrome workspace command (cic removed from non-researcher lanes)', async () => {
  // patchDb's getWorkspace returns defaultCommand 'claude … --chrome' (a legacy
  // stored row from before --chrome was dropped from the framework default).
  // A worker uses that command verbatim, so the strip must neutralize it.
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cwd-wrk-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor();
    stubLaunchSideEffects(supervisor);
    await supervisor.launchAgent({
      workspaceId: 'ws-1',
      title: 'worker',
      provider: 'claude',
      isWorker: true,
    });
    assert.equal(created.length, 1, 'one agent row should be created');
    assert.ok(
      !/--chrome\b/.test(created[0].command),
      `worker command must NOT carry --chrome (cic is removed from every non-researcher lane); got: ${created[0].command}`,
    );
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ── Agent-ownership primitive: launch-time edge validation (§4.1) ─────
// launchAgent must persist a VALID owner edge and DROP (warn, never throw)
// a foreign / missing / terminal one — the launch always proceeds.

async function launchWithOwner(
  workspacePath: string,
  created: Agent[],
  ownerAgentId: string | undefined,
): Promise<Agent> {
  const supervisor = makeSupervisor();
  stubLaunchSideEffects(supervisor);
  await supervisor.launchAgent({
    workspaceId: 'ws-1',
    title: 'worker',
    provider: 'claude',
    isWorker: true,
    ownerAgentId,
  });
  // The worker is the last row createAgent pushed (any pre-seeded owners precede it).
  return created[created.length - 1];
}

test('launchAgent persists a valid (live, same-workspace) owner edge', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-own-ok-'));
  const created: Agent[] = [];
  // Pre-seed an alive owner in the same workspace (ws-1) so getAgent resolves it.
  created.push(makeAgent('owner-live', { workspaceId: 'ws-1', status: 'idle' }));
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const worker = await launchWithOwner(workspacePath, created, 'owner-live');
    assert.equal(worker.ownerAgentId, 'owner-live', 'valid owner edge must persist onto the worker row');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('launchAgent drops a MISSING owner id and still launches', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-own-missing-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const worker = await launchWithOwner(workspacePath, created, 'does-not-exist');
    assert.equal(worker.ownerAgentId, null, 'missing owner id must be dropped to null');
    assert.equal(created.length, 1, 'launch still proceeded (one worker row created)');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('launchAgent drops a FOREIGN-workspace owner edge and still launches', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-own-foreign-'));
  const created: Agent[] = [];
  created.push(makeAgent('owner-foreign', { workspaceId: 'ws-OTHER', status: 'idle' }));
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const worker = await launchWithOwner(workspacePath, created, 'owner-foreign');
    assert.equal(worker.ownerAgentId, null, 'owner in a different workspace must be dropped');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('launchAgent drops a TERMINAL owner edge and still launches', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-own-terminal-'));
  const created: Agent[] = [];
  created.push(makeAgent('owner-dead', { workspaceId: 'ws-1', status: 'done' }));
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const worker = await launchWithOwner(workspacePath, created, 'owner-dead');
    assert.equal(worker.ownerAgentId, null, 'terminal owner must be dropped (no immediately-backstopping edge persisted)');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('forkAgent inherits ownerAgentId from the source', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-own-fork-'));
  const created: Agent[] = [];
  // Seed a forkable claude source carrying an owner edge.
  const source = makeAgent('src-1', {
    workspaceId: 'ws-1',
    provider: 'claude',
    workingDirectory: path.join(workspacePath, 'sub'),
    resumeSessionId: 'sess-1',
    status: 'idle',
    isWorker: true,
    ownerAgentId: 'owner-x',
  });
  created.push(source);
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor();
    // Isolate the createAgent edge-inheritance from the heavy launch machinery.
    const s = supervisor as unknown as Record<string, unknown>;
    s.launchWindowsAgent = async () => {};
    s.launchWslAgent = async () => {};
    s.buildDashboardMcpConfigForLane = () => 'cfg.json';

    await supervisor.forkAgent('src-1');
    const fork = created[created.length - 1];
    assert.notEqual(fork.id, source.id, 'a new fork row was created');
    assert.equal(fork.ownerAgentId, 'owner-x', 'fork inherits the source owner edge');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ── Runner ───────────────────────────────────────────────────────────
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
