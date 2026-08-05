// P1 multi-transport matrix tests (plans/p1-hook-spool-multi-transport.md §5
// E5/E6 + the §5 E4 restart-shaped tmux end-to-end).
//
// Cells: Claude×Windows, Codex×Windows, Claude×WSL, Codex×WSL, Grok×Windows,
// and Agy×Windows. Grok and agy are Windows-only and are refused on WSL.
// Each applicable cell asserts:
//   (i)   launch injects DASHBOARD_SPOOL_PATH in the right form for the
//         pathType (WSL form shell-quoted);
//   (ii)  a spool-delivered event (HTTP silent) flips status with source
//         'hook-spool';
//   (iii) inferStatus returns null for the worker throughout;
//   (iv)  WSL cells: the tmux-option poll applies when HTTP+spool are silent.
//
// Plus:
//   - restart-shaped tmux end-to-end: empty registries, live WSL agent, fake
//     tmuxReadStatusOptions returns an OLD valid record → rejected, no stamp,
//     no flip;
//   - custom-Codex hookless guard: an un-instrumentable worker-lane codex
//     command must surface hook_status='degraded' (existing vocabulary) — the
//     test fails if the lane is silently hookless.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/multi-transport-matrix.test.js

import assert from 'node:assert/strict';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import type { ParsedHookEvent } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { windowsToWslPath } from '../path-utils';
import { WORKING_THRESHOLD_MS } from '../../shared/constants';
import { encodeAgyWindowsBody, getWindowsSubmitSequence } from './send-input-encoders';
import type { Agent, AgentStatus, LaunchAgentInput, Workspace } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── DB patching (mirrors agent-supervisor.test.ts, plus getWorkspace) ──

interface AuditRow { agentId: string; type: string; payload: string }

function patchDb(agentsMap: Map<string, Agent>, audit: AuditRow[], workspace?: Workspace): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus', 'updateAgentPid', 'getAgent',
    'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity',
    'updateAgentResumeSessionId', 'getWorkspace', 'createAgent',
    'getTeamMembership', 'getAgentTemplate',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id); if (a) a.status = status;
  };
  db.updateAgentHookStatus = (id: string, hookStatus: NonNullable<Agent['hookStatus']>, lastHookEventAt?: number) => {
    const a = agentsMap.get(id);
    if (a) { a.hookStatus = hookStatus; if (lastHookEventAt !== undefined) a.lastHookEventAt = lastHookEventAt; }
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = (id: string, type: string, payload?: string | null) => {
    audit.push({ agentId: id, type, payload: payload ?? '' });
  };
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getWorkspace = () => workspace;
  db.createAgent = (input: Record<string, unknown>) => {
    const id = `gen-${agentsMap.size + 1}`;
    const agent = makeAgent(id, input as Partial<Agent>);
    agentsMap.set(id, agent);
    return agent;
  };
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;

  // §B3 — status writes route through applyStatusTransition; keep them in the fake.
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

function stubRunnerLaunches(): {
  winEnvs: Array<Record<string, string> | undefined>;
  winCommands: Array<{ command: string; args: string[] }>;
  winWrites: string[];
  wslCommands: string[];
  restore: () => void;
} {
  const winEnvs: Array<Record<string, string> | undefined> = [];
  const winCommands: Array<{ command: string; args: string[] }> = [];
  const winWrites: string[] = [];
  const wslCommands: string[] = [];
  const origWin = (WindowsRunner.prototype as { launch: unknown }).launch;
  const origWrite = (WindowsRunner.prototype as { write: unknown }).write;
  const origWsl = (WslRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string, command: string, args: string[], _logPath: string,
    _directSpawn?: boolean, extraEnv?: Record<string, string>,
  ) {
    winEnvs.push(extraEnv);
    winCommands.push({ command, args });
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  (WindowsRunner.prototype as { write: unknown }).write = function (data: string) {
    winWrites.push(data);
  };
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner, _workDir: string, command: string,
  ) {
    wslCommands.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };
  return {
    winEnvs,
    winCommands,
    winWrites,
    wslCommands,
    restore: () => {
      (WindowsRunner.prototype as { launch: unknown }).launch = origWin;
      (WindowsRunner.prototype as { write: unknown }).write = origWrite;
      (WslRunner.prototype as { launch: unknown }).launch = origWsl;
    },
  };
}

/** Stop codex session-id discovery from scanning the real ~/.codex. */
function stubCodexDiscovery(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const disc = require('./session-id-discovery') as Record<string, unknown>;
  const orig = disc.shouldDiscoverCodexSession;
  disc.shouldDiscoverCodexSession = () => false;
  return () => { disc.shouldDiscoverCodexSession = orig; };
}

/** Non-Codex provider variant of the discovery stub: instead of forcing the gate false,
 *  DELEGATE to the REAL shouldDiscoverCodexSession (which returns false for any
 *  non-codex provider) while recording (a) every provider the gate was consulted
 *  for and (b) any snapshotCodexSessions call. This is how the grok cell proves
 *  "no codex session-discovery path runs for grok": the gate is consulted and
 *  the REAL predicate declines grok, so snapshotCodexSessions (the ~/.codex scan)
 *  is never entered. A snapshot spy that throws would also work, but recording
 *  lets the assertion message show what actually happened. */
function spyCodexDiscovery(): { discoverProviders: string[]; snapshotCalls: string[]; restore: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const disc = require('./session-id-discovery') as Record<string, unknown>;
  const origShould = disc.shouldDiscoverCodexSession as (o: { provider: string }) => boolean;
  const origSnap = disc.snapshotCodexSessions as (home: string) => Promise<unknown>;
  const discoverProviders: string[] = [];
  const snapshotCalls: string[] = [];
  disc.shouldDiscoverCodexSession = (o: { provider: string }) => {
    discoverProviders.push(o.provider);
    return origShould(o); // REAL gate — false for grok (non-codex)
  };
  disc.snapshotCodexSessions = async (home: string) => {
    snapshotCalls.push(home);
    return origSnap(home);
  };
  return {
    discoverProviders,
    snapshotCalls,
    restore: () => { disc.shouldDiscoverCodexSession = origShould; disc.snapshotCodexSessions = origSnap; },
  };
}

function makeSupervisor(): AgentSupervisor {
  const s = new AgentSupervisor();
  (s as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  (s as unknown as { resolveWslGatewayIp: () => string }).resolveWslGatewayIp = () => '10.0.0.42';
  return s;
}

function spoolRecord(agentId: string, state: 'idle' | 'working' | 'active', ts: number, turnId: string): string {
  const source = state === 'working' ? 'hook-start' : state === 'active' ? 'hook-session-start' : 'hook-stop';
  const hookEventName = state === 'working' ? 'UserPromptSubmit' : state === 'active' ? 'SessionStart' : 'Stop';
  return JSON.stringify({ v: 1, agentId, state, source, ts, hookEventName, turnId }) + '\n';
}

function statusChanges(audit: AuditRow[]): Array<{ from: string; to: string; source: string }> {
  return audit.filter((r) => r.type === 'status_change').map((r) => JSON.parse(r.payload));
}

// ── Provider/transport matrix cells ───────────────────────────────────

interface CellOpts {
  provider: 'claude' | 'codex' | 'grok' | 'agy';
  pathType: 'windows' | 'wsl';
}

async function runCell(opts: CellOpts): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ad-matrix-${opts.provider}-${opts.pathType}-`));
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const runners = stubRunnerLaunches();
  const isGrok = opts.provider === 'grok';
  const isAgy = opts.provider === 'agy';
  const isWindowsOnlyProvider = isGrok || isAgy;
  // Grok cells use the recording spy (delegates to the REAL gate) so we can
  // assert the codex discovery scan is never entered; the other lanes keep the
  // hard false-stub that suppresses the real ~/.codex scan for codex cells.
  const windowsOnlyDiscovery = isWindowsOnlyProvider ? spyCodexDiscovery() : null;
  const restoreDiscovery = isWindowsOnlyProvider ? windowsOnlyDiscovery!.restore : stubCodexDiscovery();
  // Isolate grok's trust store: ensureGrokTrust honors $GROK_HOME, so point it at
  // a throwaway dir under tmp. The real ~/.grok must never be touched.
  const prevGrokHome = process.env.GROK_HOME;
  if (isGrok) process.env.GROK_HOME = path.join(tmp, '.grok-home');
  // Keep the grok cell hermetic: the native-Windows launch resolves the provider
  // binary to an absolute path and throws if absent. grok.exe need not be
  // installed on the test box, so stub the resolver to a fake path (the runner
  // launch itself is already stubbed and never execs it).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolver = require('./provider-resolver') as Record<string, unknown>;
  const origFindBinary = resolver.findWindowsProviderBinary;
  if (isGrok) resolver.findWindowsProviderBinary = async () => 'C:\\Users\\test\\.grok\\bin\\grok.exe';
  if (isAgy) resolver.findWindowsProviderBinary = async () => 'C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bridge = require('../wsl-bridge') as Record<string, unknown>;
  const origTmuxRead = bridge.tmuxReadStatusOptions;
  try {
    const isWsl = opts.pathType === 'wsl';
    // WSL cells use the /mnt/c form of the SAME temp dir so the UNC/Windows
    // mapping resolves without a wsl.exe round-trip and the tailer reads the
    // real file.
    const root = isWsl ? windowsToWslPath(tmp) : tmp;
    const cwd = isWsl
      ? `${root}/.lares/workers/${opts.provider}`
      : path.join(tmp, '.lares', 'workers', opts.provider);
    const agent = makeAgent(`m-${opts.provider}-${opts.pathType}`, {
      provider: opts.provider,
      isSupervised: false,
      isWorker: true,
      workspaceId: 'ws-matrix',
      planId: 'plan-matrix',
      planSection: 'section-matrix',
      status: 'idle',
      command: opts.provider,
      workingDirectory: cwd,
      tmuxSessionName: isWsl ? `cad__m_${opts.provider}` : null,
    });
    agentsMap.set(agent.id, agent);

    const supervisor = makeSupervisor();
    if (isWsl) {
      await (supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> }).launchWslAgent(agent);
    } else {
      await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> }).launchWindowsAgent(agent);
    }

    // (i) DASHBOARD_SPOOL_PATH injected in the right form for the pathType.
    if (isWsl) {
      assert.equal(runners.wslCommands.length, 1);
      const cmd = runners.wslCommands[0];
      const expected = `DASHBOARD_SPOOL_PATH='${root}/.lares/pending-status.jsonl'`;
      assert.ok(cmd.includes(expected),
        `WSL launch must inject the shell-quoted WSL-native spool path; expected ${expected} in: ${cmd}`);
      assert.ok(cmd.includes('AGENT_DASHBOARD_API_TOKEN='),
        `${opts.provider} WSL launch must inject the dashboard capability token`);
      assert.ok(cmd.includes('AGENT_DASHBOARD_API_PORT='));
      assert.ok(cmd.includes('AGENT_DASHBOARD_API_HOST=10.0.0.42'));
      assert.ok(cmd.includes(`AGENT_DASHBOARD_SELF_ID=${agent.id}`));
      assert.ok(cmd.includes('AGENT_DASHBOARD_WORKSPACE_ID=\'ws-matrix\''));
      assert.ok(cmd.includes('AGENT_DASHBOARD_PLAN_ID=\'plan-matrix\''));
      assert.ok(cmd.includes('AGENT_DASHBOARD_PLAN_SECTION=\'section-matrix\''));
    } else {
      assert.equal(runners.winEnvs.length, 1);
      const env = runners.winEnvs[0]!;
      assert.equal(env.DASHBOARD_SPOOL_PATH, path.join(tmp, '.lares', 'pending-status.jsonl'),
        'Windows launch must inject the native spool path in extraEnv');
      assert.ok(env.AGENT_DASHBOARD_API_TOKEN,
        `${opts.provider} Windows launch must inject the dashboard capability token`);
      assert.equal(env.AGENT_DASHBOARD_API_PORT,
        String((supervisor as unknown as { apiServerPort: number }).apiServerPort));
      assert.equal(env.AGENT_DASHBOARD_API_HOST, '127.0.0.1');
      assert.equal(env.AGENT_DASHBOARD_SELF_ID, agent.id);
      assert.equal(env.AGENT_DASHBOARD_WORKSPACE_ID, 'ws-matrix');
      assert.equal(env.AGENT_DASHBOARD_PLAN_ID, 'plan-matrix');
      assert.equal(env.AGENT_DASHBOARD_PLAN_SECTION, 'section-matrix');
      assert.equal(env.AGENT_DASHBOARD_SUPERVISOR_ID, undefined,
        'worker lanes must not receive a supervisor identity assertion');
      assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, opts.provider === 'claude' ? 'false' : undefined,
        'the Claude-only prompt-suggestion flag must not leak to other providers');
    }

    if (isGrok) {
      assert.deepEqual(runners.winCommands, [{
        command: 'C:\\Users\\test\\.grok\\bin\\grok.exe',
        args: ['--always-approve'],
      }], 'grok Windows launch resolves the absolute installer binary with its auto-approve flag');
    }

    if (isAgy) {
      assert.deepEqual(runners.winCommands, [{
        command: 'C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe',
        args: ['--dangerously-skip-permissions'],
      }], 'agy Windows launch resolves the absolute installer binary with its auto-approve flag');

      const monitor = (supervisor as unknown as {
        monitor: { isHookCanaryArmed: (id: string) => boolean; inferStatus: (a: Agent) => Promise<string | null> };
      }).monitor;
      const winRunner = (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> }).windowsRunners.get(agent.id)!;
      (winRunner as unknown as { _lastRawOutputTime: number })._lastRawOutputTime = Date.now();
      assert.equal(await monitor.inferStatus(agent), null, 'PTY activity alone never promotes an idle agy worker');

      const body = 'line one\r\nline two\rline three';
      const delivered = await (supervisor as unknown as {
        _doSendInput: (id: string, text: string, submit: boolean) => Promise<boolean>;
      })._doSendInput(agent.id, body, true);
      assert.equal(delivered, true);
      assert.deepEqual(runners.winWrites, [encodeAgyWindowsBody(body), getWindowsSubmitSequence('agy')]);
      assert.deepEqual(runners.winWrites.map((s) => Buffer.from(s, 'utf-8')), [
        Buffer.from('line one\nline two\nline three', 'utf-8'),
        Buffer.from([0x0d]),
      ], 'agy body uses LF newlines and exactly one final CR submit byte');
      assert.equal(monitor.isHookCanaryArmed(agent.id), true,
        'agy hook canary arms at submitted-input time, never merely at launch');
    }

    const spoolFile = path.join(tmp, '.lares', 'pending-status.jsonl');
    fs.mkdirSync(path.dirname(spoolFile), { recursive: true });

    // (iv) — first, while NO hook event exists on any transport (HTTP+spool
    // silent): the tmux-option backstop applies. WSL cells only.
    if (isWsl) {
      const tmuxTs = Date.now();
      (bridge as { tmuxReadStatusOptions: unknown }).tmuxReadStatusOptions =
        async (sessions: string[]) => {
          const m = new Map<string, string>();
          for (const s of sessions) {
            m.set(s, JSON.stringify({
              v: 1, agentId: agent.id, state: 'idle', source: 'hook-stop',
              ts: tmuxTs, hookEventName: 'Stop', turnId: 'tmux-1',
            }) + '\n');
          }
          return m;
        };
      agent.status = 'working';
      await (supervisor as unknown as { pollTmuxStatusOptions: () => Promise<void> }).pollTmuxStatusOptions();
      assert.equal(agent.status, 'idle', 'tmux-option backstop must flip the worker when HTTP+spool are silent');
      const tmuxFlips = statusChanges(audit).filter((c) => c.source === 'tmux-pane-option');
      assert.equal(tmuxFlips.length, 1, `expected one tmux-pane-option flip; got ${JSON.stringify(statusChanges(audit))}`);
      assert.equal(agent.hookStatus, 'healthy', 'applied tmux event stamps hook health');
    }

    // (ii) spool-delivered event (HTTP silent) flips status with source
    // 'hook-spool'. ts is set safely past any prior applied event.
    agent.status = isAgy ? 'idle' : 'working';
    const record = isAgy
      ? JSON.stringify({
        v: 1, agentId: agent.id, state: 'working', source: 'hook-start',
        ts: Date.now() + 60_000, hookEventName: 'PreInvocation', turnId: 'spool-1',
      }) + '\n'
      : spoolRecord(agent.id, 'idle', Date.now() + 60_000, 'spool-1');
    fs.appendFileSync(spoolFile, record);
    (supervisor as unknown as { pollHookTransports: () => void }).pollHookTransports();
    assert.equal(agent.status, isAgy ? 'working' : 'idle',
      isAgy ? 'spool-delivered PreInvocation must flip agy to working' : 'spool-delivered Stop must flip the worker to idle');
    const spoolFlips = statusChanges(audit).filter((c) => c.source === 'hook-spool');
    assert.equal(spoolFlips.length, 1, `expected one hook-spool flip; got ${JSON.stringify(statusChanges(audit))}`);
    assert.equal(agent.hookStatus, 'healthy', 'applied spool event stamps hook health');

    // (iii) inferStatus returns null for the worker throughout.
    if (isWsl) {
      const wslRunner = (supervisor as unknown as { wslRunners: Map<string, WslRunner> }).wslRunners.get(agent.id)!;
      (wslRunner as unknown as { isStillAlive: () => Promise<boolean> }).isStillAlive = async () => true;
    }
    const monitor = (supervisor as unknown as {
      monitor: {
        inferStatus: (a: Agent) => Promise<string | null>;
        recordHookEventAt: (agentId: string, ts: number) => void;
      };
    }).monitor;
    if (isAgy) {
      const winRunner = (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> }).windowsRunners.get(agent.id)!;
      const stale = Date.now() - WORKING_THRESHOLD_MS - 1;
      monitor.recordHookEventAt(agent.id, stale);
      (winRunner as unknown as { _lastRawOutputTime: number })._lastRawOutputTime = stale;
      assert.equal(await monitor.inferStatus(agent), 'idle',
        'agy demotes an already-working turn only after PreInvocation and raw PTY are both quiet for 8s');
    } else {
      assert.equal(await monitor.inferStatus(agent), null,
        'worker-lane PTY inference must stay disabled (hook-owned status)');
    }

    // (v) grok/agy only: NO codex session-discovery path runs. The launch consults
    // the discovery gate (shouldDiscoverCodexSession), but the REAL predicate
    // declines any non-codex provider, so the ~/.codex snapshot scan
    // (snapshotCodexSessions) is never entered. grok is deliberately
    // non-session-addressable — no cwd rollout scan, no ~/.codex touch.
    if (isWindowsOnlyProvider) {
      assert.ok(windowsOnlyDiscovery!.discoverProviders.includes(opts.provider),
        `the launch must consult the discovery gate for the ${opts.provider} agent`);
      assert.ok(windowsOnlyDiscovery!.discoverProviders.every((p) => p !== 'codex'),
        `no codex-provider discovery gate call in a ${opts.provider} launch; got: ${windowsOnlyDiscovery!.discoverProviders.join(',')}`);
      assert.equal(windowsOnlyDiscovery!.snapshotCalls.length, 0,
        `${opts.provider} must never enter the codex ~/.codex snapshot scan; got ${windowsOnlyDiscovery!.snapshotCalls.length} call(s)`);
    }
  } finally {
    bridge.tmuxReadStatusOptions = origTmuxRead;
    restoreDiscovery();
    resolver.findWindowsProviderBinary = origFindBinary;
    runners.restore();
    restoreDb();
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('matrix cell: Claude × Windows', () => runCell({ provider: 'claude', pathType: 'windows' }));
test('matrix cell: Codex × Windows', () => runCell({ provider: 'codex', pathType: 'windows' }));
test('matrix cell: Claude × WSL', () => runCell({ provider: 'claude', pathType: 'wsl' }));
test('matrix cell: Codex × WSL', () => runCell({ provider: 'codex', pathType: 'wsl' }));
// Grok is Windows-only (grok-on-WSL is refused at launch — see Phase 1.6/4.1).
// The cell asserts (i) native DASHBOARD_SPOOL_PATH, (ii) a spool Stop flips with
// source 'hook-spool', (iii) worker PTY inference stays disabled, (iv) hook
// health becomes healthy after the applied event, and (v) no codex
// session-discovery path runs for grok.
test('matrix cell: Grok × Windows', () => runCell({ provider: 'grok', pathType: 'windows' }));
test('matrix cell: Antigravity × Windows', () => runCell({ provider: 'agy', pathType: 'windows' }));

test('grok supervisor-peer receives the full dashboard credential and identity env without Claude CLI flags', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-matrix-grok-supervisor-'));
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const runners = stubRunnerLaunches();
  const prevGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = path.join(tmp, '.grok-home');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolver = require('./provider-resolver') as Record<string, unknown>;
  const origFindBinary = resolver.findWindowsProviderBinary;
  resolver.findWindowsProviderBinary = async () => 'C:\\Users\\test\\.grok\\bin\\grok.exe';
  try {
    const cwd = path.join(tmp, '.lares', 'supervisor');
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent('m-grok-supervisor', {
      provider: 'grok',
      isSupervisor: true,
      isSupervised: false,
      isWorker: false,
      workspaceId: 'ws-peer',
      planId: 'plan-peer',
      planSection: 'section-peer',
      command: 'grok',
      workingDirectory: cwd,
    });
    agentsMap.set(agent.id, agent);

    const supervisor = makeSupervisor();
    await (supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);

    assert.equal(runners.winEnvs.length, 1);
    const env = runners.winEnvs[0]!;
    assert.ok(env.AGENT_DASHBOARD_API_TOKEN, 'supervisor-peer must receive its capability token');
    assert.equal(env.AGENT_DASHBOARD_API_PORT,
      String((supervisor as unknown as { apiServerPort: number }).apiServerPort));
    assert.equal(env.AGENT_DASHBOARD_API_HOST, '127.0.0.1');
    assert.equal(env.AGENT_DASHBOARD_SELF_ID, agent.id);
    assert.equal(env.AGENT_DASHBOARD_WORKSPACE_ID, 'ws-peer');
    assert.equal(env.AGENT_DASHBOARD_SUPERVISOR_ID, agent.id);
    assert.equal(env.AGENT_DASHBOARD_PLAN_ID, 'plan-peer');
    assert.equal(env.AGENT_DASHBOARD_PLAN_SECTION, 'section-peer');
    assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, undefined);
    assert.deepEqual(runners.winCommands, [{
      command: 'C:\\Users\\test\\.grok\\bin\\grok.exe',
      args: ['--always-approve'],
    }], 'Grok receives only its own auto-approve flag, never Claude-only launch flags');
  } finally {
    resolver.findWindowsProviderBinary = origFindBinary;
    runners.restore();
    restoreDb();
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('matrix boundary: Antigravity × WSL is refused with the Windows-only teaching message', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-matrix-agy-wsl-refusal-'));
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const runners = stubRunnerLaunches();
  try {
    const agent = makeAgent('m-agy-wsl-refused', {
      provider: 'agy', isWorker: true, status: 'launching', command: 'agy',
      workingDirectory: '/home/u/repo/.lares/workers/agy', tmuxSessionName: 'cad__agy_refused',
    });
    agentsMap.set(agent.id, agent);
    const supervisor = makeSupervisor();
    await assert.rejects(
      () => (supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> }).launchWslAgent(agent),
      /Antigravity CLI is not yet supported in WSL workspaces\. Re-create the workspace as a Windows path type/,
    );
    assert.equal(agent.status, 'crashed');
    assert.equal(runners.wslCommands.length, 0, 'WSL refusal happens before any tmux/provider launch');
  } finally {
    runners.restore();
    restoreDb();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Restart-shaped tmux end-to-end (plan §5 E4, third bullet) ──────────

test('restart-shaped: empty registries + live WSL agent + OLD tmux option → rejected, no stamp, no flip', async () => {
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bridge = require('../wsl-bridge') as Record<string, unknown>;
  const origTmuxRead = bridge.tmuxReadStatusOptions;
  try {
    const agent = makeAgent('rs-1', {
      provider: 'claude', isWorker: true, isSupervised: false, status: 'working',
      workingDirectory: '/home/u/proj/.lares/workers/claude',
      tmuxSessionName: 'cad__rs_1',
    });
    agentsMap.set(agent.id, agent);

    // A FRESH supervisor: dedupe registry, ordering watermark, and launch
    // stamps are all empty — exactly the post-restart shape. The agent is
    // "reconnected": a live runner exists but launchStartedAt was never
    // stamped this process.
    const supervisor = makeSupervisor();
    const fakeRunner = new WslRunner(agent.tmuxSessionName!);
    Object.defineProperty(fakeRunner, 'isAlive', { get: () => true, configurable: true });
    (supervisor as unknown as { wslRunners: Map<string, WslRunner> }).wslRunners.set(agent.id, fakeRunner);

    // The pane option survived tmux-side across the restart: a valid record,
    // 11 minutes old.
    (bridge as { tmuxReadStatusOptions: unknown }).tmuxReadStatusOptions = async (sessions: string[]) => {
      const m = new Map<string, string>();
      for (const s of sessions) {
        m.set(s, JSON.stringify({
          v: 1, agentId: agent.id, state: 'idle', source: 'hook-stop',
          ts: Date.now() - 11 * 60_000, hookEventName: 'Stop', turnId: 'pre-restart',
        }) + '\n');
      }
      return m;
    };

    await (supervisor as unknown as { pollTmuxStatusOptions: () => Promise<void> }).pollTmuxStatusOptions();

    assert.equal(agent.status, 'working', 'the stale pre-restart option must NOT flip status');
    assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'no hook-health stamp from a stale option');
    assert.equal(agent.lastHookEventAt, undefined, 'no lastHookEventAt stamp from a stale option');
    assert.deepStrictEqual(statusChanges(audit), [], 'no status_change emitted');
  } finally {
    bridge.tmuxReadStatusOptions = origTmuxRead;
    restoreDb();
  }
});

// ── Hook-driven `waiting` across transports (plans/hook-driven-waiting-status.md
//    Test plan → multi-transport-matrix.test.ts) ─────────────────────────
//
// A Notification-hook `waiting` event must apply IDENTICALLY whether it
// arrives over http, spool, or tmux-option: each dispatches
// monitor.forceWaiting(agentId, 'notification', excerpt), flips the worker to
// 'waiting', stamps hook health, and records a single status_change whose
// source is the waiting kind ('notification'). And a STALE tmux-option / spool
// `waiting` must be rejected by the existing freshness/dedupe gates with NO
// side effects.

interface WaitingEnv {
  supervisor: AgentSupervisor;
  agent: Agent;
  audit: AuditRow[];
  cleanup: () => void;
}

/** Minimal db-patched supervisor + a single working worker, with no launch:
 *  applyHookStatusEvent is exercised directly. Mirrors the runCell setup but
 *  trimmed to what the waiting-apply path needs. */
function makeWaitingEnv(): WaitingEnv {
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const agent = makeAgent('w-1', {
    provider: 'claude', isWorker: true, isSupervised: false, status: 'working',
    workingDirectory: '/home/u/proj/.lares/workers/claude',
  });
  agentsMap.set(agent.id, agent);
  const supervisor = makeSupervisor();
  return {
    supervisor, agent, audit,
    cleanup: () => { restoreDb(); },
  };
}

function waitingEvent(agentId: string, ts: number, excerpt: string): ParsedHookEvent {
  return {
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `wait-${ts}`,
    waitingExcerpt: excerpt,
    notificationType: 'permission_prompt',
  } as ParsedHookEvent;
}

function waitingChanges(audit: AuditRow[]): Array<{ from: string; to: string; source: string }> {
  return statusChanges(audit).filter((c) => c.to === 'waiting');
}

test('waiting applied identically via http / spool / tmux-option → same forceWaiting outcome', () => {
  // The three production transports. Each is its own fresh env so dedupe /
  // ordering watermarks start empty and the apply is independent.
  const transports: Array<'http' | 'spool' | 'tmux-option'> = ['http', 'spool', 'tmux-option'];
  for (const transport of transports) {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      // ts is "now": within TMUX_OPTION_MAX_AGE_MS, ahead of an unset
      // lastHookEventAt, and (no launch stamp) past the launch-skew guard — so
      // the tmux-option cell clears all three freshness gates too.
      const ev = waitingEvent(agent.id, Date.now(), 'Bash tool requires permission');
      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, ev, transport);

      assert.equal(result, 'applied', `${transport}: a fresh waiting event must apply`);
      assert.equal(agent.status, 'waiting', `${transport}: worker must flip to waiting`);
      assert.equal(agent.hookStatus, 'healthy', `${transport}: a waiting event is a healthy hook heartbeat`);

      // forceWaiting tags the status_change with the waiting KIND ('notification'),
      // not the wire transport — identical across all three transports.
      const flips = waitingChanges(audit);
      assert.equal(flips.length, 1, `${transport}: exactly one waiting status_change; got ${JSON.stringify(statusChanges(audit))}`);
      assert.equal(flips[0].from, 'working', `${transport}: flip is from working`);
      assert.equal(flips[0].source, 'notification', `${transport}: waiting kind is 'notification' regardless of transport`);

      // The excerpt rides through to the monitor latch unchanged.
      const latch = (supervisor as unknown as {
        monitor: { turnLatch: Map<string, { waitingExcerpt?: string; waitingKind?: string; state?: string }> };
      }).monitor;
      const entry = latch.turnLatch.get(agent.id);
      assert.ok(entry && entry.state === 'waiting', `${transport}: monitor latch records the waiting state`);
      assert.equal(entry!.waitingKind, 'notification', `${transport}: latch carries the notification kind`);
      assert.equal(entry!.waitingExcerpt, 'Bash tool requires permission', `${transport}: latch carries the excerpt`);
    } finally {
      cleanup();
    }
  }
});

// idle-vs-waiting fix (plans/idle-vs-waiting-notification-fix.md Test matrix) —
// a non-blocking Notification (notification_type 'idle_prompt': the ~60s idle
// reminder) must NOT flip the card to 'waiting' on ANY transport. The shapes
// below are the REAL per-transport wire shapes, not pre-normalized events:
//   - HTTP carries `waitingExcerpt` (api-server.ts maps raw `excerpt` →
//     `waitingExcerpt`, raw `notificationType` → `notificationType`).
//   - spool & tmux-option JSON.parse the raw record straight through, so they
//     carry the raw `excerpt` field and `notificationType` but NEVER
//     `waitingExcerpt`. The discriminator keys ONLY on `notificationType`, which
//     is why the spool/tmux rows (no waitingExcerpt) are still correctly
//     suppressed — that asymmetry is the point.

/** HTTP-shaped event: mirrors the api-server.ts status-endpoint mapping
 *  (excerpt → waitingExcerpt, notificationType → notificationType). */
function httpIdlePromptEvent(agentId: string, ts: number): ParsedHookEvent {
  return {
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `idle-${ts}`,
    waitingExcerpt: 'Claude is waiting for your input',
    notificationType: 'idle_prompt',
  } as ParsedHookEvent;
}

/** spool/tmux-shaped event: the JSON.parse of the raw record. Note the RAW
 *  `excerpt` field name and the absence of `waitingExcerpt`. */
function rawIdlePromptRecord(agentId: string, ts: number): ParsedHookEvent {
  return {
    v: 1,
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `idle-${ts}`,
    excerpt: 'Claude is waiting for your input',
    notificationType: 'idle_prompt',
  } as unknown as ParsedHookEvent;
}

test('idle_prompt Notification suppressed on http / spool / tmux-option → no forceWaiting (discriminator keys only on notificationType)', () => {
  const cases: Array<{ transport: 'http' | 'spool' | 'tmux-option'; ev: (id: string, ts: number) => ParsedHookEvent }> = [
    { transport: 'http', ev: httpIdlePromptEvent },
    { transport: 'spool', ev: rawIdlePromptRecord },
    { transport: 'tmux-option', ev: rawIdlePromptRecord },
  ];
  for (const { transport, ev } of cases) {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      // Confirm the wire asymmetry the test is built on.
      const wire = ev(agent.id, Date.now());
      if (transport === 'http') {
        assert.equal((wire as { waitingExcerpt?: string }).waitingExcerpt, 'Claude is waiting for your input',
          'http carries waitingExcerpt');
      } else {
        assert.equal((wire as { waitingExcerpt?: string }).waitingExcerpt, undefined,
          `${transport} carries NO waitingExcerpt — only the raw excerpt field`);
        assert.equal((wire as unknown as { excerpt?: string }).excerpt, 'Claude is waiting for your input',
          `${transport} carries the raw excerpt field`);
      }

      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, wire, transport);

      assert.equal(result, 'applied', `${transport}: the idle reminder is still ACCEPTED (a heartbeat)`);
      assert.equal(agent.status, 'working', `${transport}: an idle_prompt must NOT flip the worker to waiting`);
      assert.deepStrictEqual(waitingChanges(audit), [], `${transport}: no waiting status_change from an idle_prompt`);
      // Step-7 liveness still ran (only the dashboard-side flip is suppressed).
      assert.equal(agent.hookStatus, 'healthy', `${transport}: idle reminder still stamps hook health (heartbeat)`);
    } finally {
      cleanup();
    }
  }
});

// grok turn-complete phantom-waiting fix — the grok lane fires a Notification
// hook on turn COMPLETION with the message "Turn complete" and NO
// notification_type. The type-based discriminator can't catch it, so it used to
// flip an already-idle worker to 'waiting' ~60s after a clean Stop→idle. The
// message-based rule must suppress it on EVERY transport: HTTP carries the
// message as `waitingExcerpt`, spool/tmux-option as the raw `excerpt` alias.

/** HTTP-shaped grok turn-complete event (excerpt → waitingExcerpt, no type). */
function httpTurnCompleteEvent(agentId: string, ts: number): ParsedHookEvent {
  return {
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `tc-${ts}`,
    waitingExcerpt: 'Turn complete',
  } as ParsedHookEvent;
}

/** spool/tmux-shaped grok turn-complete record: raw `excerpt`, no `waitingExcerpt`,
 *  no `notificationType` — exactly the live pending-status.jsonl evidence. */
function rawTurnCompleteRecord(agentId: string, ts: number): ParsedHookEvent {
  return {
    v: 1,
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `tc-${ts}`,
    excerpt: 'Turn complete',
  } as unknown as ParsedHookEvent;
}

test('grok "Turn complete" Notification suppressed on http / spool / tmux-option → no forceWaiting', () => {
  const cases: Array<{ transport: 'http' | 'spool' | 'tmux-option'; ev: (id: string, ts: number) => ParsedHookEvent }> = [
    { transport: 'http', ev: httpTurnCompleteEvent },
    { transport: 'spool', ev: rawTurnCompleteRecord },
    { transport: 'tmux-option', ev: rawTurnCompleteRecord },
  ];
  for (const { transport, ev } of cases) {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      const wire = ev(agent.id, Date.now());
      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, wire, transport);

      assert.equal(result, 'applied', `${transport}: the turn-complete notice is still ACCEPTED (a heartbeat)`);
      assert.equal(agent.status, 'working', `${transport}: "Turn complete" must NOT flip the worker to waiting`);
      assert.deepStrictEqual(waitingChanges(audit), [], `${transport}: no waiting status_change from a turn-complete notice`);
      assert.equal(agent.hookStatus, 'healthy', `${transport}: turn-complete still stamps hook health (heartbeat)`);
    } finally {
      cleanup();
    }
  }
});

/** spool/tmux-shaped genuine input-needed record: raw `excerpt`, no type. This
 *  is the control — a REAL input gate that arrives with no notification_type
 *  (like grok) must STILL latch 'waiting'; only turn-completion is suppressed. */
function rawInputNeededRecord(agentId: string, ts: number): ParsedHookEvent {
  return {
    v: 1,
    agentId,
    state: 'waiting',
    source: 'hook-notification',
    ts,
    hookEventName: 'Notification',
    turnId: `in-${ts}`,
    excerpt: 'Agent is waiting for your input',
  } as unknown as ParsedHookEvent;
}

test('genuine input-needed Notification (no type) STILL latches waiting on http / spool / tmux-option', () => {
  const cases: Array<{ transport: 'http' | 'spool' | 'tmux-option'; ev: (id: string, ts: number) => ParsedHookEvent }> = [
    { transport: 'http', ev: (id, ts) => ({ ...rawInputNeededRecord(id, ts), waitingExcerpt: 'Agent is waiting for your input', excerpt: undefined } as unknown as ParsedHookEvent) },
    { transport: 'spool', ev: rawInputNeededRecord },
    { transport: 'tmux-option', ev: rawInputNeededRecord },
  ];
  for (const { transport, ev } of cases) {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, ev(agent.id, Date.now()), transport);

      assert.equal(result, 'applied', `${transport}: input-needed notice accepted`);
      assert.equal(agent.status, 'waiting', `${transport}: a genuine input gate MUST flip the worker to waiting`);
      assert.equal(waitingChanges(audit).length, 1, `${transport}: exactly one waiting status_change`);
    } finally {
      cleanup();
    }
  }
});

test('STALE tmux-option / spool waiting → rejected by freshness & ordering gates, no flip, no stamp', () => {
  // (a) tmux-option: an option that survived a dashboard restart is 11 minutes
  //     old → tripped by the bounded-age gate (TMUX_OPTION_MAX_AGE_MS = 10min).
  {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      const stale = waitingEvent(agent.id, Date.now() - 11 * 60_000, 'old wait');
      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, stale, 'tmux-option');

      assert.equal(result, 'stale', 'an 11-minute-old tmux-option waiting must be rejected');
      assert.equal(agent.status, 'working', 'a stale tmux-option waiting must NOT flip status');
      assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'a stale tmux-option waiting must NOT stamp hook health');
      assert.equal(agent.lastHookEventAt, undefined, 'a stale tmux-option waiting must NOT stamp lastHookEventAt');
      assert.deepStrictEqual(waitingChanges(audit), [], 'no waiting status_change from a stale option');
    } finally {
      cleanup();
    }
  }

  // (b) spool: a newer event already advanced the ordering watermark, so an
  //     older spool waiting is rejected by the ordering guard (step 5) — same
  //     no-side-effect contract as tmux staleness.
  {
    const { supervisor, agent, audit, cleanup } = makeWaitingEnv();
    try {
      const now = Date.now();
      // A fresh working event lands first and advances lastAppliedHookTs.
      const ahead = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, {
        agentId: agent.id, state: 'working', source: 'hook-start', ts: now,
        hookEventName: 'UserPromptSubmit', turnId: 'turn-ahead',
      } as ParsedHookEvent, 'spool');
      assert.equal(ahead, 'applied', 'the newer working event applies and advances the watermark');
      assert.equal(agent.status, 'working');

      const auditBefore = audit.length;
      // A spool waiting whose ts is strictly older than the watermark → stale.
      const stale = waitingEvent(agent.id, now - 5_000, 'late-arriving wait');
      const result = (supervisor as unknown as {
        applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
      }).applyHookStatusEvent(agent.id, stale, 'spool');

      assert.equal(result, 'stale', 'a spool waiting older than the ordering watermark must be rejected');
      assert.equal(agent.status, 'working', 'a stale spool waiting must NOT flip status to waiting');
      assert.deepStrictEqual(waitingChanges(audit), [], 'no waiting status_change from a stale spool event');
      assert.equal(audit.length, auditBefore, 'a stale spool waiting emits no audit rows');
    } finally {
      cleanup();
    }
  }
});

// ── tmuxReadStatusOptions command shape (plan §4, injected exec) ────────

test('tmuxReadStatusOptions: one wsl.exe invocation, shQuoted names, explicit pane resolution, tab-parsed values', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmuxReadStatusOptions } = require('../wsl-bridge') as {
    tmuxReadStatusOptions: (
      names: string[],
      exec?: (cmd: string, timeout: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
    ) => Promise<Map<string, string>>;
  };

  const commands: string[] = [];
  const fakeExec = async (cmd: string, _timeout: number) => {
    commands.push(cmd);
    return {
      stdout: `cad__one\t{"v":1,"state":"idle"}\ncad__we'rd\t\n`,
      stderr: '',
      exitCode: 0,
    };
  };

  const values = await tmuxReadStatusOptions(['cad__one', "cad__we'rd"], fakeExec);

  assert.equal(commands.length, 1, 'all sessions ride ONE wsl.exe invocation');
  const cmd = commands[0];
  // §1: the status-poll script is now wrapped by wslBashEnvelope so the inner
  // double quotes never cross the wsl.exe argv boundary. Assert the quote-free
  // envelope, then decode it and run the shape assertions against the original
  // `for s in … done` script.
  assert.ok(!/["']/.test(cmd), `enveloped command carries no quote class; got: ${cmd}`);
  const m = cmd.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/);
  assert.ok(m, `command must be the base64 envelope; got: ${cmd}`);
  const script = Buffer.from(m![1], 'base64').toString('utf8');
  assert.ok(script.includes("'cad__one'"), `session names must be shQuoted; got: ${script}`);
  assert.ok(script.includes("'cad__we'\\''rd'"), `embedded single quotes must be spliced; got: ${script}`);
  assert.ok(/display-message -p -t "\$s" '#\{pane_id\}'/.test(script),
    `pane id must be resolved explicitly per session; got: ${script}`);
  assert.ok(/show-options -pqv -t "\$p" @agentdashboard-status/.test(script),
    `option read must target the resolved PANE, -q for missing-option silence; got: ${script}`);
  assert.ok(script.includes('|| continue'), `a vanished session must be skipped, not fail the batch; got: ${script}`);

  assert.equal(values.get('cad__one'), '{"v":1,"state":"idle"}');
  assert.equal(values.get("cad__we'rd"), '', 'unset option → empty string');

  // Empty input → zero wsl.exe cost.
  const before = commands.length;
  const empty = await tmuxReadStatusOptions([], fakeExec);
  assert.equal(empty.size, 0);
  assert.equal(commands.length, before, 'no sessions → no wsl.exe invocation');
});

// ── Custom-Codex hookless guard (plan §5 E6) ───────────────────────────

async function launchViaLaunchAgent(command: string): Promise<{ agent: Agent; supervisor: AgentSupervisor; cleanup: () => void }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-guard-'));
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const workspace: Workspace = {
    id: 'ws-1', title: 'WS', path: tmp, pathType: 'windows', description: '',
    defaultCommand: 'claude --dangerously-skip-permissions --chrome',
    createdAt: '', updatedAt: '', lastOpenedAt: null,
  };
  const restoreDb = patchDb(agentsMap, audit, workspace);
  const restoreDiscovery = stubCodexDiscovery();
  const supervisor = makeSupervisor();
  // Keep the launch off the real machine: no scaffold writes outside tmp, no
  // CODEX_HOME/profile writes, no user-global trust seeding, no real spawn.
  const s = supervisor as unknown as Record<string, unknown>;
  s.ensureWorkerScaffold = () => {};
  s.ensureCodexHookProfile = () => {};
  s.ensureProviderDirTrust = () => {};
  s.loadAgentMd = () => null;
  s.launchWindowsAgent = async () => {};

  const input: LaunchAgentInput = {
    workspaceId: 'ws-1', title: 'codex guard', provider: 'codex', isWorker: true, command,
  };
  const agent = await supervisor.launchAgent(input);
  return {
    agent: agentsMap.get(agent.id)!,
    supervisor,
    cleanup: () => {
      restoreDiscovery();
      restoreDb();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

test('custom-codex guard: un-instrumentable worker-lane codex command → hook_status=degraded, canary NOT armed', async () => {
  const { agent, supervisor, cleanup } = await launchViaLaunchAgent('my-custom-agent-runner --weird-flags');
  try {
    assert.equal(agent.hookStatus, 'degraded',
      'a worker-lane codex command that cannot be instrumented must be loudly degraded — never silently hookless');
    const monitor = (supervisor as unknown as { monitor: { isHookCanaryArmed: (id: string) => boolean } }).monitor;
    assert.equal(monitor.isHookCanaryArmed(agent.id), false,
      'degraded lane must not arm the canary (it would flip degraded→broken semantics)');
    assert.notEqual(agent.hookStatus ?? 'unknown', 'unknown', 'steady state must not be unknown');
    assert.notEqual(agent.hookStatus, 'healthy', 'zero transports can never be healthy');
  } finally {
    cleanup();
  }
});

test('custom-codex guard control: instrumentable codex command → canary armed, hook_status starts unknown', async () => {
  const { agent, supervisor, cleanup } = await launchViaLaunchAgent('codex --dangerously-bypass-approvals-and-sandbox');
  try {
    assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'instrumented lane starts unknown (canary will verify)');
    const monitor = (supervisor as unknown as { monitor: { isHookCanaryArmed: (id: string) => boolean } }).monitor;
    assert.equal(monitor.isHookCanaryArmed(agent.id), true,
      'instrumented worker-lane codex arms the launch canary');
    // Path A (probe 2026-07-28): a native-Windows worker-lane codex agent gets
    // its hooks from the worker-cwd trusted-project .codex/config.toml, so the
    // launch command must NOT carry --profile (Run D: layers merge → double-fire)
    // but MUST keep --dangerously-bypass-hook-trust (Run C: hooks silently don't
    // fire without it). The workspace above is pathType:'windows'.
    assert.ok(!/--profile/.test(agent.command) && /--dangerously-bypass-hook-trust/.test(agent.command),
      `native-Windows worker-lane codex must drop --profile and keep the bypass flag; got: ${agent.command}`);
  } finally {
    cleanup();
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
