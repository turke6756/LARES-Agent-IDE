// P1 multi-transport matrix tests (plans/p1-hook-spool-multi-transport.md §5
// E5/E6 + the §5 E4 restart-shaped tmux end-to-end).
//
// Cells: Claude×Windows, Codex×Windows, Claude×WSL, Codex×WSL — each asserts:
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import type { ParsedHookEvent } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { windowsToWslPath } from '../path-utils';
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
    'updateAgentStatus', 'updateAgentHookStatus', 'updateAgentPid', 'getAgent',
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

  return () => { for (const k of keys) db[k] = orig[k]; };
}

function stubRunnerLaunches(): {
  winEnvs: Array<Record<string, string> | undefined>;
  wslCommands: string[];
  restore: () => void;
} {
  const winEnvs: Array<Record<string, string> | undefined> = [];
  const wslCommands: string[] = [];
  const origWin = (WindowsRunner.prototype as { launch: unknown }).launch;
  const origWsl = (WslRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string, _cmd: string, _args: string[], _logPath: string,
    _directSpawn?: boolean, extraEnv?: Record<string, string>,
  ) {
    winEnvs.push(extraEnv);
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner, _workDir: string, command: string,
  ) {
    wslCommands.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };
  return {
    winEnvs,
    wslCommands,
    restore: () => {
      (WindowsRunner.prototype as { launch: unknown }).launch = origWin;
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

// ── The four matrix cells ─────────────────────────────────────────────

interface CellOpts {
  provider: 'claude' | 'codex';
  pathType: 'windows' | 'wsl';
}

async function runCell(opts: CellOpts): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ad-matrix-${opts.provider}-${opts.pathType}-`));
  const agentsMap = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agentsMap, audit);
  const runners = stubRunnerLaunches();
  const restoreDiscovery = stubCodexDiscovery();
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
      ? `${root}/.dashboard/workers/${opts.provider}`
      : path.join(tmp, '.dashboard', 'workers', opts.provider);
    const agent = makeAgent(`m-${opts.provider}-${opts.pathType}`, {
      provider: opts.provider,
      isSupervised: false,
      isWorker: true,
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
      const expected = `DASHBOARD_SPOOL_PATH='${root}/.dashboard/pending-status.jsonl'`;
      assert.ok(cmd.includes(expected),
        `WSL launch must inject the shell-quoted WSL-native spool path; expected ${expected} in: ${cmd}`);
    } else {
      assert.equal(runners.winEnvs.length, 1);
      const env = runners.winEnvs[0]!;
      assert.equal(env.DASHBOARD_SPOOL_PATH, path.join(tmp, '.dashboard', 'pending-status.jsonl'),
        'Windows launch must inject the native spool path in extraEnv');
    }

    const spoolFile = path.join(tmp, '.dashboard', 'pending-status.jsonl');
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
    agent.status = 'working';
    fs.appendFileSync(spoolFile, spoolRecord(agent.id, 'idle', Date.now() + 60_000, 'spool-1'));
    (supervisor as unknown as { pollHookTransports: () => void }).pollHookTransports();
    assert.equal(agent.status, 'idle', 'spool-delivered Stop must flip the worker to idle');
    const spoolFlips = statusChanges(audit).filter((c) => c.source === 'hook-spool');
    assert.equal(spoolFlips.length, 1, `expected one hook-spool flip; got ${JSON.stringify(statusChanges(audit))}`);
    assert.equal(agent.hookStatus, 'healthy', 'applied spool event stamps hook health');

    // (iii) inferStatus returns null for the worker throughout.
    if (isWsl) {
      const wslRunner = (supervisor as unknown as { wslRunners: Map<string, WslRunner> }).wslRunners.get(agent.id)!;
      (wslRunner as unknown as { isStillAlive: () => Promise<boolean> }).isStillAlive = async () => true;
    }
    const monitor = (supervisor as unknown as { monitor: { inferStatus: (a: Agent) => Promise<string | null> } }).monitor;
    assert.equal(await monitor.inferStatus(agent), null,
      'worker-lane PTY inference must stay disabled (hook-owned status)');
  } finally {
    bridge.tmuxReadStatusOptions = origTmuxRead;
    restoreDiscovery();
    runners.restore();
    restoreDb();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('matrix cell: Claude × Windows', () => runCell({ provider: 'claude', pathType: 'windows' }));
test('matrix cell: Codex × Windows', () => runCell({ provider: 'codex', pathType: 'windows' }));
test('matrix cell: Claude × WSL', () => runCell({ provider: 'claude', pathType: 'wsl' }));
test('matrix cell: Codex × WSL', () => runCell({ provider: 'codex', pathType: 'wsl' }));

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
      workingDirectory: '/home/u/proj/.dashboard/workers/claude',
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
  assert.ok(cmd.includes("'cad__one'"), `session names must be shQuoted; got: ${cmd}`);
  assert.ok(cmd.includes("'cad__we'\\''rd'"), `embedded single quotes must be spliced; got: ${cmd}`);
  assert.ok(/display-message -p -t "\$s" '#\{pane_id\}'/.test(cmd),
    `pane id must be resolved explicitly per session; got: ${cmd}`);
  assert.ok(/show-options -pqv -t "\$p" @agentdashboard-status/.test(cmd),
    `option read must target the resolved PANE, -q for missing-option silence; got: ${cmd}`);
  assert.ok(cmd.includes('|| continue'), `a vanished session must be skipped, not fail the batch; got: ${cmd}`);

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
    assert.ok(/--profile dashboard-worker/.test(agent.command) && /--dangerously-bypass-hook-trust/.test(agent.command),
      `instrumented command must carry the hook profile + bypass flags; got: ${agent.command}`);
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
