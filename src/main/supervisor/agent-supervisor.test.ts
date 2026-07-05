// Supervisor-level tests for the sendInput status-seed contract.
//
// Originally written for the BUG-09 launch-seed fix
// (plans/bug-09-launch-seed-fix-plan.md §4.2). Updated 2026-05-30 when the
// optimistic `user-input-submitted` working seed was REMOVED entirely — a send
// that merely *delivered* (WSL `_doSendInput` returns true even when the kitty
// Enter was dropped) must no longer assert `working`. With the seed gone, the
// only status side-effect of a send is the `waiting → working` flip that
// `EventBridge.notifyUserInputDelivered` performs for a non-worker agent that
// was blocked on input. See docs/AGENT_STATUS_LANES_AND_SUBMIT_RECOVERY.md §4.
//
// Covers:
//   1. Windows launch — no `launch-pending` or `user-input-submitted` seed fires.
//   2. WSL launch — no `launch-pending` or `user-input-submitted` seed fires.
//   3. sendInput on an `idle` non-worker agent (submit=true) — only
//      [notifyUserInputDelivered]; no `user-input-submitted` seed.
//   3c. sendInput on an `idle` plain WORKER (isWorker) — only
//      [notifyUserInputDelivered]; worker status is hook-owned, no seed.
//   4. sendInput on a `waiting` non-worker agent (submit=true) — only
//      [notifyUserInputDelivered, forceWorking:user-input]. The inner
//      `forceWorking:user-input` is the real EventBridge waiting→working flip;
//      the `user-input-submitted` seed is gone.
//   5. sendInput on an `idle` agent with submit=false — no calls.
//   6. WSL runner with `isAlive === false` — `_doSendInput` returns false and
//      no calls fire.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/agent-supervisor.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSupervisor, SubmitNotConfirmedError } from './index';
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

// ── DB module patching ───────────────────────────────────────────────
// Wider than `test-helpers/fake-status-deps.patchDatabaseModule` because
// launchWindowsAgent / launchWslAgent and the constructor side-effects
// touch more functions than just `updateAgentStatus`/`addEvent`.
function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus',
    'updateAgentHookStatus',
    'updateAgentLastSendError',
    'updateAgentPid',
    'getAgent',
    'addEvent',
    'updateAgentLastOutput',
    'updateAgentExitCode',
    'getActiveAgents',
    'getAllAgents',
    'getSupervisorAgent',
    'addFileActivity',
    'getTeamMembership',
    'getCurrentBrick',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.updateAgentHookStatus = (
    id: string,
    hookStatus: NonNullable<Agent['hookStatus']>,
    lastHookEventAt?: number,
  ) => {
    const a = agentsMap.get(id);
    if (a) {
      a.hookStatus = hookStatus;
      if (lastHookEventAt !== undefined) a.lastHookEventAt = lastHookEventAt;
    }
  };
  db.updateAgentLastSendError = (
    id: string,
    err: { message: string; ts: number } | null,
  ) => {
    const a = agentsMap.get(id);
    if (a) a.lastSendError = err;
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
  // WP-A.2 — launchWindowsAgent/launchWslAgent now read getTeamMembership to
  // decide whether to inject the team --mcp-config. Default to no team so these
  // status-contract tests don't open the real (native) DB.
  db.getTeamMembership = () => null;
  // Context-brick Inc 4 (4.2) — every fresh launch consults the brick gate's
  // DB fallback; no continuation state in these fixtures.
  db.getCurrentBrick = () => null;

  return () => {
    for (const k of keys) db[k] = orig[k];
  };
}

// ── Harness ──────────────────────────────────────────────────────────
interface Harness {
  supervisor: AgentSupervisor;
  agentsMap: Map<string, Agent>;
  calls: string[];
  cleanup(): void;
}

function setup(opts: {
  agent: Agent;
  injectRunner?: 'windows' | 'wsl' | 'none';
  alive?: boolean;
  /** Stubbed result for the synchronous confirm-and-retry. Defaults to true
   *  (confirmed) so seed-contract tests stay focused on the notify/forceWorking
   *  side-effects; the real confirm mechanism is unit-tested in
   *  status-monitor.test.ts. Set false to exercise the exhaustion/throw path. */
  confirmResult?: boolean;
}): Harness {
  const agentsMap = new Map<string, Agent>([[opts.agent.id, opts.agent]]);
  const restoreDb = patchDb(agentsMap);

  // Stub runner.launch on the prototypes so the real process spawn never fires
  // when launchWindowsAgent / launchWslAgent are driven. We do this on the
  // prototype rather than on individual instances because launchWindowsAgent
  // does `new WindowsRunner()` internally — there's no test seam to inject a
  // pre-built runner.
  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  const origWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (this: WindowsRunner) {
    // Set _pid via index access so updateAgentPid sees something non-null.
    (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  (WslRunner.prototype as { launch: unknown }).launch = async function (this: WslRunner) {
    (this as unknown as { _alive: boolean })._alive = true;
  };

  const supervisor = new AgentSupervisor();
  // Suppress writes to ~/.claude/agent-registry.json triggered by emit('statusChanged').
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};

  if (opts.injectRunner === 'windows') {
    const fake = new WindowsRunner();
    Object.defineProperty(fake, 'isAlive', {
      get: () => opts.alive !== false,
      configurable: true,
    });
    (fake as unknown as { write: (data: string) => void }).write = () => {};
    (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> })
      .windowsRunners.set(opts.agent.id, fake);
  } else if (opts.injectRunner === 'wsl') {
    const fake = new WslRunner(opts.agent.tmuxSessionName ?? 'test-tmux');
    Object.defineProperty(fake, 'isAlive', {
      get: () => opts.alive !== false,
      configurable: true,
    });
    (supervisor as unknown as { wslRunners: Map<string, WslRunner> })
      .wslRunners.set(opts.agent.id, fake);
  }

  const calls: string[] = [];
  const bridge = (supervisor as unknown as { bridge: { notifyUserInputDelivered: (id: string) => void } }).bridge;
  const realNotify = bridge.notifyUserInputDelivered.bind(bridge);
  bridge.notifyUserInputDelivered = (id: string) => {
    calls.push('notifyUserInputDelivered');
    // Run the real impl so it can fire its own forceWorking:user-input when
    // agent.status === 'waiting' (event-bridge.ts:351).
    realNotify(id);
  };
  const monitor = (supervisor as unknown as { monitor: {
    forceWorking: (id: string, opts: { source: string }) => void;
    confirmSubmission: (id: string, prior: number) => Promise<boolean>;
  } }).monitor;
  monitor.forceWorking = (_id: string, fwOpts: { source: string }) => {
    calls.push(`forceWorking:${fwOpts.source}`);
  };
  // Stub the synchronous confirm-and-retry so seed-contract tests don't poll on
  // the real wall-clock. Records the call so tests can assert whether the
  // contract path engaged for a given provider/lane.
  monitor.confirmSubmission = async (_id: string, _prior: number) => {
    calls.push('confirmSubmission');
    return opts.confirmResult !== false;
  };

  return {
    supervisor,
    agentsMap,
    calls,
    cleanup: () => {
      (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
      (WslRunner.prototype as { launch: unknown }).launch = origWslLaunch;
      restoreDb();
    },
  };
}

// Convenience: filter calls to only the ones the launch-seed fix cares about,
// so flaky construction-time emissions (e.g., agent-registry side-effects we
// patched away) can't leak into assertions.
function seedCalls(calls: string[]): string[] {
  return calls.filter((c) =>
    c === 'notifyUserInputDelivered' ||
    c.startsWith('forceWorking:'));
}

// ── Tests ────────────────────────────────────────────────────────────

test('Case 1: launchWindowsAgent fires neither launch-pending nor user-input-submitted seed', async () => {
  const agent = makeAgent('w-1', {
    provider: 'claude',
    isSupervisor: false,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    await (h.supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
    const recorded = seedCalls(h.calls);
    assert.ok(
      !recorded.some((c) => c === 'forceWorking:launch-pending'),
      `expected no launch-pending forceWorking; got ${JSON.stringify(recorded)}`,
    );
    assert.ok(
      !recorded.some((c) => c === 'forceWorking:user-input-submitted'),
      `expected no user-input-submitted forceWorking on launch; got ${JSON.stringify(recorded)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('Case 2: launchWslAgent fires neither launch-pending nor user-input-submitted seed', async () => {
  const agent = makeAgent('w-2', {
    provider: 'claude',
    isSupervisor: false,
    command: 'claude',
    workingDirectory: '/home/test',
    tmuxSessionName: 'agent-w-2',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    await (h.supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);
    const recorded = seedCalls(h.calls);
    assert.ok(
      !recorded.some((c) => c === 'forceWorking:launch-pending'),
      `expected no launch-pending forceWorking; got ${JSON.stringify(recorded)}`,
    );
    assert.ok(
      !recorded.some((c) => c === 'forceWorking:user-input-submitted'),
      `expected no user-input-submitted forceWorking on launch; got ${JSON.stringify(recorded)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('Case 3: sendInput on unsupervised idle agent + submit=true fires NO user-input-submitted seed', async () => {
  const agent = makeAgent('w-3', {
    provider: 'claude',
    status: 'idle',
    isSupervised: false,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    // Seed removed (2026-05-30): a delivered send no longer asserts working.
    // The idle agent isn't waiting, so notifyUserInputDelivered is a no-op flip.
    assert.deepStrictEqual(
      seedCalls(h.calls),
      ['notifyUserInputDelivered'],
    );
    assert.ok(
      !seedCalls(h.calls).includes('forceWorking:user-input-submitted'),
      'the optimistic user-input-submitted seed must not fire for any lane',
    );
  } finally {
    h.cleanup();
  }
});

test('Case 3c: sendInput on idle plain WORKER (isWorker) fires NO seed — status is hook-owned', async () => {
  const agent = makeAgent('w-3c', {
    provider: 'claude',
    status: 'idle',
    isSupervised: false,
    isWorker: true,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    assert.deepStrictEqual(
      seedCalls(h.calls),
      ['notifyUserInputDelivered'],
      'plain workers derive working solely from the UserPromptSubmit hook',
    );
  } finally {
    h.cleanup();
  }
});

test('Case 4: sendInput on unsupervised waiting agent + submit=true fires only the waiting→working flip', async () => {
  const agent = makeAgent('w-4', {
    provider: 'claude',
    status: 'waiting',
    isSupervised: false,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'answer', { submit: true });
    // `forceWorking:user-input` is the real EventBridge waiting→working flip
    // (non-worker, was blocked on input). The `user-input-submitted` seed that
    // used to trail it is gone.
    assert.deepStrictEqual(
      seedCalls(h.calls),
      [
        'notifyUserInputDelivered',
        'forceWorking:user-input',
      ],
    );
  } finally {
    h.cleanup();
  }
});

test('Case 3b (BUG-10): sendInput on supervised idle agent + submit=true does NOT seed user-input-submitted', async () => {
  // Paste-race fix — start hook owns supervised idle→working. notifyUserInputDelivered
  // is still called (it's a no-op outside waiting), but the optimistic
  // user-input-submitted seed is suppressed.
  const agent = makeAgent('w-3b', {
    provider: 'claude',
    status: 'idle',
    isSupervised: true,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    const recorded = seedCalls(h.calls);
    assert.ok(
      !recorded.some((c) => c === 'forceWorking:user-input-submitted'),
      `supervised + idle: user-input-submitted seed must be suppressed; got ${JSON.stringify(recorded)}`,
    );
    assert.ok(
      recorded.includes('notifyUserInputDelivered'),
      'notifyUserInputDelivered is still called (gate lives inside it for supervised+waiting)',
    );
  } finally {
    h.cleanup();
  }
});

test('Case 4b (BUG-10): sendInput on supervised waiting agent fires no forceWorking at all', async () => {
  const agent = makeAgent('w-4b', {
    provider: 'claude',
    status: 'waiting',
    isSupervised: true,
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'answer', { submit: true });
    const recorded = seedCalls(h.calls);
    assert.ok(
      !recorded.some((c) => c.startsWith('forceWorking:')),
      `supervised + waiting: no forceWorking seeds; got ${JSON.stringify(recorded)}`,
    );
    assert.ok(
      recorded.includes('notifyUserInputDelivered'),
      'notifyUserInputDelivered is still invoked (internal supervised gate handles the no-op)',
    );
  } finally {
    h.cleanup();
  }
});

test('Case 5: sendInput on idle agent + submit=false makes no calls', async () => {
  const agent = makeAgent('w-5', {
    provider: 'claude',
    status: 'idle',
    command: 'claude',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: false });
    assert.deepStrictEqual(seedCalls(h.calls), []);
  } finally {
    h.cleanup();
  }
});

test('Case 6: sendInput on dead WSL runner returns delivered=false and seeds no latch', async () => {
  const agent = makeAgent('w-6', {
    provider: 'claude',
    status: 'idle',
    command: 'claude',
    workingDirectory: '/home/test',
    tmuxSessionName: 'agent-w-6',
  });
  const h = setup({ agent, injectRunner: 'wsl', alive: false });
  try {
    // sendInput resolves when _doSendInput resolves (regardless of delivered),
    // and threads the delivered boolean through the queue chain so callers
    // that need delivery proof (sendInputConfirmed) can observe the failure.
    // The contract under test: delivered=false + no latch seed.
    const sendDelivered = await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    assert.equal(sendDelivered, false, 'sendInput must resolve false when no runner accepted the bytes');
    assert.deepStrictEqual(seedCalls(h.calls), []);

    // Sanity: drive _doSendInput directly to assert the boolean contract.
    const delivered = await (h.supervisor as unknown as {
      _doSendInput: (id: string, text: string, submit?: boolean) => Promise<boolean>;
    })._doSendInput(agent.id, 'hi', true);
    assert.equal(delivered, false, '_doSendInput must return false when WSL runner is not alive');
  } finally {
    h.cleanup();
  }
});

// Regression for the `env: 'ccode': No such file or directory` failure that
// killed every WSL launch under user shells where `ccode`/`ccodex` are bash
// functions (not PATH binaries). Both `env VAR=value cmd` and `exec cmd`
// only do PATH lookups, so they can't resolve a shell function. The fix
// uses bash's native command-prefix assignment instead and drops `exec` in
// the supervised wrap path.
test('Case 7: launchWslAgent renders command without `env`/`exec` (works with bash function ccode)', async () => {
  const agent = makeAgent('w-7', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: true, // triggers the sysPromptText wrap path (line 1318)
    command: 'ccode --dangerously-skip-permissions',
    workingDirectory: '/home/test/.dashboard/workers/claude',
    tmuxSessionName: 'agent-w-7',
  });
  const h = setup({ agent, injectRunner: 'none' });

  // Override on top of the setup harness's prototype stub so we can capture
  // the rendered command passed to runner.launch(workDir, command, logPath).
  const setupStubLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  const capturedCommands: string[] = [];
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    _workDir: string,
    command: string,
    _logPath: string,
  ) {
    capturedCommands.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    await (h.supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);

    assert.equal(capturedCommands.length, 1, 'expected exactly one launch call');
    const rendered = capturedCommands[0];

    // Fix #1: no `env` wrapper around the agent command.
    assert.ok(
      !/(^|\s|&&\s*)env\s/.test(rendered),
      `rendered command should not invoke /usr/bin/env (would fail on bash function ccode); got: ${rendered}`,
    );

    // Fix #2: no `exec` in the supervised wrap path.
    assert.ok(
      !/(^|\s|&&\s*)exec\s/.test(rendered),
      `rendered command should not use exec (would fail on bash function ccode); got: ${rendered}`,
    );

    // Positive: the ghost-text disable env var is still present, just as a
    // bash command-prefix assignment rather than via `env`.
    assert.ok(
      rendered.includes('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false'),
      `rendered command should retain the ghost-text disable env var; got: ${rendered}`,
    );

    assert.ok(
      rendered.includes("--add-dir '/home/test'"),
      `supervised worker must add the workspace root, not its .dashboard worker cwd; got: ${rendered}`,
    );
  } finally {
    (WslRunner.prototype as { launch: unknown }).launch = setupStubLaunch;
    h.cleanup();
  }
});

// BUG-21 Option 1: resume-launch validates the JSONL exists on disk before
// emitting --resume. If `launchAgent` pre-populated `resumeSessionId` and the
// first launch crashed before Claude wrote the session file, every restart
// would otherwise emit `--resume <uuid>` and deterministically hit "No
// conversation found" on retry forever. The fix clears the stale id, persists
// a new one, and emits `--session-id <new>` instead.
test('Case 8: WSL resume with missing session file → falls back to --session-id with new UUID', async () => {
  const STALE_UUID = '00000000-0000-4000-8000-000000000001';
  const agent = makeAgent('w-8', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    command: 'ccode --dangerously-skip-permissions',
    workingDirectory: '/home/test/missing-session',
    tmuxSessionName: 'agent-w-8',
    resumeSessionId: STALE_UUID,
  });
  const h = setup({ agent, injectRunner: 'none' });

  // Stub sessionLogReader.sessionFileExists → false (file not on disk).
  // The launcher should clear the stale id, generate a new one, and emit
  // --session-id instead of --resume.
  const reader = (h.supervisor as unknown as {
    sessionLogReader: {
      sessionFileExists: (provider: string, cwd: string, id: string) => boolean;
    };
  }).sessionLogReader;
  const sessionFileExistsCalls: Array<{ provider: string; cwd: string; id: string }> = [];
  reader.sessionFileExists = (provider, cwd, id) => {
    sessionFileExistsCalls.push({ provider, cwd, id });
    return false;
  };

  // Capture the DB write so we can assert the new uuid was persisted.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origUpdate = db.updateAgentResumeSessionId;
  const updateCalls: Array<{ id: string; sessionId: string | null }> = [];
  db.updateAgentResumeSessionId = (id: string, sessionId: string | null) => {
    updateCalls.push({ id, sessionId });
    const a = h.agentsMap.get(id);
    if (a) a.resumeSessionId = sessionId;
  };

  // Capture the rendered command passed to WslRunner.launch.
  const setupStubLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  const capturedCommands: string[] = [];
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    _workDir: string,
    command: string,
    _logPath: string,
  ) {
    capturedCommands.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    await (h.supervisor as unknown as {
      launchWslAgent: (a: Agent, resume?: boolean) => Promise<void>;
    }).launchWslAgent(agent, true);

    assert.equal(capturedCommands.length, 1, 'expected exactly one launch call');
    const rendered = capturedCommands[0];

    assert.ok(
      !rendered.includes('--resume'),
      `rendered command must not contain --resume when session file is missing; got: ${rendered}`,
    );
    // `--session-id <uuid>` must be present.
    const sidMatch = rendered.match(/--session-id\s+([0-9a-f-]{36})/);
    assert.ok(sidMatch, `rendered command must contain --session-id <uuid>; got: ${rendered}`);
    const newSessionId = sidMatch![1];
    assert.notEqual(newSessionId, STALE_UUID, 'new session-id must differ from the stale uuid');

    // sessionFileExists was consulted with provider='claude'.
    assert.equal(sessionFileExistsCalls.length, 1, 'sessionFileExists should be called exactly once');
    assert.equal(sessionFileExistsCalls[0].provider, 'claude');
    assert.equal(sessionFileExistsCalls[0].id, STALE_UUID);

    // DB row's resumeSessionId is now the new uuid (we don't clear-then-set,
    // we set once to the new uuid; assert at least one update with the new id).
    const persistedNew = updateCalls.find((c) => c.id === agent.id && c.sessionId === newSessionId);
    assert.ok(
      persistedNew,
      `expected updateAgentResumeSessionId(agent.id, <newUuid>); got: ${JSON.stringify(updateCalls)}`,
    );
    assert.equal(h.agentsMap.get(agent.id)!.resumeSessionId, newSessionId);
  } finally {
    db.updateAgentResumeSessionId = origUpdate;
    (WslRunner.prototype as { launch: unknown }).launch = setupStubLaunch;
    h.cleanup();
  }
});

test('Case 9: WSL resume with present session file → emits --resume (no fallback)', async () => {
  const GOOD_UUID = '00000000-0000-4000-8000-000000000002';
  const agent = makeAgent('w-9', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    command: 'ccode --dangerously-skip-permissions',
    workingDirectory: '/home/test/good-session',
    tmuxSessionName: 'agent-w-9',
    resumeSessionId: GOOD_UUID,
  });
  const h = setup({ agent, injectRunner: 'none' });

  const reader = (h.supervisor as unknown as {
    sessionLogReader: {
      sessionFileExists: (provider: string, cwd: string, id: string) => boolean;
    };
  }).sessionLogReader;
  reader.sessionFileExists = () => true;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origUpdate = db.updateAgentResumeSessionId;
  const updateCalls: Array<{ id: string; sessionId: string | null }> = [];
  db.updateAgentResumeSessionId = (id: string, sessionId: string | null) => {
    updateCalls.push({ id, sessionId });
  };

  const setupStubLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  const capturedCommands: string[] = [];
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    _workDir: string,
    command: string,
    _logPath: string,
  ) {
    capturedCommands.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    await (h.supervisor as unknown as {
      launchWslAgent: (a: Agent, resume?: boolean) => Promise<void>;
    }).launchWslAgent(agent, true);

    assert.equal(capturedCommands.length, 1);
    const rendered = capturedCommands[0];
    assert.ok(
      rendered.includes(`--resume ${GOOD_UUID}`),
      `rendered command must contain --resume ${GOOD_UUID}; got: ${rendered}`,
    );
    assert.ok(
      !rendered.includes('--session-id'),
      `rendered command must not contain --session-id when resuming a valid session; got: ${rendered}`,
    );
    assert.equal(updateCalls.length, 0, 'no resumeSessionId update should be persisted on the happy path');
  } finally {
    db.updateAgentResumeSessionId = origUpdate;
    (WslRunner.prototype as { launch: unknown }).launch = setupStubLaunch;
    h.cleanup();
  }
});

// ── Hook-health dispatch (HOOK_SYSTEM_DESIGN.md §B), via the P1 central
//    applier (plans/p1-hook-spool-multi-transport.md §2) ─────────────────

/** Build a fresh v7-shaped event record for the applier tests. */
function hookEvent(
  state: 'idle' | 'working' | 'active',
  overrides: Partial<import('./index').ParsedHookEvent> = {},
): import('./index').ParsedHookEvent {
  const source = state === 'working' ? 'hook-start' : state === 'active' ? 'hook-session-start' : 'hook-stop';
  const hookEventName = state === 'working' ? 'UserPromptSubmit' : state === 'active' ? 'SessionStart' : 'Stop';
  return { v: 1, state, source, ts: Date.now(), hookEventName, ...overrides };
}

/** Capture the monitor's status-flip calls (forceIdle / string-overload
 *  forceWorking) so dispatch + provenance can be asserted without driving
 *  the full StatusMonitor write path. */
function captureFlips(h: Harness): Array<{ flip: string; source: string }> {
  const flips: Array<{ flip: string; source: string }> = [];
  const monitor = (h.supervisor as unknown as {
    monitor: {
      forceIdle: (id: string, source: string) => void;
      forceWorking: (id: string, optsOrSource: unknown) => void;
    };
  }).monitor;
  monitor.forceIdle = (_id, source) => { flips.push({ flip: 'idle', source }); };
  monitor.forceWorking = (_id, optsOrSource) => {
    const source = typeof optsOrSource === 'string'
      ? optsOrSource
      : (optsOrSource as { source: string }).source;
    flips.push({ flip: 'working', source });
  };
  return flips;
}

test('Hook: applied idle event stamps hook_status=healthy + last_hook_event_at', () => {
  const agent = makeAgent('hh-1', {
    provider: 'codex',
    status: 'idle',
    isSupervised: true,
    command: 'codex',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'precondition: hook_status unknown');
    const result = h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle'), 'http');
    assert.equal(result, 'applied');
    assert.equal(agent.hookStatus, 'healthy', 'a Stop hook proves the scaffold loaded → healthy');
    assert.ok(typeof agent.lastHookEventAt === 'number' && agent.lastHookEventAt > 0, 'last_hook_event_at stamped');
  } finally {
    h.cleanup();
  }
});

test('Hook: applied SessionStart (active) stamps healthy but does NOT change status', () => {
  // A SessionStart hook on a still-launching worker must update hook health
  // only. It must NOT promote launching→idle (that's the Stop hook's job).
  const agent = makeAgent('hh-2', {
    provider: 'codex',
    status: 'launching',
    isSupervised: true,
    command: 'codex',
    workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    const result = h.supervisor.applyHookStatusEvent(agent.id, hookEvent('active'), 'http');
    assert.equal(result, 'applied');
    assert.equal(agent.status, 'launching', 'session-start must NOT change status');
    assert.equal(agent.hookStatus, 'healthy', 'session-start proves the scaffold loaded → healthy');
    assert.ok(
      !seedCalls(h.calls).some((c) => c.startsWith('forceWorking:')),
      `session-start must not flip the agent to working; got ${JSON.stringify(seedCalls(h.calls))}`,
    );
  } finally {
    h.cleanup();
  }
});

// ── applyHookStatusEvent unit battery (P1 plan §5 E3) ──────────────────

function monitorOf(h: Harness): {
  getLastHookEventAt(id: string): number | undefined;
  getLastStartHookEventAt(id: string): number | undefined;
  recordHookCanary(id: string, ts?: number): void;
  isHookCanaryArmed(id: string): boolean;
} {
  return (h.supervisor as unknown as { monitor: ReturnType<typeof monitorOf> }).monitor;
}

test('applyHookStatusEvent: validation rejections → invalid, no stamp, no flip', () => {
  const agent = makeAgent('av-1', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    // Mismatched self-reported agentId.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { agentId: 'someone-else' }), 'http'),
      'invalid');
    // Non-finite ts.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: NaN }), 'http'),
      'invalid');
    // Unknown state.
    assert.equal(
      h.supervisor.applyHookStatusEvent(
        agent.id, hookEvent('idle', { state: 'bogus' as 'idle' }), 'http'),
      'invalid');
    // Unknown agent.
    assert.equal(
      h.supervisor.applyHookStatusEvent('no-such-agent', hookEvent('idle'), 'http'),
      'invalid');

    assert.equal(monitorOf(h).getLastHookEventAt(agent.id), undefined, 'invalid events never stamp');
    assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'invalid events never flip hook health');
    assert.deepStrictEqual(flips, [], 'invalid events never dispatch a status flip');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: duplicate via a second transport does NOT advance hook-silence clocks (masking guard)', () => {
  const agent = makeAgent('av-2', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    const ev = hookEvent('working', { turnId: 't-1' });
    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, ev, 'http'), 'applied');
    const stampedHook = monitorOf(h).getLastHookEventAt(agent.id);
    const stampedStart = monitorOf(h).getLastStartHookEventAt(agent.id);
    const stampedRow = agent.lastHookEventAt;
    assert.ok(typeof stampedHook === 'number');
    assert.ok(typeof stampedStart === 'number');
    assert.equal(flips.length, 1);

    // Same record arrives via the spool — identical key → duplicate, and the
    // silence clocks must NOT refresh (a re-read must never become a fresh
    // heartbeat that masks hook silence).
    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, { ...ev }, 'spool'), 'duplicate');
    assert.equal(monitorOf(h).getLastHookEventAt(agent.id), stampedHook, 'lastHookEventAt unchanged on duplicate');
    assert.equal(monitorOf(h).getLastStartHookEventAt(agent.id), stampedStart, 'lastStartHookEventAt unchanged on duplicate');
    assert.equal(agent.lastHookEventAt, stampedRow, 'persisted last_hook_event_at unchanged on duplicate');
    assert.equal(flips.length, 1, 'no second status flip on duplicate');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: duplicate with hook_status=unknown → healthy WITHOUT timestamp + canary disarm', () => {
  const agent = makeAgent('av-3', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    const ev = hookEvent('idle', { turnId: 't-dup' });
    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, ev, 'http'), 'applied');
    const stampedRow = agent.lastHookEventAt;

    // Simulate the agent row losing its health verdict while the in-process
    // dedupe registry still has the key (e.g. an external hook_status reset).
    agent.hookStatus = 'unknown';
    monitorOf(h).recordHookCanary(agent.id);

    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, { ...ev }, 'tmux-option'), 'duplicate');
    assert.equal(agent.hookStatus, 'healthy',
      'a duplicate is proof the scaffold loaded → healthy-when-unknown side effect');
    assert.equal(agent.lastHookEventAt, stampedRow,
      'healthy-when-unknown must NOT carry a timestamp (no heartbeat refresh)');
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), false, 'duplicate disarms the canary');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: applied events stamp with receivedAt (host clock), not event ts', () => {
  const agent = makeAgent('av-4', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  captureFlips(h);
  try {
    const skewedTs = Date.now() - 60_000; // event clock 1 min behind host
    const before = Date.now();
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('working', { ts: skewedTs }), 'http'),
      'applied');
    const after = Date.now();
    const stamped = monitorOf(h).getLastHookEventAt(agent.id)!;
    assert.ok(stamped >= before && stamped <= after,
      `stamp must be the applier's host clock (${before}..${after}); got ${stamped}`);
    assert.notEqual(stamped, skewedTs, 'the event ts must never be the stamp');
    const startStamped = monitorOf(h).getLastStartHookEventAt(agent.id)!;
    assert.ok(startStamped >= before && startStamped <= after, 'start-hook stamp also uses receivedAt');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: ordering guard — older ts than an applied event → stale, no stamp advance', () => {
  const agent = makeAgent('av-5', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    const tNew = Date.now();
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('working', { ts: tNew, turnId: 'a' }), 'http'),
      'applied');
    const stamped = monitorOf(h).getLastHookEventAt(agent.id);

    // A laggy spool read delivers an OLDER event (different key) — stale.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: tNew - 5_000, turnId: 'a' }), 'spool'),
      'stale');
    assert.equal(monitorOf(h).getLastHookEventAt(agent.id), stamped, 'stale events never advance the clocks');
    assert.equal(flips.length, 1, 'stale events never flip status');

    // Equal ts with a DIFFERENT key is allowed (arrival order).
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: tNew, turnId: 'b' }), 'spool'),
      'applied');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: transport→source mapping (http→original, spool→hook-spool, tmux→tmux-pane-option)', () => {
  const agent = makeAgent('av-6', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    const base = Date.now();
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: base, turnId: '1' }), 'http'),
      'applied');
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: base + 1, turnId: '2' }), 'spool'),
      'applied');
    // ts well past the host-clock receivedAt the prior applies persisted to the
    // agent row, so the tmux persisted-last-hook guard can't flake on ms timing.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: base + 60_000, turnId: '3' }), 'tmux-option'),
      'applied');
    assert.deepStrictEqual(flips.map((f) => f.source), [
      'hook-stop',          // http keeps the ORIGINAL hook source (pre-P1 byte-identical)
      'hook-spool',         // §5.1 source name for the spool channel
      'tmux-pane-option',   // §5.1 source name for the tmux channel
    ]);
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: legacy body bypasses dedupe/freshness/ordering', () => {
  const agent = makeAgent('av-7', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    const ev = hookEvent('idle', { legacy: true, turnId: undefined });
    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, ev, 'http'), 'applied');
    // Identical legacy record again — NOT deduped (today's v≤6 behavior).
    assert.equal(h.supervisor.applyHookStatusEvent(agent.id, { ...ev }, 'http'), 'applied');
    assert.equal(flips.length, 2, 'legacy events always dispatch');
  } finally {
    h.cleanup();
  }
});

// ── Notification → waiting hook (plans/hook-driven-waiting-status.md §2,
//    Step 8 dispatch) ────────────────────────────────────────────────────

/** Build a v8-shaped `waiting` event (state:'waiting', source 'hook-notification',
 *  hookEventName 'Notification'). Kept separate from `hookEvent` because the
 *  latter's `state` param is the pre-waiting union. */
function waitingHookEvent(
  overrides: Partial<import('./index').ParsedHookEvent> = {},
): import('./index').ParsedHookEvent {
  return {
    v: 1,
    state: 'waiting',
    source: 'hook-notification',
    ts: Date.now(),
    hookEventName: 'Notification',
    ...overrides,
  };
}

/** Capture monitor.forceWaiting(agentId, kind, excerpt) calls without driving
 *  the real StatusMonitor waiting-latch write. */
function captureWaiting(h: Harness): Array<{ id: string; kind: string; excerpt: string }> {
  const waits: Array<{ id: string; kind: string; excerpt: string }> = [];
  const monitor = (h.supervisor as unknown as {
    monitor: { forceWaiting: (id: string, kind: string, excerpt: string) => void };
  }).monitor;
  monitor.forceWaiting = (id, kind, excerpt) => { waits.push({ id, kind, excerpt }); };
  return waits;
}

test('applyHookStatusEvent: a waiting event is ACCEPTED (not invalid)', () => {
  const agent = makeAgent('wt-1', { provider: 'claude', status: 'working', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  captureWaiting(h);
  try {
    assert.equal(
      h.supervisor.applyHookStatusEvent(
        agent.id, waitingHookEvent({ waitingExcerpt: 'Bash tool requires permission' }), 'http'),
      'applied',
      'a state:waiting Notification event must be accepted, not rejected as unknown state');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: waiting dispatches forceWaiting(agentId, "notification", excerpt); no start-hook stamp; step-7 health runs', () => {
  // step-7 (health/canary/heartbeat) MUST run for a waiting event — it's a
  // valid hook heartbeat proving the scaffold loaded — but recordStartHookEventAt
  // must NOT (a wait is not a turn-start, must not satisfy the submit-confirm
  // comparison).
  const agent = makeAgent('wt-2', { provider: 'claude', status: 'working', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const waits = captureWaiting(h);

  // Arm the canary + spy on recordStartHookEventAt so we can assert it's NOT
  // advanced by a waiting event.
  const monitor = (h.supervisor as unknown as {
    monitor: { recordStartHookEventAt: (id: string, ts: number) => void };
  }).monitor;
  const startBefore = monitorOf(h).getLastStartHookEventAt(agent.id);
  let startHookStamped = false;
  const realStart = monitor.recordStartHookEventAt.bind(monitor);
  monitor.recordStartHookEventAt = (id: string, ts: number) => {
    startHookStamped = true;
    realStart(id, ts);
  };

  try {
    agent.hookStatus = 'unknown';
    monitorOf(h).recordHookCanary(agent.id);
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), true, 'precondition: canary armed');

    const result = h.supervisor.applyHookStatusEvent(
      agent.id,
      waitingHookEvent({ waitingExcerpt: 'Choose an option', notificationType: 'permission_prompt' }),
      'http');
    assert.equal(result, 'applied');

    // Dispatch: forceWaiting with the 'notification' kind and the threaded excerpt.
    assert.deepStrictEqual(waits, [{ id: agent.id, kind: 'notification', excerpt: 'Choose an option' }],
      'a blocking waiting (permission_prompt) must dispatch monitor.forceWaiting(agentId, "notification", excerpt)');

    // recordStartHookEventAt NOT called for waiting (gated to state==='working').
    assert.equal(startHookStamped, false, 'a waiting event must NOT stamp the start-hook clock');
    assert.equal(monitorOf(h).getLastStartHookEventAt(agent.id), startBefore,
      'start-hook clock unchanged by a waiting event');

    // step-7 health side effects DID run (waiting is a healthy heartbeat).
    assert.equal(agent.hookStatus, 'healthy', 'waiting promotes hook_status to healthy (scaffold loaded)');
    assert.ok(typeof agent.lastHookEventAt === 'number' && agent.lastHookEventAt > 0,
      'waiting stamps last_hook_event_at (heartbeat)');
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), false, 'waiting clears the hook canary');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: waiting with no excerpt → forceWaiting excerpt defaults to empty string', () => {
  const agent = makeAgent('wt-3', { provider: 'claude', status: 'working', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const waits = captureWaiting(h);
  try {
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, waitingHookEvent(), 'http'),
      'applied');
    assert.deepStrictEqual(waits, [{ id: agent.id, kind: 'notification', excerpt: '' }],
      'a waiting event without an excerpt passes "" (event.waitingExcerpt ?? "")');
  } finally {
    h.cleanup();
  }
});

test('applyHookStatusEvent: idle_prompt waiting → forceWaiting NOT called, but step-7 health stamp + canary clear DID run', () => {
  // idle-vs-waiting fix: an idle reminder (notification_type 'idle_prompt') is a
  // valid liveness heartbeat (steps 1-7 run: health → healthy, canary cleared,
  // last_hook_event_at stamped) but MUST NOT flip the card to 'waiting'.
  const agent = makeAgent('wt-idle', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const waits = captureWaiting(h);
  try {
    agent.hookStatus = 'unknown';
    monitorOf(h).recordHookCanary(agent.id);
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), true, 'precondition: canary armed');

    const result = h.supervisor.applyHookStatusEvent(
      agent.id,
      waitingHookEvent({ waitingExcerpt: 'Claude is waiting for your input', notificationType: 'idle_prompt' }),
      'http');
    assert.equal(result, 'applied', 'the idle reminder is still ACCEPTED as a heartbeat');

    // The load-bearing assertion: no waiting flip.
    assert.deepStrictEqual(waits, [], 'idle_prompt must NOT dispatch forceWaiting');

    // But step-7 liveness side effects DID run.
    assert.equal(agent.hookStatus, 'healthy', 'idle reminder still promotes hook_status to healthy');
    assert.ok(typeof agent.lastHookEventAt === 'number' && agent.lastHookEventAt > 0,
      'idle reminder still stamps last_hook_event_at (heartbeat)');
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), false, 'idle reminder still clears the hook canary');
  } finally {
    h.cleanup();
  }
});

// ── Tmux-option freshness gate (P1 plan §2 step 4a / §5 E3) ────────────

test('tmux gate: restart-shaped failure — old option on a fresh process → stale, nothing stamped, canary stays armed', () => {
  // Supervisor constructed fresh (empty dedupe/ordering maps — exactly the
  // post-restart shape), agent live, persisted lastHookEventAt unset,
  // hook_status unknown, canary armed. A valid-looking tmux-option event
  // 11 min old must be rejected by the bounded-age gate.
  const agent = makeAgent('tg-1', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    monitorOf(h).recordHookCanary(agent.id);
    const result = h.supervisor.applyHookStatusEvent(
      agent.id, hookEvent('working', { ts: Date.now() - 11 * 60_000 }), 'tmux-option');
    assert.equal(result, 'stale');
    assert.deepStrictEqual(flips, [], 'status unflipped');
    assert.equal(monitorOf(h).getLastHookEventAt(agent.id), undefined, 'lastHookEventAt unstamped');
    assert.equal(agent.hookStatus ?? 'unknown', 'unknown', 'hook_status still unknown — stale proves nothing');
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), true, 'canary still armed');
  } finally {
    h.cleanup();
  }
});

test('tmux gate: persisted last-hook guard — option older than the agent row lastHookEventAt → stale', () => {
  const T = Date.now() - 60_000; // last hook (persisted) 1 min ago
  const agent = makeAgent('tg-2', {
    provider: 'claude', status: 'idle', isWorker: true, lastHookEventAt: T,
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    // Younger than the 10-min age bound but ≤ the persisted last hook → stale.
    const result = h.supervisor.applyHookStatusEvent(
      agent.id, hookEvent('idle', { ts: T - 5_000 }), 'tmux-option');
    assert.equal(result, 'stale');
    assert.deepStrictEqual(flips, []);
  } finally {
    h.cleanup();
  }
});

test('tmux gate: current-launch guard — option predating the launch stamp → stale; newer → applied', () => {
  const agent = makeAgent('tg-3', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    const T = Date.now() - 30_000;
    (h.supervisor as unknown as { launchStartedAt: Map<string, number> })
      .launchStartedAt.set(agent.id, T);

    // Clearly before the launch (beyond the 2 s skew tolerance) → stale.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: T - 5_000 }), 'tmux-option'),
      'stale');
    assert.deepStrictEqual(flips, []);

    // After the launch, passing the other gates → applied.
    assert.equal(
      h.supervisor.applyHookStatusEvent(agent.id, hookEvent('idle', { ts: T + 5_000 }), 'tmux-option'),
      'applied');
    assert.deepStrictEqual(flips, [{ flip: 'idle', source: 'tmux-pane-option' }]);
  } finally {
    h.cleanup();
  }
});

test('tmux gate: control — fresh option passing all three gates → applied with source tmux-pane-option', () => {
  const agent = makeAgent('tg-4', { provider: 'claude', status: 'idle', isWorker: true });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  const flips = captureFlips(h);
  try {
    monitorOf(h).recordHookCanary(agent.id);
    const result = h.supervisor.applyHookStatusEvent(
      agent.id, hookEvent('idle', { ts: Date.now() }), 'tmux-option');
    assert.equal(result, 'applied');
    assert.deepStrictEqual(flips, [{ flip: 'idle', source: 'tmux-pane-option' }]);
    assert.equal(agent.hookStatus, 'healthy');
    assert.equal(monitorOf(h).isHookCanaryArmed(agent.id), false, 'applied event disarms the canary');
  } finally {
    h.cleanup();
  }
});

// ── Submit confirmation contract (plan §1, C1, §SCOPE predicate) ───────

test('usesSubmitConfirmation matrix: claude worker yes; broken no; codex needs observed start hook; gemini/non-worker no', () => {
  const agent = makeAgent('uc-1', { provider: 'claude', isSupervised: true, status: 'idle' });
  const h = setup({ agent, injectRunner: 'windows', alive: true });
  try {
    const sup = h.supervisor;
    // Claude worker — contract (full throwing path).
    assert.equal(sup.usesSubmitConfirmation(
      makeAgent('c-ok', { provider: 'claude', isWorker: true })), true,
      'claude worker uses the throwing contract');
    // Claude with a broken scaffold — fall back, never throw on an agent that
    // can't confirm.
    assert.equal(sup.usesSubmitConfirmation(
      makeAgent('c-broken', { provider: 'claude', isWorker: true, hookStatus: 'broken' })), false,
      'claude with broken hook scaffold falls back (no throw)');
    // Codex worker BEFORE any start hook observed — fall back (reactive resend).
    const codex = makeAgent('cx-1', { provider: 'codex', isWorker: true });
    assert.equal(sup.usesSubmitConfirmation(codex), false,
      'codex without an observed start hook falls back to reactive resend');
    // Codex worker AFTER its start hook fires for this launch — promote to contract.
    const monitor = (sup as unknown as { monitor: { recordStartHookEventAt: (id: string, ts: number) => void } }).monitor;
    monitor.recordStartHookEventAt(codex.id, 1234);
    assert.equal(sup.usesSubmitConfirmation(codex), true,
      'codex with an observed start hook uses the contract (Q6 self-test passed)');
    // Gemini worker — no authoritative start marker → never contract (never throw).
    assert.equal(sup.usesSubmitConfirmation(
      makeAgent('g-1', { provider: 'gemini', isWorker: true })), false,
      'gemini stays on the reactive/inference fallback — never throws');
    // Non-worker claude — out of the worker lane entirely.
    assert.equal(sup.usesSubmitConfirmation(
      makeAgent('n-1', { provider: 'claude', isSupervised: false, isWorker: false })), false,
      'non-worker agents do not use the submit-confirmation contract');
  } finally {
    h.cleanup();
  }
});

test('Case 10: confirm exhaustion on a contract claude worker throws + sets lastSendError; no notify', async () => {
  const agent = makeAgent('cc-fail', {
    provider: 'claude', status: 'idle', isWorker: true,
    command: 'claude', workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true, confirmResult: false });
  try {
    await assert.rejects(
      () => h.supervisor.sendInput(agent.id, 'hi', { submit: true }),
      (err: unknown) => err instanceof SubmitNotConfirmedError && (err as SubmitNotConfirmedError).agentId === agent.id,
      'exhausted confirm rejects with SubmitNotConfirmedError carrying the agent id',
    );
    assert.ok(h.calls.includes('confirmSubmission'), 'the contract path engaged');
    assert.ok(agent.lastSendError && /Submit not confirmed/.test(agent.lastSendError.message),
      `lastSendError persisted on exhaustion; got ${JSON.stringify(agent.lastSendError)}`);
    assert.ok(typeof agent.lastSendError?.ts === 'number', 'lastSendError carries a ts');
    assert.ok(!seedCalls(h.calls).includes('notifyUserInputDelivered'),
      'a failed submit must not run the delivered-side-effects');
  } finally {
    h.cleanup();
  }
});

test('Case 11: confirmed submit on a contract claude worker clears a stale lastSendError', async () => {
  const agent = makeAgent('cc-ok', {
    provider: 'claude', status: 'idle', isWorker: true,
    command: 'claude', workingDirectory: 'C:\\tmp',
    lastSendError: { message: 'old failure', ts: 1 },
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true, confirmResult: true });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    assert.ok(h.calls.includes('confirmSubmission'), 'the contract path engaged');
    assert.equal(agent.lastSendError, null, 'a confirmed submit clears the stale lastSendError');
    assert.ok(seedCalls(h.calls).includes('notifyUserInputDelivered'),
      'a confirmed submit runs the delivered-side-effects');
  } finally {
    h.cleanup();
  }
});

test('Case 13 (FIX-3): recordInputDelivered is stamped BEFORE the synchronous confirm wait', async () => {
  // `lastInputDeliveredAt` must be recorded the moment the body+Enter is
  // written, NOT after `_doSendInput` resolves — `confirmSubmission` waits
  // inside `_doSendInput` and the UserPromptSubmit hook lands DURING that
  // wait, so a post-resolve stamp lands AFTER the observed hook timestamp and
  // checkStartHookSilence reads a confirmed turn as a missed start hook.
  const agent = makeAgent('cc-order', {
    provider: 'claude', status: 'idle', isWorker: true,
    command: 'claude', workingDirectory: 'C:\\tmp',
  });
  const h = setup({ agent, injectRunner: 'windows', alive: true, confirmResult: true });
  const monitor = (h.supervisor as unknown as {
    monitor: { recordInputDelivered: (id: string, ts?: number) => void };
  }).monitor;
  const realRecord = monitor.recordInputDelivered.bind(monitor);
  monitor.recordInputDelivered = (id: string, ts?: number) => {
    h.calls.push('recordInputDelivered');
    realRecord(id, ts);
  };
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    const recordIdx = h.calls.indexOf('recordInputDelivered');
    const confirmIdx = h.calls.indexOf('confirmSubmission');
    assert.ok(recordIdx !== -1, `recordInputDelivered must fire; calls=${JSON.stringify(h.calls)}`);
    assert.ok(confirmIdx !== -1, `the contract confirm path must engage; calls=${JSON.stringify(h.calls)}`);
    assert.ok(
      recordIdx < confirmIdx,
      `lastInputDeliveredAt must be stamped before the confirm wait; calls=${JSON.stringify(h.calls)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('Case 12: gemini worker never enters the confirm path (no throw, normal delivery)', async () => {
  const agent = makeAgent('g-worker', {
    provider: 'gemini', status: 'idle', isWorker: true,
    command: 'gemini', workingDirectory: 'C:\\tmp',
  });
  // confirmResult:false would throw IF the path engaged — it must NOT for gemini.
  const h = setup({ agent, injectRunner: 'windows', alive: true, confirmResult: false });
  try {
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
    assert.ok(!h.calls.includes('confirmSubmission'),
      'gemini must never reach the throwing confirm path');
    assert.ok(seedCalls(h.calls).includes('notifyUserInputDelivered'),
      'gemini delivery proceeds via the fallback lane');
  } finally {
    h.cleanup();
  }
});

// ── Researcher role-lane launch arg-set (WP-B STEP 5) ────────────────
// Inspect the exact flags the researcher launch builds: browser-only toolset,
// --strict-mcp-config, --tools WITHOUT Bash/Edit/NotebookEdit, --disallowedTools
// listing them, cwd = .dashboard/researcher, and --add-dir of the research store.

test('Case R1: Windows researcher launch arg-set (toolset=browser, strict, --tools/--disallowedTools, store --add-dir)', async () => {
  // Real temp workspace so the --append-system-prompt-file write succeeds and is
  // assertable, and nothing pollutes a fixed path.
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-rsch-win-'));
  const cwd = path.join(wsRoot, '.dashboard', 'researcher');
  fs.mkdirSync(cwd, { recursive: true });
  const agent = makeAgent('rsch-win', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: true,
    command: 'claude --dangerously-skip-permissions',
    workingDirectory: cwd,
  });
  const h = setup({ agent, injectRunner: 'none' });

  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  let capturedArgs: string[] = [];
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string,
    _cmd: string,
    args: string[],
  ) {
    capturedArgs = args;
    (this as unknown as { _pid: number; _alive: boolean })._pid = 1;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };

  try {
    await (h.supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);

    const joined = capturedArgs.join(' ');

    // Strict containment.
    assert.ok(capturedArgs.includes('--strict-mcp-config'),
      `researcher must launch --strict-mcp-config; got: ${joined}`);

    // Browser-only dashboard toolset, in the inline --mcp-config JSON.
    const mcpIdx = capturedArgs.indexOf('--mcp-config');
    assert.ok(mcpIdx !== -1, 'researcher must get an inline --mcp-config');
    assert.ok(/"DASHBOARD_MCP_TOOLSETS":"browser"/.test(capturedArgs[mcpIdx + 1]),
      `researcher dashboard toolset must be browser-only; got: ${capturedArgs[mcpIdx + 1]}`);

    // Native --tools allowlist — has the research/browse tools, NOT Bash/Edit/etc.
    const toolsIdx = capturedArgs.indexOf('--tools');
    assert.ok(toolsIdx !== -1, 'researcher must pass --tools');
    const toolsVal = capturedArgs[toolsIdx + 1];
    for (const t of ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'Task', 'Skill', 'Write', 'mcp__agent-dashboard__browser_*', 'mcp__claude-in-chrome__*']) {
      assert.ok(toolsVal.split(',').includes(t), `--tools must offer ${t}; got: ${toolsVal}`);
    }
    // claude-in-chrome is the researcher's de-emphasized fallback browser —
    // granted to THIS lane only (and never to any other lane).
    assert.ok(toolsVal.split(',').includes('mcp__claude-in-chrome__*'),
      `--tools must offer claude-in-chrome (researcher fallback browser); got: ${toolsVal}`);
    for (const banned of ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(!toolsVal.split(',').includes(banned), `--tools must NOT offer ${banned}; got: ${toolsVal}`);
    }

    // Model pin — researcher runs on Sonnet (worker/supervisor untouched).
    const modelIdx = capturedArgs.indexOf('--model');
    assert.ok(modelIdx !== -1, 'researcher must pass --model');
    assert.equal(capturedArgs[modelIdx + 1], 'claude-sonnet-4-6',
      `researcher --model must be claude-sonnet-4-6; got: ${capturedArgs[modelIdx + 1]}`);

    // Belt-and-suspenders --disallowedTools.
    const disIdx = capturedArgs.indexOf('--disallowedTools');
    assert.ok(disIdx !== -1, 'researcher must pass --disallowedTools');
    const disVal = capturedArgs[disIdx + 1].split(',');
    for (const banned of ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(disVal.includes(banned), `--disallowedTools must list ${banned}; got: ${disVal}`);
    }

    // --add-dir of the research store (NOT the workspace root).
    const expectedStore = path.join(wsRoot, '.dashboard', 'research');
    const addDirIdx = capturedArgs.indexOf('--add-dir');
    assert.ok(addDirIdx !== -1, 'researcher must pass --add-dir');
    assert.equal(capturedArgs[addDirIdx + 1], expectedStore,
      `researcher --add-dir must target the research store; got: ${capturedArgs[addDirIdx + 1]}`);

    // Workspace-root preamble file present.
    assert.ok(capturedArgs.includes('--append-system-prompt-file'),
      'researcher must get the workspace-root/untrusted-store preamble');

    // cwd is the researcher persona folder.
    assert.ok(/\.dashboard[\\/]researcher$/.test(agent.workingDirectory),
      `researcher cwd must be .dashboard/researcher; got: ${agent.workingDirectory}`);
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
    h.cleanup();
    try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('Case R2: WSL researcher launch command (toolset=browser, strict, --tools/--disallowedTools, store --add-dir)', async () => {
  const agent = makeAgent('rsch-wsl', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: true,
    command: 'ccode --dangerously-skip-permissions',
    workingDirectory: '/home/test/.dashboard/researcher',
    tmuxSessionName: 'agent-rsch-wsl',
  });
  const h = setup({ agent, injectRunner: 'none' });

  const setupStubLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  const captured: string[] = [];
  (WslRunner.prototype as { launch: unknown }).launch = async function (
    this: WslRunner,
    _workDir: string,
    command: string,
  ) {
    captured.push(command);
    (this as unknown as { _alive: boolean })._alive = true;
  };

  try {
    await (h.supervisor as unknown as { launchWslAgent: (a: Agent) => Promise<void> })
      .launchWslAgent(agent);

    assert.equal(captured.length, 1, 'expected exactly one launch call');
    const rendered = captured[0];

    assert.ok(rendered.includes('--strict-mcp-config'),
      `WSL researcher must be strict; got: ${rendered}`);
    assert.ok(/"DASHBOARD_MCP_TOOLSETS":"browser"/.test(rendered),
      `WSL researcher dashboard toolset must be browser-only; got: ${rendered}`);
    assert.ok(rendered.includes("--tools 'WebSearch,WebFetch,Read,Grep,Glob,Task,Skill,Write,mcp__agent-dashboard__browser_*,mcp__claude-in-chrome__*'"),
      `WSL researcher --tools must be the single-quoted allowlist (browser_* primary + claude-in-chrome fallback); got: ${rendered}`);
    assert.ok(rendered.includes("--disallowedTools 'Bash,Edit,MultiEdit,NotebookEdit'"),
      `WSL researcher --disallowedTools must list the dangerous built-ins; got: ${rendered}`);
    assert.ok(rendered.includes('--model claude-sonnet-4-6'),
      `WSL researcher must be pinned to Sonnet; got: ${rendered}`);
    assert.ok(rendered.includes("--add-dir '/home/test/.dashboard/research'"),
      `WSL researcher --add-dir must target the research store; got: ${rendered}`);
    // Containment: the dangerous tools must not appear in the --tools allowlist.
    const toolsMatch = rendered.match(/--tools '([^']*)'/);
    assert.ok(toolsMatch, 'should find --tools value');
    for (const banned of ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(!toolsMatch![1].split(',').includes(banned), `--tools must not offer ${banned}`);
    }
  } finally {
    (WslRunner.prototype as { launch: unknown }).launch = setupStubLaunch;
    h.cleanup();
  }
});

// ── Env/spool gate: roleLaneOf !== 'legacy' (plans/hook-driven-waiting-status.md
//    Step 5) ──────────────────────────────────────────────────────────────
// The five env/spool gates moved from `isSupervised || isWorker || isResearcher`
// to `roleLaneOf(agent) !== 'legacy'`, so a real supervisor (isSupervisor:true)
// AND a supervisor-privilege persona (privilegeLane:'supervisor', isSupervisor
// false) now BOTH receive AGENT_ID + DASHBOARD_PORT + DASHBOARD_SPOOL_PATH +
// a spool tailer + usesSubmitConfirmation===true.
//
// Bug 2 / Edit 2.6 broadened the env/spool gate further to
// `roleLaneOf(agent) !== 'legacy' || isCodexHookPersona(agent)`: a legacy
// CLAUDE persona (no role flags, no lane) still gets NONE (it falls back to PTY
// status inference), but a hook-instrumented CODEX persona — provider:'codex'
// with wantsCodexHooks persisted — DOES now get the env + spool tailer even
// though it is roleLaneOf==='legacy', or its codex hook script would bail at
// `if (!agentId) return;`.

/** Drive launchWindowsAgent and capture the extraEnv (6th launch arg) the
 *  gate injects, plus whether ensureSpoolTailer registered this agent. Stubs
 *  ensureSpoolTailer to a recorder so the real (fs-touching) tailer never spins
 *  up — the gate predicate it shares with the env block is what we observe. */
async function launchAndCaptureEnv(h: Harness, agent: Agent): Promise<{
  extraEnv: Record<string, string> | undefined;
  spoolTailerAgents: string[];
}> {
  const spoolTailerAgents: string[] = [];
  (h.supervisor as unknown as { ensureSpoolTailer: (a: Agent) => void }).ensureSpoolTailer =
    (a: Agent) => { spoolTailerAgents.push(a.id); };

  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  let capturedEnv: Record<string, string> | undefined;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _workDir: string,
    _cmd: string,
    _args: string[],
    _logPath: string,
    _directSpawn?: boolean,
    extraEnv?: Record<string, string>,
  ) {
    capturedEnv = extraEnv;
    (this as unknown as { _pid: number; _alive: boolean })._pid = 1;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  try {
    await (h.supervisor as unknown as { launchWindowsAgent: (a: Agent) => Promise<void> })
      .launchWindowsAgent(agent);
  } finally {
    (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
  }
  return { extraEnv: capturedEnv, spoolTailerAgents };
}

test('Env-gate: a supervisor launch (isSupervisor:true) receives AGENT_ID/DASHBOARD_PORT/DASHBOARD_SPOOL_PATH + spool tailer + submit-confirm', async () => {
  const agent = makeAgent('eg-sup', {
    provider: 'claude',
    isSupervisor: true,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    command: 'claude --dangerously-skip-permissions',
    workingDirectory: 'C:\\tmp\\.dashboard\\supervisor',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    assert.ok(extraEnv, 'supervisor launch must inject extraEnv');
    assert.equal(extraEnv!.AGENT_ID, agent.id, 'supervisor must receive AGENT_ID');
    assert.equal(extraEnv!.DASHBOARD_PORT, String((h.supervisor as unknown as { apiServerPort: number }).apiServerPort),
      'supervisor must receive DASHBOARD_PORT');
    assert.ok(typeof extraEnv!.DASHBOARD_SPOOL_PATH === 'string' && extraEnv!.DASHBOARD_SPOOL_PATH.length > 0,
      'supervisor must receive DASHBOARD_SPOOL_PATH');
    assert.ok(spoolTailerAgents.includes(agent.id), 'supervisor must register a spool tailer');
    assert.equal(h.supervisor.usesSubmitConfirmation(agent), true,
      'supervisor (claude, non-legacy lane) uses the submit-confirmation contract');
  } finally {
    h.cleanup();
  }
});

test('Env-gate: a supervisor-privilege persona (privilegeLane:"supervisor", isSupervisor:false) ALSO passes the gate', async () => {
  const agent = makeAgent('eg-persona', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    privilegeLane: 'supervisor',
    command: 'claude --dangerously-skip-permissions',
    workingDirectory: 'C:\\tmp\\.dashboard\\agents\\orchestrator',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    assert.ok(extraEnv, 'supervisor-privilege persona must inject extraEnv');
    assert.equal(extraEnv!.AGENT_ID, agent.id, 'persona must receive AGENT_ID');
    assert.equal(extraEnv!.DASHBOARD_PORT, String((h.supervisor as unknown as { apiServerPort: number }).apiServerPort),
      'persona must receive DASHBOARD_PORT');
    assert.ok(typeof extraEnv!.DASHBOARD_SPOOL_PATH === 'string' && extraEnv!.DASHBOARD_SPOOL_PATH.length > 0,
      'persona must receive DASHBOARD_SPOOL_PATH');
    assert.ok(spoolTailerAgents.includes(agent.id), 'persona must register a spool tailer');
    assert.equal(h.supervisor.usesSubmitConfirmation(agent), true,
      'a privilegeLane:supervisor persona is non-legacy → uses the submit-confirmation contract');
  } finally {
    h.cleanup();
  }
});

test('Env-gate: a legacy CLAUDE persona (no role flags, no lane) receives NONE of the env/spool/submit-confirm', async () => {
  const agent = makeAgent('eg-legacy', {
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    // no privilegeLane → roleLaneOf === 'legacy'; claude → isCodexHookPersona false
    command: 'claude --dangerously-skip-permissions',
    workingDirectory: 'C:\\tmp\\.dashboard\\agents\\plain',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    // A legacy claude agent still gets the ghost-text disable env var, but NONE
    // of the hook-lane keys. Edit 2.6's escape is codex-only, so a claude persona
    // is unaffected and stays on PTY status inference.
    if (extraEnv) {
      assert.equal(extraEnv.AGENT_ID, undefined, 'legacy claude persona must NOT receive AGENT_ID');
      assert.equal(extraEnv.DASHBOARD_PORT, undefined, 'legacy claude persona must NOT receive DASHBOARD_PORT');
      assert.equal(extraEnv.DASHBOARD_SPOOL_PATH, undefined, 'legacy claude persona must NOT receive DASHBOARD_SPOOL_PATH');
    }
    assert.ok(!spoolTailerAgents.includes(agent.id), 'legacy claude persona must NOT register a spool tailer');
    assert.equal(h.supervisor.usesSubmitConfirmation(agent), false,
      'a legacy-lane claude persona never uses the submit-confirmation contract');
  } finally {
    h.cleanup();
  }
});

test('Env-gate (Bug 2 / Edit 2.6): a PURE codex persona (no lane, wantsCodexHooks) DOES receive AGENT_ID + spool tailer', async () => {
  const agent = makeAgent('eg-codex-persona', {
    provider: 'codex',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    // roleLaneOf === 'legacy' (no lane flags), but the persisted hook flag flips
    // isCodexHookPersona → true so the env gate's Edit-2.6 escape applies.
    wantsCodexHooks: true,
    command: 'codex --profile dashboard-worker --dangerously-bypass-hook-trust',
    workingDirectory: 'C:\\tmp\\.dashboard\\agents\\codex-persona',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    assert.ok(extraEnv, 'codex persona launch must inject extraEnv');
    assert.equal(extraEnv!.AGENT_ID, agent.id,
      'pure codex persona must receive AGENT_ID (else the hook script bails at !agentId)');
    assert.equal(extraEnv!.DASHBOARD_PORT, String((h.supervisor as unknown as { apiServerPort: number }).apiServerPort),
      'pure codex persona must receive DASHBOARD_PORT');
    assert.ok(typeof extraEnv!.DASHBOARD_SPOOL_PATH === 'string' && extraEnv!.DASHBOARD_SPOOL_PATH.length > 0,
      'pure codex persona must receive DASHBOARD_SPOOL_PATH');
    assert.ok(spoolTailerAgents.includes(agent.id), 'pure codex persona must register a spool tailer');
  } finally {
    h.cleanup();
  }
});

test('Env-gate (Bug 2 / Edit 2.6): a WORKER-LANE codex persona also receives AGENT_ID + spool tailer', async () => {
  const agent = makeAgent('eg-codex-worker-persona', {
    provider: 'codex',
    isSupervisor: false,
    isSupervised: false,
    isWorker: true, // worker lane → roleLaneOf non-legacy; passes via the existing arm
    isResearcher: false,
    wantsCodexHooks: true,
    command: 'codex --profile dashboard-worker --dangerously-bypass-hook-trust',
    workingDirectory: 'C:\\tmp\\.dashboard\\workers\\codex',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    assert.ok(extraEnv, 'worker-lane codex persona launch must inject extraEnv');
    assert.equal(extraEnv!.AGENT_ID, agent.id, 'worker-lane codex persona must receive AGENT_ID');
    assert.ok(spoolTailerAgents.includes(agent.id), 'worker-lane codex persona must register a spool tailer');
  } finally {
    h.cleanup();
  }
});

test('Env-gate (Bug 2 / Edit 2.6): a codex agent WITHOUT wantsCodexHooks and no lane gets NONE (flag — not provider — gates it)', async () => {
  const agent = makeAgent('eg-codex-bare', {
    provider: 'codex',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    // wantsCodexHooks omitted → false → isCodexHookPersona false → still legacy.
    command: 'codex',
    workingDirectory: 'C:\\tmp\\.dashboard\\agents\\codex-bare',
  });
  const h = setup({ agent, injectRunner: 'none' });
  try {
    const { extraEnv, spoolTailerAgents } = await launchAndCaptureEnv(h, agent);
    if (extraEnv) {
      assert.equal(extraEnv.AGENT_ID, undefined,
        'a codex agent without the persisted hook flag must NOT receive AGENT_ID');
      assert.equal(extraEnv.DASHBOARD_SPOOL_PATH, undefined,
        'a codex agent without the persisted hook flag must NOT receive DASHBOARD_SPOOL_PATH');
    }
    assert.ok(!spoolTailerAgents.includes(agent.id),
      'a codex agent without the persisted hook flag must NOT register a spool tailer');
  } finally {
    h.cleanup();
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
