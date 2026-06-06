// Tests for T1-A (pending-status.jsonl failure log in .dashboard/scripts/
// dashboard-status.mjs) and T1-B (DASHBOARD_HOST env-var injection for WSL
// supervised workers, no DASHBOARD_HOST on the Windows path). See
// plans/windows-wsl-issues-review-2026-05-23.md §Tier 1 T1-A / T1-B.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/dashboard-host-injection.test.js

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, AgentStatus } from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── DB module patching (mirrors agent-supervisor.test.ts) ────────────
function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'updateAgentPid', 'getAgent', 'addEvent',
    'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
    'addFileActivity', 'updateAgentResumeSessionId',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};

  return () => { for (const k of keys) db[k] = orig[k]; };
}

function makeSupervisor(): AgentSupervisor {
  const s = new AgentSupervisor();
  (s as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  // Avoid shelling out to wsl.exe in tests. Override the cached gateway
  // resolver to a known fake IP so the assertion is deterministic.
  (s as unknown as { resolveWslGatewayIp: () => string }).resolveWslGatewayIp = () => '10.0.0.42';
  return s;
}

// ── Tests ────────────────────────────────────────────────────────────

test('WSL supervised Claude launch injects DASHBOARD_HOST in the bash command-prefix', async () => {
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap);

  const captured: { command: string | null } = { command: null };
  const origWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner, _workDir: string, command: string, _logPath: string,
  ) {
    captured.command = command;
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    const agent = makeAgent('wsl-host-1', {
      provider: 'claude',
      isSupervised: true,
      command: 'ccode --dangerously-skip-permissions',
      workingDirectory: '/home/test/ws',
      tmuxSessionName: 'cad__wsl-host-1',
    });
    agentsMap.set(agent.id, agent);

    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);

    assert.ok(captured.command, 'WslRunner.launch must have been called');
    const cmd = captured.command as string;
    assert.match(
      cmd, /AGENT_ID=wsl-host-1/,
      `expected AGENT_ID= in WSL command-prefix; got: ${cmd}`,
    );
    assert.match(
      cmd, /DASHBOARD_PORT=\d+/,
      `expected DASHBOARD_PORT= in WSL command-prefix; got: ${cmd}`,
    );
    assert.match(
      cmd, /DASHBOARD_HOST=10\.0\.0\.42/,
      `expected DASHBOARD_HOST=10.0.0.42 in WSL command-prefix; got: ${cmd}`,
    );
  } finally {
    (WslRunner.prototype as { launch: unknown }).launch = origWslLaunch;
    restoreDb();
  }
});

test('WSL unsupervised launch does NOT inject AGENT_ID/DASHBOARD_HOST', async () => {
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap);

  const captured: { command: string | null } = { command: null };
  const origWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner, _workDir: string, command: string, _logPath: string,
  ) {
    captured.command = command;
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    const agent = makeAgent('wsl-host-2', {
      provider: 'claude',
      isSupervised: false,
      command: 'ccode',
      workingDirectory: '/home/test/ws',
      tmuxSessionName: 'cad__wsl-host-2',
    });
    agentsMap.set(agent.id, agent);

    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);

    assert.ok(captured.command, 'WslRunner.launch must have been called');
    const cmd = captured.command as string;
    assert.ok(!/AGENT_ID=/.test(cmd), `unsupervised must NOT inject AGENT_ID; got: ${cmd}`);
    assert.ok(!/DASHBOARD_HOST=/.test(cmd), `unsupervised must NOT inject DASHBOARD_HOST; got: ${cmd}`);
  } finally {
    (WslRunner.prototype as { launch: unknown }).launch = origWslLaunch;
    restoreDb();
  }
});

test('Windows supervised Claude launch does NOT inject DASHBOARD_HOST (extraEnv check)', async () => {
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap);

  const captured: { extraEnv: Record<string, string> | undefined | null } = { extraEnv: null };
  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string, _command: string, _args: string[], _logPath: string,
    _directSpawn?: boolean, extraEnv?: Record<string, string>,
  ) {
    captured.extraEnv = extraEnv ?? undefined;
    (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  try {
    const agent = makeAgent('win-host-1', {
      provider: 'claude',
      isSupervised: true,
      command: 'claude --dangerously-skip-permissions',
      workingDirectory: 'C:\\tmp\\ws',
    });
    agentsMap.set(agent.id, agent);

    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);

    assert.ok(captured.extraEnv, 'WindowsRunner.launch must have been called with extraEnv');
    const env = captured.extraEnv as Record<string, string>;
    assert.equal(env.AGENT_ID, 'win-host-1', 'Windows supervised launch should inject AGENT_ID');
    assert.ok(env.DASHBOARD_PORT, 'Windows supervised launch should inject DASHBOARD_PORT');
    assert.ok(
      !('DASHBOARD_HOST' in env),
      `Windows path must not set DASHBOARD_HOST (script falls back to 127.0.0.1); got: ${JSON.stringify(env)}`,
    );
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
    restoreDb();
  }
});

// ── dashboard-status.mjs failure-log behavior (T1-A) ──────────────────

test('dashboard-status.mjs (v7) spools to pending-status.jsonl when fetch fails', async () => {
  // Build a fake workspace tree from the BUNDLED script constant (not the
  // repo's on-disk scaffold copy, which lags until the workspace rescaffolds):
  //   <workspace>/.dashboard/scripts/dashboard-status.mjs   ← v7 script
  //   <workspace>/.dashboard/pending-status.jsonl           ← spool (always-write)
  // No DASHBOARD_SPOOL_PATH in env → exercises the script-relative fallback.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-status-fail-'));
  const scriptsDir = path.join(workspace, '.dashboard', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DASHBOARD_STATUS_SCRIPT_MJS } = require('../../shared/constants') as {
    DASHBOARD_STATUS_SCRIPT_MJS: string;
  };
  const destScript = path.join(scriptsDir, 'dashboard-status.mjs');
  fs.writeFileSync(destScript, DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8');

  const pendingLog = path.join(workspace, '.dashboard', 'pending-status.jsonl');
  assert.equal(fs.existsSync(pendingLog), false, 'precondition: pending-status.jsonl must not exist');

  // Run the script with a port that won't accept connections so fetch fails fast.
  // 1 is the always-rejected port assignment (privileged + unallocated).
  const result = spawnSync(process.execPath, [destScript], {
    env: {
      ...process.env,
      AGENT_ID: 'agent-failure-test',
      DASHBOARD_PORT: '1',
      DASHBOARD_HOST: '127.0.0.1',
      CLAUDE_HOOK_EVENT_NAME: 'Stop',
    },
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'], // closed stdin → no 300 ms stall
  });
  assert.equal(result.status, 0, `script must exit 0 even on failure; stderr=${result.stderr}`);

  try {
    assert.ok(fs.existsSync(pendingLog), `pending-status.jsonl must exist after failed POST (script stderr=${result.stderr})`);
    const lines = fs.readFileSync(pendingLog, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly one spool record; got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.v, 1);
    assert.equal(entry.agentId, 'agent-failure-test');
    assert.equal(entry.state, 'idle');
    assert.equal(entry.source, 'hook-stop');
    assert.equal(entry.hookEventName, 'Stop');
    assert.ok(typeof entry.ts === 'number' && entry.ts > 0, 'ts must be a positive number');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
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
