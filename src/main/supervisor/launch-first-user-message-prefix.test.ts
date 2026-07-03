// WP3 (codex-groupthink-reliability-hardening): plumbing + fallback-chain tests
// for `firstUserMessagePrefix`.
//
// Covers:
//   1. The launchAgent fallback chain
//      (firstUserMessagePrefix ?? initialUserPrompt ?? agentMdPrompt ?? '')
//      — all three tiers — reaching captureCodexSessionId on the WINDOWS path.
//   2. The trailing param threading through launchWslAgent to
//      captureCodexSessionId on the WSL path.
//
// captureCodexSessionId is spied on the instance so no real session discovery
// runs; we only assert the prefix argument it receives.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/launch-first-user-message-prefix.test.js

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

// Mirror launch-cwd.test.ts's DB patch — launchAgent touches these.
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
    defaultCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
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

interface CaptureCall { prefix: unknown; }

function makeSupervisor(captured: CaptureCall[], agentMd: string | null): AgentSupervisor {
  const s = new AgentSupervisor();
  const anyS = s as unknown as Record<string, unknown>;
  anyS.writeAgentRegistry = () => {};
  // Neutralize scaffold + dir-trust side effects.
  anyS.ensureResearcherScaffold = () => {};
  anyS.ensureWorkerScaffold = () => {};
  anyS.ensureResearchStoreScaffold = () => {};
  anyS.ensureProviderDirTrust = () => {};
  anyS.loadAgentMd = () => agentMd;
  // Spy: record the 5th arg (firstUserMessagePrefix) captureCodexSessionId gets.
  anyS.captureCodexSessionId = (
    _agentId: string,
    _before: unknown,
    _cwd: string,
    _launchedAfterMs: number,
    prefix?: string | null,
  ) => {
    captured.push({ prefix });
  };
  return s;
}

// ── Windows path: fallback chain, all three tiers ────────────────────────

async function launchCodexWindows(
  input: Record<string, unknown>,
  agentMd: string | null,
): Promise<CaptureCall[]> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fump-win-'));
  const created: Agent[] = [];
  const captured: CaptureCall[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor(captured, agentMd);
    await supervisor.launchAgent({
      workspaceId: 'ws-1',
      title: 'codex worker',
      provider: 'codex',
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
      ...input,
    } as never);
    return captured;
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

test('WP3 plumbing (Windows tier 1): explicit firstUserMessagePrefix wins over initialUserPrompt and agentMd', async () => {
  const captured = await launchCodexWindows(
    { firstUserMessagePrefix: 'EXPLICIT-PREFIX', initialUserPrompt: 'IUP-should-lose' },
    'AGENTMD-should-lose',
  );
  assert.equal(captured.length, 1, 'captureCodexSessionId must fire once for a codex launch');
  assert.equal(captured[0].prefix, 'EXPLICIT-PREFIX', 'explicit field must win the fallback chain');
});

test('WP3 plumbing (Windows tier 2): initialUserPrompt used when no explicit prefix, outranks agentMd', async () => {
  const captured = await launchCodexWindows(
    { initialUserPrompt: 'INITIAL-USER-PROMPT' },
    'AGENTMD-should-lose',
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].prefix, 'INITIAL-USER-PROMPT', 'initialUserPrompt outranks agentMdPrompt');
});

test('WP3 plumbing (Windows tier 3): agentMdPrompt used when neither explicit prefix nor initialUserPrompt present', async () => {
  const captured = await launchCodexWindows({}, 'AGENTMD-PROMPT-TEXT');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].prefix, 'AGENTMD-PROMPT-TEXT', 'agentMdPrompt is the last non-empty tier');
});

test('WP3 plumbing (Windows tier fallthrough): empty string when nothing supplied', async () => {
  const captured = await launchCodexWindows({}, null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].prefix, '', 'no signals → empty prefix (SQL filter no-op)');
});

// ── WSL path: trailing param threads to captureCodexSessionId ─────────────

test('WP3 plumbing (WSL): launchWslAgent forwards firstUserMessagePrefix to captureCodexSessionId', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fump-wsl-'));
  const created: Agent[] = [];
  const captured: CaptureCall[] = [];
  const restoreDb = patchDb(workspacePath, created);
  const restoreRunners = patchRunners();
  try {
    const supervisor = makeSupervisor(captured, null);
    // Neutralize WSL-only + side-effectful machinery so the direct
    // launchWslAgent call reaches the captureCodexSessionId tail cleanly.
    const anyS = supervisor as unknown as Record<string, unknown>;
    anyS.buildContinuationBrickBlock = () => '';
    anyS.setupFileTracker = () => null;
    anyS.buildDashboardMcpConfigForLane = () => 'cfg';
    anyS.buildTeamMcpConfigArg = () => 'team';
    anyS.resolveWslGatewayIp = () => '127.0.0.1';
    anyS.ensureSpoolTailer = () => {};

    // A bare (legacy-lane) codex agent — no lane flags, no persona — so the
    // hook-instrumented WSL branches (resolveWslGatewayIp/spool) stay off the
    // critical path.
    const agent = makeAgent('wsl-codex-1', {
      provider: 'codex',
      workingDirectory: '/home/u/ws/.dashboard/workers/codex',
      tmuxSessionName: 'ad-wsl-codex-1',
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
      logPath: path.join(workspacePath, 'agent.log'),
    });
    created.push(agent);

    await (supervisor as unknown as {
      launchWslAgent(
        agent: Agent, resume: boolean, agentMdPrompt: string | null,
        overrideCommand: string | undefined, sessionId: string | undefined,
        freshSession: boolean, firstUserMessagePrefix: string | null,
      ): Promise<void>;
    }).launchWslAgent(agent, false, null, undefined, undefined, true, 'WSL-PREFIX-XYZ');

    assert.equal(captured.length, 1, 'captureCodexSessionId must fire for the codex WSL launch');
    assert.equal(captured[0].prefix, 'WSL-PREFIX-XYZ', 'WSL path must forward the trailing prefix param');
  } finally {
    restoreRunners();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ── Runner ───────────────────────────────────────────────────────────────
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
