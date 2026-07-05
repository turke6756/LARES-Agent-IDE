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
import { redactMcpToken } from './mcp-config-builder';
import { getApiToken } from '../security/api-auth';
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
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getCurrentBrick',
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
  // WP-A.2 — launch paths now read getTeamMembership for inline team MCP; no team here.
  db.getTeamMembership = () => null;
  // Context-brick Inc 4 (4.2) — every fresh launch consults the brick gate's
  // DB fallback; no continuation state in these fixtures.
  db.getCurrentBrick = () => null;

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

// ── WP-A.2 — per-lane --mcp-config / --strict-mcp-config launch arg-set ──
//
// NEW RULE (Step 4 follow-on): --strict-mcp-config fires IFF the agent's
// role-lane ∈ {worker, researcher} (the containment lanes). The supervisor
// keeps its inline dashboard --mcp-config but is NOT strict (so its globally
// configured Gmail/Calendar/Drive/claude-in-chrome MCP servers survive). Legacy
// gets no dashboard --mcp-config and is never strict.

// Capture the rendered WSL command for an agent with the given lane-flags.
async function captureWslLaunch(id: string, flags: Partial<Agent>): Promise<string> {
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
    const agent = makeAgent(id, {
      provider: 'claude',
      command: 'ccode --dangerously-skip-permissions',
      workingDirectory: '/home/test/ws',
      tmuxSessionName: `cad__${id}`,
      ...flags,
    });
    agentsMap.set(agent.id, agent);
    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);
    assert.ok(captured.command, 'WslRunner.launch must have been called');
    return captured.command as string;
  } finally {
    (WslRunner.prototype as { launch: unknown }).launch = origWslLaunch;
    restoreDb();
  }
}

// Capture the rendered Windows args[] for an agent with the given lane-flags.
async function captureWindowsLaunch(id: string, flags: Partial<Agent>): Promise<string[]> {
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap);
  const captured: { args: string[] | null } = { args: null };
  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string, _command: string, args: string[], _logPath: string,
  ) {
    captured.args = args;
    (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  try {
    const agent = makeAgent(id, {
      provider: 'claude',
      command: 'claude --dangerously-skip-permissions',
      workingDirectory: 'C:\\tmp\\ws',
      ...flags,
    });
    agentsMap.set(agent.id, agent);
    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
    assert.ok(captured.args, 'WindowsRunner.launch must have been called with args');
    return captured.args as string[];
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
    restoreDb();
  }
}

// Lane flag-sets (mirror roleLaneOf precedence: supervisor > researcher > worker).
const SUPERVISOR_FLAGS: Partial<Agent> = { isSupervisor: true, isSupervised: false, isWorker: false, isResearcher: false };
const WORKER_FLAGS: Partial<Agent> = { isSupervisor: false, isSupervised: true, isWorker: false, isResearcher: false };
const RESEARCHER_FLAGS: Partial<Agent> = { isSupervisor: false, isSupervised: false, isWorker: false, isResearcher: true };
const LEGACY_FLAGS: Partial<Agent> = { isSupervisor: false, isSupervised: false, isWorker: false, isResearcher: false };

// ── WSL path ─────────────────────────────────────────────────────────

test('WSL supervisor lane: --mcp-config PRESENT, --strict-mcp-config ABSENT', async () => {
  const cmd = await captureWslLaunch('wsl-lane-sup', SUPERVISOR_FLAGS);
  assert.match(cmd, /--mcp-config '[^']*agent-dashboard/, `supervisor must get inline dashboard --mcp-config; got: ${cmd}`);
  assert.ok(!/--strict-mcp-config/.test(cmd), `supervisor must NOT be strict (keeps global MCPs); got: ${cmd}`);
});

test('WSL worker lane: --mcp-config PRESENT and --strict-mcp-config PRESENT', async () => {
  const cmd = await captureWslLaunch('wsl-lane-wrk', WORKER_FLAGS);
  assert.match(cmd, /--mcp-config '[^']*agent-dashboard/, `worker must get inline dashboard --mcp-config; got: ${cmd}`);
  assert.match(cmd, /--strict-mcp-config/, `worker must be strict (containment); got: ${cmd}`);
});

test('WSL researcher lane: --mcp-config PRESENT and --strict-mcp-config PRESENT', async () => {
  const cmd = await captureWslLaunch('wsl-lane-res', RESEARCHER_FLAGS);
  assert.match(cmd, /--mcp-config '[^']*agent-dashboard/, `researcher must get inline dashboard --mcp-config; got: ${cmd}`);
  assert.match(cmd, /--strict-mcp-config/, `researcher must be strict (containment); got: ${cmd}`);
});

test('WSL legacy lane: no dashboard --mcp-config and no --strict-mcp-config', async () => {
  const cmd = await captureWslLaunch('wsl-lane-leg', LEGACY_FLAGS);
  assert.ok(!/agent-dashboard/.test(cmd), `legacy must NOT get the dashboard --mcp-config; got: ${cmd}`);
  assert.ok(!/--strict-mcp-config/.test(cmd), `legacy must NOT be strict; got: ${cmd}`);
});

// ── Windows path ─────────────────────────────────────────────────────

test('Windows supervisor lane: --mcp-config PRESENT, --strict-mcp-config ABSENT', async () => {
  const args = await captureWindowsLaunch('win-lane-sup', SUPERVISOR_FLAGS);
  assert.ok(args.includes('--mcp-config'), `supervisor must get --mcp-config; got: ${args.join(' ')}`);
  assert.ok(args.some(a => a.includes('agent-dashboard')), `supervisor --mcp-config must be the dashboard one; got: ${args.join(' ')}`);
  assert.ok(!args.includes('--strict-mcp-config'), `supervisor must NOT be strict; got: ${args.join(' ')}`);
});

test('Windows worker lane: --mcp-config PRESENT and --strict-mcp-config PRESENT', async () => {
  const args = await captureWindowsLaunch('win-lane-wrk', WORKER_FLAGS);
  assert.ok(args.includes('--mcp-config'), `worker must get --mcp-config; got: ${args.join(' ')}`);
  assert.ok(args.some(a => a.includes('agent-dashboard')), `worker --mcp-config must be the dashboard one; got: ${args.join(' ')}`);
  assert.ok(args.includes('--strict-mcp-config'), `worker must be strict; got: ${args.join(' ')}`);
});

test('Windows researcher lane: --mcp-config PRESENT and --strict-mcp-config PRESENT', async () => {
  const args = await captureWindowsLaunch('win-lane-res', RESEARCHER_FLAGS);
  assert.ok(args.includes('--mcp-config'), `researcher must get --mcp-config; got: ${args.join(' ')}`);
  assert.ok(args.some(a => a.includes('agent-dashboard')), `researcher --mcp-config must be the dashboard one; got: ${args.join(' ')}`);
  assert.ok(args.includes('--strict-mcp-config'), `researcher must be strict; got: ${args.join(' ')}`);
});

test('Windows legacy lane: no dashboard --mcp-config and no --strict-mcp-config', async () => {
  const args = await captureWindowsLaunch('win-lane-leg', LEGACY_FLAGS);
  assert.ok(!args.some(a => a.includes('agent-dashboard')), `legacy must NOT get the dashboard --mcp-config; got: ${args.join(' ')}`);
  assert.ok(!args.includes('--strict-mcp-config'), `legacy must NOT be strict; got: ${args.join(' ')}`);
});

// ── PHASE 0 (agent-ownership) — dashboard API credential in the agent's OWN
// process env so its Bash tool / child subprocesses inherit it ─────────────
//
// The bearer token was previously injected ONLY into the MCP sidecar's env
// (inline --mcp-config), so a script the agent ran from Bash that POSTed the
// dashboard HTTP API got 401. These tests pin the fix on BOTH spawn paths and
// pin the gate to the SAME predicate as the MCP-token injection
// (roleLaneOf !== 'legacy'), so the two can never diverge.
//
// NOTE ON WSLENV: the WSL agent env is set via bash command-prefix
// (VAR=value ... claude) directly in the tmux command line — the same mechanism
// as the sibling AGENT_ID/DASHBOARD_PORT/DASHBOARD_HOST vars — so it needs no
// WSLENV declaration (WSLENV only matters when crossing the Windows process env
// into WSL, which the query path does, not this launch path). The tests below
// therefore assert the command-prefix carries the vars.

// Capture the extraEnv handed to WindowsRunner.launch for the given lane-flags.
async function captureWindowsExtraEnv(
  id: string, flags: Partial<Agent>,
): Promise<Record<string, string>> {
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
    const agent = makeAgent(id, {
      provider: 'claude',
      command: 'claude --dangerously-skip-permissions',
      workingDirectory: 'C:\\tmp\\ws',
      ...flags,
    });
    agentsMap.set(agent.id, agent);
    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
    return (captured.extraEnv ?? {}) as Record<string, string>;
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
    restoreDb();
  }
}

// ── Windows path: extraEnv carries the credential for every non-legacy lane ──
for (const [laneName, flags] of [
  ['supervisor', SUPERVISOR_FLAGS],
  ['worker', WORKER_FLAGS],
  ['researcher', RESEARCHER_FLAGS],
] as [string, Partial<Agent>][]) {
  test(`PHASE 0 Windows ${laneName} lane: AGENT_DASHBOARD_* injected into agent process env`, async () => {
    const env = await captureWindowsExtraEnv(`win-own-${laneName}`, flags);
    assert.equal(
      env.AGENT_DASHBOARD_API_TOKEN, getApiToken(),
      `${laneName} must inherit the live API token; got: ${JSON.stringify(env)}`,
    );
    assert.match(env.AGENT_DASHBOARD_API_PORT ?? '', /^\d+$/, `${laneName} must get a numeric API port`);
    assert.equal(env.AGENT_DASHBOARD_API_HOST, '127.0.0.1', `${laneName} Windows host must be loopback`);
    assert.equal(
      env.AGENT_DASHBOARD_SELF_ID, `win-own-${laneName}`,
      `${laneName} must get its own id as SELF_ID; got: ${JSON.stringify(env)}`,
    );
  });
}

test('PHASE 0 Windows legacy lane: AGENT_DASHBOARD_* NOT injected (matches no-MCP-token gate)', async () => {
  const env = await captureWindowsExtraEnv('win-own-legacy', LEGACY_FLAGS);
  for (const key of [
    'AGENT_DASHBOARD_API_TOKEN', 'AGENT_DASHBOARD_API_PORT',
    'AGENT_DASHBOARD_API_HOST', 'AGENT_DASHBOARD_SELF_ID',
  ]) {
    assert.ok(!(key in env), `legacy must NOT inject ${key}; got: ${JSON.stringify(env)}`);
  }
});

// ── WSL path: bash command-prefix carries the credential for every non-legacy lane ──
for (const [laneName, flags] of [
  ['supervisor', SUPERVISOR_FLAGS],
  ['worker', WORKER_FLAGS],
  ['researcher', RESEARCHER_FLAGS],
] as [string, Partial<Agent>][]) {
  test(`PHASE 0 WSL ${laneName} lane: AGENT_DASHBOARD_* injected into bash command-prefix`, async () => {
    const cmd = await captureWslLaunch(`wsl-own-${laneName}`, flags);
    assert.match(
      cmd, /AGENT_DASHBOARD_API_TOKEN=/,
      `${laneName} must inject AGENT_DASHBOARD_API_TOKEN=; got: ${cmd}`,
    );
    assert.ok(
      cmd.includes(getApiToken()),
      `${laneName} command-prefix must carry the live token value; got: ${cmd}`,
    );
    assert.match(cmd, /AGENT_DASHBOARD_API_PORT=\d+/, `${laneName} must inject AGENT_DASHBOARD_API_PORT=`);
    assert.match(
      cmd, /AGENT_DASHBOARD_API_HOST=10\.0\.0\.42/,
      `${laneName} WSL host must be the resolved gateway IP; got: ${cmd}`,
    );
    assert.match(
      cmd, new RegExp(`AGENT_DASHBOARD_SELF_ID=wsl-own-${laneName}`),
      `${laneName} must inject its own id as SELF_ID; got: ${cmd}`,
    );
  });
}

test('PHASE 0 WSL legacy lane: AGENT_DASHBOARD_* NOT injected (matches no-MCP-token gate)', async () => {
  const cmd = await captureWslLaunch('wsl-own-legacy', LEGACY_FLAGS);
  assert.ok(!/AGENT_DASHBOARD_API_TOKEN=/.test(cmd), `legacy must NOT inject API token; got: ${cmd}`);
  assert.ok(!/AGENT_DASHBOARD_SELF_ID=/.test(cmd), `legacy must NOT inject SELF_ID; got: ${cmd}`);
});

// ── Context-brick Inc 2 (2.1, ≡ P1-10a) — AGENT_DASHBOARD_SUPERVISOR_ID rides
// the SAME two parent-env sites as WORKSPACE_ID/SELF_ID, but behind an INNER
// agent.isSupervisor guard (D-16): workers/researchers must NOT carry another
// agent's supervisor assertion. The shim's generic CALLER_HEADERS scan forwards
// it as X-Supervisor-Id — no shim change, so these tests pin the env sites. ──

test('Inc 2 Windows supervisor lane: AGENT_DASHBOARD_SUPERVISOR_ID = own agent id', async () => {
  const env = await captureWindowsExtraEnv('win-sup-id', SUPERVISOR_FLAGS);
  assert.equal(
    env.AGENT_DASHBOARD_SUPERVISOR_ID, 'win-sup-id',
    `supervisor must carry its own id as SUPERVISOR_ID; got: ${JSON.stringify(env)}`,
  );
});

for (const [laneName, flags] of [
  ['worker', WORKER_FLAGS],
  ['researcher', RESEARCHER_FLAGS],
  ['legacy', LEGACY_FLAGS],
] as [string, Partial<Agent>][]) {
  test(`Inc 2 Windows ${laneName} lane: AGENT_DASHBOARD_SUPERVISOR_ID NOT injected (D-16)`, async () => {
    const env = await captureWindowsExtraEnv(`win-nosup-${laneName}`, flags);
    assert.ok(
      !('AGENT_DASHBOARD_SUPERVISOR_ID' in env),
      `${laneName} must NOT carry SUPERVISOR_ID; got: ${JSON.stringify(env)}`,
    );
  });
}

test('Inc 2 WSL supervisor lane: command-prefix carries AGENT_DASHBOARD_SUPERVISOR_ID = own id', async () => {
  const cmd = await captureWslLaunch('wsl-sup-id', SUPERVISOR_FLAGS);
  assert.match(
    cmd, /AGENT_DASHBOARD_SUPERVISOR_ID=wsl-sup-id/,
    `supervisor must inject its own id as SUPERVISOR_ID; got: ${cmd}`,
  );
});

for (const [laneName, flags] of [
  ['worker', WORKER_FLAGS],
  ['researcher', RESEARCHER_FLAGS],
  ['legacy', LEGACY_FLAGS],
] as [string, Partial<Agent>][]) {
  test(`Inc 2 WSL ${laneName} lane: AGENT_DASHBOARD_SUPERVISOR_ID NOT injected (D-16)`, async () => {
    const cmd = await captureWslLaunch(`wsl-nosup-${laneName}`, flags);
    assert.ok(
      !/AGENT_DASHBOARD_SUPERVISOR_ID=/.test(cmd),
      `${laneName} must NOT inject SUPERVISOR_ID; got: ${cmd}`,
    );
  });
}

test('Inc 2 D-16: two supervisors launched by ONE AgentSupervisor each keep their OWN id', async () => {
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap);
  const capturedEnvs: Record<string, string>[] = [];
  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string, _command: string, _args: string[], _logPath: string,
    _directSpawn?: boolean, extraEnv?: Record<string, string>,
  ) {
    capturedEnvs.push(extraEnv ?? {});
    (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  try {
    const supervisor = makeSupervisor();
    for (const id of ['sup-alpha', 'sup-beta']) {
      const agent = makeAgent(id, {
        provider: 'claude',
        command: 'claude --dangerously-skip-permissions',
        workingDirectory: 'C:\\tmp\\ws',
        ...SUPERVISOR_FLAGS,
      });
      agentsMap.set(agent.id, agent);
      await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
        .launchWindowsAgent(agent);
    }
    assert.equal(capturedEnvs.length, 2, 'both launches must reach the runner');
    assert.equal(capturedEnvs[0].AGENT_DASHBOARD_SUPERVISOR_ID, 'sup-alpha');
    assert.equal(capturedEnvs[1].AGENT_DASHBOARD_SUPERVISOR_ID, 'sup-beta');
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
    restoreDb();
  }
});

test('PHASE 0 WSL: the injected token is scrubbed by redactMcpToken before any log sink', async () => {
  const cmd = await captureWslLaunch('wsl-own-redact', WORKER_FLAGS);
  const token = getApiToken();
  assert.ok(cmd.includes(token), 'precondition: live command must contain the raw token');
  const redacted = redactMcpToken(cmd, token);
  assert.ok(!redacted.includes(token), `redacted command must not leak the token; got: ${redacted}`);
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
  // Strip DASHBOARD_SPOOL_PATH: when this suite runs inside a dashboard-
  // supervised agent, process.env carries the LIVE workspace's spool path and
  // the script would (correctly) append there instead of exercising the
  // script-relative fallback this test asserts on.
  const scriptEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_ID: 'agent-failure-test',
    DASHBOARD_PORT: '1',
    DASHBOARD_HOST: '127.0.0.1',
    CLAUDE_HOOK_EVENT_NAME: 'Stop',
  };
  delete scriptEnv.DASHBOARD_SPOOL_PATH;
  const result = spawnSync(process.execPath, [destScript], {
    env: scriptEnv,
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
