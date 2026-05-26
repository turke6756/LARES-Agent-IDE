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
