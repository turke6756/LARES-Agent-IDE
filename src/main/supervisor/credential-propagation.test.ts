// WP0.4 + WP0.5 (plans/cross-workspace-collaboration.md — "Fail-closed capability
// mint" + "Single-token credential propagation") — the single-token credential
// model, exercised over a real AgentSupervisor with the runner stubbed.
//
// Load-bearing properties asserted here:
//   1. EXACTLY ONE mint per normal launch, per restart (relaunch resume=true),
//      and per fork; ZERO for a legacy, non-team agent.
//   2. For a WORKER launch, the child-env AGENT_DASHBOARD_API_TOKEN, the dashboard
//      `--mcp-config`, and the team `--mcp-config` all carry the SAME minted worker
//      token — never getApiToken(). That token resolve()s to {worker, own}.
//   3. A fork's override MCP config and its forked child env carry ONE identical
//      token.
//   4. A supervisor launch's threaded token resolve()s to {supervisor}.
//   5. Fail-closed: when agentCapabilities.mint throws, mintAgentCapabilityToken
//      throws `capability-mint-failed` (never returns getApiToken()) and the launch
//      aborts — no sidecar/env ever receives the global bearer.
//   6. redactSecrets scrubs BOTH the per-agent token and the global bearer.
//
// The "raw HTTP with a worker credential → 403 on foreign list_agents/revive/
// target routes" assertion from the plan's WP0-tests bullet is deferred to WP1–WP3
// (those routes do not exist at WP0). Its precondition — that a worker's propagated
// credential resolves to a WORKER claim (not the admin global bearer) — IS asserted
// here (property 2); the 403 behavior of that claim is covered by
// cross-workspace-policy.test.ts against the WP0 authorizers.
//
//   npm run build:main
//   node dist/main/main/supervisor/credential-propagation.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { agentCapabilities } from '../security/agent-capabilities';
import { getApiToken } from '../security/api-auth';
import type { Agent } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── captured launch state ─────────────────────────────────────────────────────

interface CapturedLaunch {
  args: string[];
  env: Record<string, string> | undefined;
}
let lastLaunch: CapturedLaunch | null = null;

function patchRunner(): () => void {
  const orig = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _cwd: string, _cmd: string, args: string[], _log: string, _direct: boolean,
    extraEnv?: Record<string, string>,
  ) {
    lastLaunch = { args, env: extraEnv };
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  return () => { (WindowsRunner.prototype as { launch: unknown }).launch = orig; };
}

// ── DB patch (launch-cwd.test.ts shape; teamMembership is per-test configurable) ──

let teamMembership: { teamId: string } | null = null;

function patchDb(workspacePath: string, created: Agent[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'applyStatusTransition', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getAgentTemplate', 'getFileActivities', 'insertAgentSession',
    'getCurrentBrick', 'getContinuationAttempt', 'incrementRestartCount',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.getWorkspace = (id: string) => ({ id, path: workspacePath, defaultCommand: 'claude' });
  db.createAgent = (input: Partial<Agent>) => {
    const a = makeAgent(`fork-${created.length}`, input);
    created.push(a);
    return a;
  };
  db.updateAgentStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => created.find(a => a.id === id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => created;
  db.getAllAgents = () => created;
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => teamMembership;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];
  db.insertAgentSession = () => {};
  db.getCurrentBrick = () => null;
  db.getContinuationAttempt = () => null;
  db.incrementRestartCount = () => {};
  patchApplyStatusTransition(db);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

// ── supervisor with heavy side effects neutralized (real MCP builders + mint) ──

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
  return s;
}

// ── mint spy ──────────────────────────────────────────────────────────────────

function spyMint(): { restore(): void; count(): number } {
  const orig = agentCapabilities.mint.bind(agentCapabilities);
  let n = 0;
  (agentCapabilities as unknown as { mint: unknown }).mint = (claim: unknown) => {
    n++;
    return orig(claim as never);
  };
  return { restore: () => { (agentCapabilities as unknown as { mint: unknown }).mint = orig; }, count: () => n };
}

function throwingMint(): () => void {
  const orig = agentCapabilities.mint.bind(agentCapabilities);
  (agentCapabilities as unknown as { mint: unknown }).mint = () => { throw new Error('boom: store unavailable'); };
  return () => { (agentCapabilities as unknown as { mint: unknown }).mint = orig; };
}

// ── token extraction from captured args / env ──────────────────────────────────

/** Pull the AGENT_DASHBOARD_API_TOKEN out of each inline --mcp-config JSON. */
function mcpTokens(args: string[]): { dashboard?: string; team?: string } {
  const out: { dashboard?: string; team?: string } = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--mcp-config') continue;
    let cfg: any;
    try { cfg = JSON.parse(args[i + 1]); } catch { continue; }
    const dash = cfg?.mcpServers?.['agent-dashboard']?.env?.AGENT_DASHBOARD_API_TOKEN;
    const team = cfg?.mcpServers?.['agent-dashboard-team']?.env?.AGENT_DASHBOARD_API_TOKEN;
    if (dash) out.dashboard = dash;
    if (team) out.team = team;
  }
  return out;
}

async function withHarness(
  fn: (deps: { supervisor: AgentSupervisor; created: Agent[]; workspacePath: string }) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-prop-'));
  const created: Agent[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunner = patchRunner();
  agentCapabilities.clear();
  lastLaunch = null;
  teamMembership = null;
  try {
    await fn({ supervisor: makeSupervisor(), created, workspacePath });
  } finally {
    restoreRunner();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

/** A Windows-path worker (isWorker only → 'worker' lane, and NO add-dir/sysprompt
 *  branch, which fires only for supervisor/supervised/researcher). */
function workerAgent(workspacePath: string, over: Partial<Agent> = {}): Agent {
  return makeAgent('worker-1', {
    provider: 'claude',
    isWorker: true,
    isSupervised: false,
    workspaceId: 'ws-own',
    workingDirectory: path.join(workspacePath, 'sub'),
    logPath: path.join(workspacePath, 'a.log'),
    resumeSessionId: 'sess-worker',
    ...over,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function launchWin(s: AgentSupervisor, agent: Agent, resume: boolean): Promise<void> {
  return (s as unknown as {
    launchWindowsAgent(a: Agent, resume: boolean, md: string | null, sid?: string, over?: string[], fresh?: boolean): Promise<void>;
  }).launchWindowsAgent(agent, resume, null, resume ? undefined : 'sess-fresh', undefined, !resume);
}

// ── 1. exactly-one-mint counts ────────────────────────────────────────────────

test('WP0.5: a normal worker launch mints EXACTLY ONCE', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const agent = workerAgent(workspacePath);
  created.push(agent);
  const mint = spyMint();
  try {
    await launchWin(supervisor, agent, false);
    assert.equal(mint.count(), 1, 'one launch → one mint');
  } finally { mint.restore(); }
}));

test('WP0.5: a restart (relaunch resume=true) mints EXACTLY ONCE', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const agent = workerAgent(workspacePath);
  created.push(agent);
  const mint = spyMint();
  try {
    await launchWin(supervisor, agent, true);   // resume path (jsonl absent → fresh fallback, still one mint)
    assert.equal(mint.count(), 1, 'one relaunch → one mint');
  } finally { mint.restore(); }
}));

test('WP0.5: a legacy, non-team agent mints ZERO times and gets no token in env', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const legacy = makeAgent('legacy-1', {
    provider: 'claude', isWorker: false, isSupervised: false, isSupervisor: false, isResearcher: false,
    workingDirectory: path.join(workspacePath, 'sub'), logPath: path.join(workspacePath, 'l.log'),
  });
  created.push(legacy);
  const mint = spyMint();
  try {
    await launchWin(supervisor, legacy, false);
    assert.equal(mint.count(), 0, 'legacy non-team → no mint');
    assert.ok(!lastLaunch?.env || lastLaunch.env.AGENT_DASHBOARD_API_TOKEN === undefined,
      'legacy child env carries no dashboard credential');
    assert.equal(mcpTokens(lastLaunch!.args).dashboard, undefined, 'legacy gets no dashboard --mcp-config token');
  } finally { mint.restore(); }
}));

// ── 2. token equality across env + dashboard + team, never the global bearer ──

test('WP0.5: worker child-env, dashboard MCP, and team MCP carry the SAME minted worker token (never the global bearer)', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  teamMembership = { teamId: 'team-9' };
  const agent = workerAgent(workspacePath);
  created.push(agent);
  await launchWin(supervisor, agent, false);

  const envToken = lastLaunch!.env!.AGENT_DASHBOARD_API_TOKEN;
  const { dashboard, team } = mcpTokens(lastLaunch!.args);
  assert.ok(envToken, 'child env carries a token');
  assert.ok(dashboard, 'dashboard --mcp-config carries a token');
  assert.ok(team, 'team --mcp-config carries a token');
  assert.equal(dashboard, envToken, 'dashboard token == child-env token');
  assert.equal(team, envToken, 'team token == child-env token (one single token)');
  assert.notEqual(envToken, getApiToken(), 'the token is NEVER the shared global bearer');

  const resolved = agentCapabilities.resolve(envToken);
  assert.deepEqual(resolved, { agentId: agent.id, workspaceId: 'ws-own', privilegeLane: 'worker' },
    'the propagated token resolves to a WORKER claim scoped to its own workspace');
}));

// ── 3. fork: one identical token across override MCP config + forked child env ──

test('WP0.5: fork mints once; its override MCP config and forked child env carry one identical token', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const source = makeAgent('src-1', {
    provider: 'claude', isWorker: true, isSupervised: false,
    workspaceId: 'ws-own',
    workingDirectory: path.join(workspacePath, 'sub'),
    logPath: path.join(workspacePath, 's.log'),
    resumeSessionId: 'sess-src',
    status: 'idle',
  });
  created.push(source);
  const mint = spyMint();
  try {
    await supervisor.forkAgent('src-1');
    assert.equal(mint.count(), 1, 'fork → exactly one mint (threaded, not re-minted in the launch method)');
  } finally { mint.restore(); }

  const envToken = lastLaunch!.env!.AGENT_DASHBOARD_API_TOKEN;
  const { dashboard } = mcpTokens(lastLaunch!.args);
  assert.ok(envToken && dashboard, 'both fork sinks carry a token');
  assert.equal(dashboard, envToken, 'fork override MCP config token == forked child-env token');
  assert.notEqual(envToken, getApiToken(), 'a fork never carries the global bearer');
}));

// ── 4. supervisor launch → supervisor claim ───────────────────────────────────

test('WP0.5: a supervisor launch threads a token that resolves to a SUPERVISOR claim', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const sup = makeAgent('sup-1', {
    provider: 'claude', isSupervisor: true, isSupervised: false,
    workspaceId: 'ws-own',
    workingDirectory: path.join(workspacePath, 'sup'),
    logPath: path.join(workspacePath, 'sup.log'),
    resumeSessionId: 'sess-sup',
  });
  created.push(sup);
  await launchWin(supervisor, sup, false);
  const token = lastLaunch!.env!.AGENT_DASHBOARD_API_TOKEN;
  assert.equal(agentCapabilities.resolve(token)?.privilegeLane, 'supervisor');
}));

// ── 5. fail-closed mint ───────────────────────────────────────────────────────

test('WP0.4: when mint throws, mintAgentCapabilityToken FAILS CLOSED (never returns the global bearer)', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const agent = workerAgent(workspacePath);
  created.push(agent);
  const restore = throwingMint();
  try {
    assert.throws(
      () => (supervisor as unknown as { mintAgentCapabilityToken(a: Agent): string }).mintAgentCapabilityToken(agent),
      (err: any) => {
        assert.equal(err.code, 'capability-mint-failed');
        assert.ok(!String(err.message).includes(getApiToken()), 'error never carries the bearer');
        return true;
      },
    );
  } finally { restore(); }
}));

test('WP0.4/0.5: a mint failure aborts the launch — no runner.launch, no bearer in any sink', () => withHarness(async ({ supervisor, created, workspacePath }) => {
  const agent = workerAgent(workspacePath);
  created.push(agent);
  const restore = throwingMint();
  try {
    await assert.rejects(launchWin(supervisor, agent, false), /capability mint failed/);
    assert.equal(lastLaunch, null, 'the launch never reached runner.launch');
  } finally { restore(); }
}));

// ── 6. redaction ──────────────────────────────────────────────────────────────

test('WP0.5: redactSecrets scrubs BOTH the per-agent token and the global bearer', () => withHarness(async ({ supervisor }) => {
  const capToken = agentCapabilities.mint({ agentId: 'r-1', workspaceId: 'ws-own', privilegeLane: 'worker' });
  const bearer = getApiToken();
  const line = `AGENT_DASHBOARD_API_TOKEN=${capToken} claude --mcp-config '{"x":"${bearer}"}'`;
  const redacted = (supervisor as unknown as { redactSecrets(s: string, t?: string): string }).redactSecrets(line, capToken);
  assert.ok(!redacted.includes(capToken), 'the per-agent token is gone');
  assert.ok(!redacted.includes(bearer), 'the global bearer is gone');
  assert.ok(redacted.includes('***'), 'a redaction placeholder is present');
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
