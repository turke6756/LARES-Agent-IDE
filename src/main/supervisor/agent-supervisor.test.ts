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
    'updateAgentPid',
    'getAgent',
    'addEvent',
    'updateAgentLastOutput',
    'updateAgentExitCode',
    'getActiveAgents',
    'getAllAgents',
    'getSupervisorAgent',
    'addFileActivity',
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
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;

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
  const monitor = (supervisor as unknown as { monitor: { forceWorking: (id: string, opts: { source: string }) => void } }).monitor;
  monitor.forceWorking = (_id: string, fwOpts: { source: string }) => {
    calls.push(`forceWorking:${fwOpts.source}`);
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
    // sendInput resolves when _doSendInput resolves (regardless of delivered).
    // The contract under test: no latch seed, regardless of submit=true.
    await h.supervisor.sendInput(agent.id, 'hi', { submit: true });
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
    command: 'ccode --dangerously-skip-permissions --chrome',
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

// ── Hook-health dispatch (HOOK_SYSTEM_DESIGN.md §B) ───────────────────

test('Hook: forceIdleFromHook stamps hook_status=healthy + last_hook_event_at', () => {
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
    h.supervisor.forceIdleFromHook(agent.id, 'hook-stop');
    assert.equal(agent.hookStatus, 'healthy', 'a Stop hook proves the scaffold loaded → healthy');
    assert.ok(typeof agent.lastHookEventAt === 'number' && agent.lastHookEventAt > 0, 'last_hook_event_at stamped');
  } finally {
    h.cleanup();
  }
});

test('Hook: recordHookSessionStart stamps healthy but does NOT change status', () => {
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
    h.supervisor.recordHookSessionStart(agent.id, 'hook-session-start');
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
