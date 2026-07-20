// WP-P2 — main-process `initialUserPrompt` seam
// (plans/selection-to-agent-primitive-plan.md §7 WP-P2, rationale §1.6).
//
// Covers:
//   (a) delivery fires exactly once on the FIRST input-accepting status
//       transition (idle|waiting|done) and never again on later ones;
//   (b) an expired pending entry is dropped instead of delivered;
//   (c) the pending entry is cleared on agent stop (and the 'done' emitted by
//       stopAgent does not deliver);
//   (d) the launch-time positional-arg `agentMdPrompt` path is byte-identical
//       with vs without `initialUserPrompt` set — asserted per provider at
//       both seams where the builders differ: the agentMdPrompt value handed
//       to launchWindowsAgent (claude merges systemPrompt; codex/gemini do
//       not), and the actual argv built by launchWindowsAgent (claude carries
//       the prompt as final positional arg; codex/gemini never put it in
//       argv).
//   Plus: accepting transition with no live runner keeps the entry; async
//   delivery failure emits 'sendInputError' (→ 'agent:send-input-error').
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/initial-user-prompt.test.js

import assert from 'node:assert/strict';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, AgentProvider, AgentStatus, LaunchAgentInput, Workspace } from '../../shared/types';
import type { StatusChangedEvent } from './status-events';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── DB module patching ───────────────────────────────────────────────
// Mirrors agent-supervisor.test.ts's patchDb, widened with the functions the
// full launchAgent path touches (getWorkspace, createAgent, getTeamMembership,
// updateAgentResumeSessionId, deleteAgent).
function patchDb(agentsMap: Map<string, Agent>, workspace: Workspace): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition',
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
    'getFileActivities',
    'getWorkspace',
    'createAgent',
    'getTeamMembership',
    'updateAgentResumeSessionId',
    'deleteAgent',
    'insertAgentSession',
    'closeAgentSession',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  let agentSeq = 0;
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentLastSendError = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.getFileActivities = () => [];
  db.getWorkspace = (id: string) => (id === workspace.id ? workspace : null);
  db.createAgent = (data: {
    workspaceId: string;
    title: string;
    roleDescription: string;
    workingDirectory: string;
    command: string;
    provider?: AgentProvider;
    isSupervisor?: boolean;
    isSupervised?: boolean;
    isWorker?: boolean;
    tmuxSessionName?: string | null;
    logPath?: string | null;
    systemPrompt?: string | null;
  }): Agent => {
    const id = `agent-${++agentSeq}`;
    const a = makeAgent(id, {
      workspaceId: data.workspaceId,
      title: data.title,
      provider: data.provider ?? 'claude',
      isSupervisor: !!data.isSupervisor,
      isSupervised: !!data.isSupervised,
      isWorker: !!data.isWorker,
      workingDirectory: data.workingDirectory,
      command: data.command,
      tmuxSessionName: data.tmuxSessionName ?? null,
      logPath: data.logPath ?? null,
      systemPrompt: data.systemPrompt ?? null,
      status: 'launching',
    });
    agentsMap.set(id, a);
    return a;
  };
  db.getTeamMembership = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.deleteAgent = (id: string) => { agentsMap.delete(id); };
  // Phase 1 lineage recording touched by the launchAgent / rebind paths; stub
  // so the real fns don't hit the uninitialized module-level db handle.
  db.insertAgentSession = () => {};
  db.closeAgentSession = () => {};

  // §B3 — status writes route through applyStatusTransition; keep them in the fake.
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);

  return () => {
    for (const k of keys) db[k] = orig[k];
  };
}

// ── Harness ──────────────────────────────────────────────────────────
const AGENT_MD = 'AGENT-MD-CONTENT line 1\nline 2';
const INITIAL_PROMPT = '[SELECTION COMMENT]\nSource: file C:\\doc.md\n\n> quoted\nComment: check this';

interface Harness {
  supervisor: AgentSupervisor;
  agentsMap: Map<string, Agent>;
  workspace: Workspace;
  /** agentMdPrompt values captured by the launchWindowsAgent stub, in call order. */
  capturedMdPrompts: Array<string | null | undefined>;
  /** sendInput calls captured by the instance stub. */
  sendInputCalls: Array<{ agentId: string; text: string }>;
  /** 'sendInputError' supervisor emissions. */
  sendInputErrors: Array<{ agentId: string; error: string }>;
  /** Direct map access for expiry manipulation / assertions. */
  pendingMap(): Map<string, { text: string; expiresAt: number }>;
  emitStatus(agentId: string, status: AgentStatus): void;
  injectWindowsRunner(agentId: string): void;
  cleanup(): void;
}

function setup(opts: { stubLaunch?: boolean; sendInputError?: Error } = {}): Harness {
  const stubLaunch = opts.stubLaunch !== false;
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-p2-'));
  const workspace: Workspace = {
    id: 'ws-1',
    title: 'WS',
    path: wsRoot,
    pathType: 'windows',
    description: '',
    defaultCommand: 'claude',
    createdAt: '2026-06-12T00:00:00Z',
    updatedAt: '2026-06-12T00:00:00Z',
    lastOpenedAt: null,
  };
  const agentsMap = new Map<string, Agent>();
  const restoreDb = patchDb(agentsMap, workspace);

  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as Record<string, unknown>;
  // Suppress writes to ~/.claude/agent-registry.json triggered by emit('statusChanged').
  priv.writeAgentRegistry = () => {};
  // No real provider-config / scaffold writes in tests.
  priv.ensureProviderDirTrust = () => {};
  priv.ensureWorkerScaffold = () => {};
  priv.ensureSupervisorScaffold = () => {};
  priv.ensureCodexHookProfile = () => {};
  priv.ensureMcpConfig = () => {};
  // Deterministic agent.md content (no FS read).
  priv.loadAgentMd = () => AGENT_MD;
  // No post-launch codex session polling.
  priv.captureCodexSessionId = () => {};

  const capturedMdPrompts: Array<string | null | undefined> = [];
  if (stubLaunch) {
    priv.launchWindowsAgent = async (_agent: Agent, _resume?: boolean, agentMdPrompt?: string | null) => {
      capturedMdPrompts.push(agentMdPrompt);
    };
  }

  const sendInputCalls: Array<{ agentId: string; text: string }> = [];
  priv.sendInput = (agentId: string, text: string): Promise<boolean> => {
    sendInputCalls.push({ agentId, text });
    return opts.sendInputError ? Promise.reject(opts.sendInputError) : Promise.resolve(true);
  };

  const sendInputErrors: Array<{ agentId: string; error: string }> = [];
  supervisor.on('sendInputError', (payload: { agentId: string; error: string }) => {
    sendInputErrors.push(payload);
  });

  return {
    supervisor,
    agentsMap,
    workspace,
    capturedMdPrompts,
    sendInputCalls,
    sendInputErrors,
    pendingMap: () =>
      (supervisor as unknown as { pendingInitialPrompts: Map<string, { text: string; expiresAt: number }> })
        .pendingInitialPrompts,
    emitStatus: (agentId, status) => {
      // 'monitor' source mirrors the StatusMonitor re-emission at the
      // supervisor choke-point and keeps the EventBridge listener inert.
      supervisor.emit('statusChanged', { agentId, status, source: 'monitor' } satisfies StatusChangedEvent);
    },
    injectWindowsRunner: (agentId) => {
      const fake = new WindowsRunner();
      Object.defineProperty(fake, 'isAlive', { get: () => true, configurable: true });
      (fake as unknown as { write: (d: string) => void }).write = () => {};
      // §B5 — the double must honor the real runner contract: kill() leads to
      // an 'exit' emission. `stopAgent` now WAITS for that confirmation before
      // it will mark an agent done (a runner that never confirms escalates to
      // verified termination and, failing that, reports an honest 'failed').
      (fake as unknown as { kill: () => void }).kill = () => {
        setImmediate(() => fake.emit('exit', 0, null));
      };
      (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> })
        .windowsRunners.set(agentId, fake);
    },
    cleanup: () => {
      restoreDb();
      try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function launchInput(h: Harness, provider: AgentProvider, extra: Partial<LaunchAgentInput> = {}): LaunchAgentInput {
  return {
    workspaceId: h.workspace.id,
    title: `${provider} worker`,
    provider,
    command: provider,
    isWorker: true,
    autoRestartEnabled: false,
    ...extra,
  };
}

// ── (a) exactly-once delivery ────────────────────────────────────────

test('(a) delivers exactly once on the first accepting transition, not on later ones', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    assert.equal(h.pendingMap().size, 1, 'pending entry stored at launch');
    h.injectWindowsRunner(agent.id);

    // Non-accepting transitions never deliver.
    h.emitStatus(agent.id, 'launching');
    h.emitStatus(agent.id, 'working');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 0, 'no delivery before an accepting status');

    // First accepting transition delivers.
    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 1, 'delivered once on first idle');
    assert.equal(h.sendInputCalls[0].agentId, agent.id);
    assert.equal(h.sendInputCalls[0].text, INITIAL_PROMPT, 'prompt text delivered verbatim');
    assert.equal(h.pendingMap().size, 0, 'entry deleted before send (exactly-once)');

    // Later accepting transitions deliver nothing.
    h.emitStatus(agent.id, 'idle');
    h.emitStatus(agent.id, 'waiting');
    h.emitStatus(agent.id, 'done');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 1, 'no re-delivery on later accepting transitions');
  } finally {
    h.cleanup();
  }
});

test('(a2) accepting transition with no live runner keeps the entry for a later runner', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    // No runner injected — e.g. a runner-exit 'done' raced the launch.
    h.emitStatus(agent.id, 'done');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 0, 'no delivery without a live runner');
    assert.equal(h.pendingMap().size, 1, 'entry retained for a restart inside the TTL');

    h.injectWindowsRunner(agent.id);
    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 1, 'delivered once the runner is live');
  } finally {
    h.cleanup();
  }
});

// ── (b) expiry ───────────────────────────────────────────────────────

test('(b) expired entry is dropped, never delivered', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    h.injectWindowsRunner(agent.id);
    const entry = h.pendingMap().get(agent.id)!;
    assert.ok(
      entry.expiresAt > Date.now() + 9 * 60_000,
      'fresh entry carries a ~10 min expiry',
    );
    entry.expiresAt = Date.now() - 1;

    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 0, 'stale prompt not delivered');
    assert.equal(h.pendingMap().size, 0, 'expired entry removed');

    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 0, 'still nothing after expiry cleanup');
  } finally {
    h.cleanup();
  }
});

// ── (c) cleared on stop ──────────────────────────────────────────────

test('(c) stopAgent clears the pending entry; its done emission does not deliver', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    h.injectWindowsRunner(agent.id);
    assert.equal(h.pendingMap().size, 1);

    await h.supervisor.stopAgent(agent.id);
    await flushMicrotasks();
    assert.equal(h.pendingMap().size, 0, 'entry cleared on stop');
    assert.equal(h.sendInputCalls.length, 0, "stopAgent's 'done' transition delivered nothing");
  } finally {
    h.cleanup();
  }
});

test('(c2) deleteAgent clears the pending entry', async () => {
  const h = setup();
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    await h.supervisor.deleteAgent(agent.id);
    assert.equal(h.pendingMap().size, 0, 'entry cleared on delete');
  } finally {
    h.cleanup();
  }
});

// ── delivery failure → sendInputError ────────────────────────────────

test('delivery failure emits sendInputError (agent:send-input-error flow) and does not retry', async () => {
  const h = setup({ sendInputError: new Error('PTY closed mid-typing') });
  try {
    const agent = await h.supervisor.launchAgent(
      launchInput(h, 'claude', { initialUserPrompt: INITIAL_PROMPT }),
    );
    h.injectWindowsRunner(agent.id);
    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 1, 'send attempted once');
    assert.equal(h.sendInputErrors.length, 1, 'failure surfaced as sendInputError');
    assert.equal(h.sendInputErrors[0].agentId, agent.id);
    assert.equal(h.sendInputErrors[0].error, 'PTY closed mid-typing');
    assert.equal(h.pendingMap().size, 0, 'entry consumed even on failure (no retry loop)');

    h.emitStatus(agent.id, 'idle');
    await flushMicrotasks();
    assert.equal(h.sendInputCalls.length, 1, 'no retry on the next accepting transition');
  } finally {
    h.cleanup();
  }
});

// ── (d) launch-time positional-arg path untouched, per provider ──────

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'gemini'];

test('(d1) agentMdPrompt handed to the launch builder is byte-identical with vs without initialUserPrompt (per provider)', async () => {
  for (const provider of PROVIDERS) {
    const h = setup();
    try {
      // systemPrompt exercises the claude-only merge at launchAgent:1234-1239.
      await h.supervisor.launchAgent(launchInput(h, provider, { systemPrompt: 'SYS-PROMPT' }));
      await h.supervisor.launchAgent(
        launchInput(h, provider, { systemPrompt: 'SYS-PROMPT', initialUserPrompt: INITIAL_PROMPT }),
      );
      assert.equal(h.capturedMdPrompts.length, 2, `${provider}: two launches captured`);
      const [without, withPrompt] = h.capturedMdPrompts;
      assert.equal(
        withPrompt,
        without,
        `${provider}: agentMdPrompt must be byte-identical with vs without initialUserPrompt`,
      );
      const expected = provider === 'claude' ? `SYS-PROMPT\n\n---\n\n${AGENT_MD}` : AGENT_MD;
      assert.equal(without, expected, `${provider}: baseline agentMdPrompt content`);
      assert.ok(
        !String(withPrompt).includes(INITIAL_PROMPT),
        `${provider}: initialUserPrompt must never leak into agentMdPrompt`,
      );
      assert.equal(
        h.sendInputCalls.length,
        0,
        `${provider}: launchAgent itself must not type the prompt (delivery waits for an accepting status)`,
      );
    } finally {
      h.cleanup();
    }
  }
});

test('(d2) launchWindowsAgent argv is byte-identical with vs without a pending entry (claude positional arg; codex/gemini no prompt in argv)', async () => {
  for (const provider of PROVIDERS) {
    const h = setup({ stubLaunch: false });
    // Capture argv at the runner boundary; never spawn a real process.
    const origLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
    const capturedArgs: string[][] = [];
    (WindowsRunner.prototype as { launch: unknown }).launch = function (
      this: WindowsRunner,
      _cwd: string,
      _cmd: string,
      args: string[],
    ) {
      capturedArgs.push([...args]);
      (this as unknown as { _pid: number; _alive: boolean })._pid = 12345;
      (this as unknown as { _pid: number; _alive: boolean })._alive = true;
    };
    try {
      const mdPrompt = provider === 'claude' ? `SYS-PROMPT\n\n---\n\n${AGENT_MD}` : AGENT_MD;
      const driveLaunch = async (suffix: string, pendingText?: string) => {
        const agent = makeAgent(`d2-${provider}-${suffix}`, {
          provider,
          isSupervisor: false,
          isSupervised: false,
          isWorker: false,
          command: provider,
          workingDirectory: h.workspace.path,
          logPath: path.join(h.workspace.path, `${provider}-${suffix}.log`),
        });
        h.agentsMap.set(agent.id, agent);
        if (pendingText !== undefined) {
          h.pendingMap().set(agent.id, { text: pendingText, expiresAt: Date.now() + 600_000 });
        }
        await (h.supervisor as unknown as {
          launchWindowsAgent: (a: Agent, resume: boolean, md: string | null) => Promise<void>;
        }).launchWindowsAgent(agent, false, mdPrompt);
      };

      await driveLaunch('plain');
      await driveLaunch('pending', INITIAL_PROMPT);

      assert.equal(capturedArgs.length, 2, `${provider}: two builder runs captured`);
      const [plainArgs, pendingArgs] = capturedArgs;
      assert.deepEqual(
        pendingArgs,
        plainArgs,
        `${provider}: launch argv must be byte-identical with vs without a pending initialUserPrompt`,
      );
      if (provider === 'claude') {
        assert.equal(
          plainArgs[plainArgs.length - 1],
          mdPrompt,
          'claude: agentMdPrompt rides as the final positional argument',
        );
      } else {
        assert.ok(
          !plainArgs.includes(mdPrompt) && !plainArgs.includes(INITIAL_PROMPT),
          `${provider}: neither agentMdPrompt nor initialUserPrompt appears in argv`,
        );
      }
      assert.ok(
        !pendingArgs.includes(INITIAL_PROMPT),
        `${provider}: initialUserPrompt never appears in argv`,
      );
      // The pending entry survives the launch untouched ('launching' is not
      // accepting), so the builder provably never consumed it.
      assert.equal(
        h.pendingMap().get(`d2-${provider}-pending`)?.text,
        INITIAL_PROMPT,
        `${provider}: pending entry untouched by the launch builder`,
      );
      assert.equal(h.sendInputCalls.length, 0, `${provider}: builder never types the prompt`);
    } finally {
      (WindowsRunner.prototype as { launch: unknown }).launch = origLaunch;
      h.cleanup();
    }
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
