// BUG-28 regression: chat-read endpoints must lazy-recover a Codex agent's
// resumeSessionId when the post-launch discovery race left it null. Without
// this hook, CodexRolloutReader never tails the rollout file and structured
// chat stays empty for the agent even though the rollout JSONL on disk has
// every assistant turn.
//
// This test covers the public `AgentSupervisor.maybeRecoverCodexSid` wrapper
// that the chat-messages endpoint (src/main/api-server.ts) calls. The wrapper
// must:
//   1. Be a no-op when the agent doesn't exist.
//   2. Be a no-op for non-codex agents.
//   3. Be a no-op when a codex agent already has resumeSessionId set.
//   4. On a codex agent with null resumeSessionId AND a cwd-matching rollout
//      on disk, persist the recovered sid via updateAgentResumeSessionId.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/supervisor/codex-sid-recovery-on-chat-read.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
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
// `maybeRecoverCodexSid` reads via `getAgent` and (on the happy path) writes
// via `updateAgentResumeSessionId`. Both come from `../database`. We patch
// them at the module level so the production code under test sees the stubs
// without code changes.
interface DbPatch {
  agentLookup: (id: string) => Agent | null;
  sidUpdates: Array<{ id: string; sessionId: string }>;
  restore: () => void;
}

function patchDb(agentLookup: (id: string) => Agent | null): DbPatch {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getAgent', 'updateAgentResumeSessionId',
    // Constructor + sessionLogReader callbacks also touch these; stub them so
    // background polls during the test don't blow up.
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addEvent',
    'getFileActivities', 'addFileActivity',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  const sidUpdates: Array<{ id: string; sessionId: string }> = [];
  db.getAgent = (id: string) => agentLookup(id);
  db.updateAgentResumeSessionId = (id: string, sessionId: string) => {
    sidUpdates.push({ id, sessionId });
  };
  db.getActiveAgents = () => [];
  db.getAllAgents = () => [];
  db.getSupervisorAgent = () => null;
  db.addEvent = () => {};
  db.getFileActivities = () => [];
  db.addFileActivity = () => null;

  return {
    agentLookup,
    sidUpdates,
    restore: () => {
      for (const k of keys) db[k] = orig[k];
    },
  };
}

function makeSupervisor(): AgentSupervisor {
  const s = new AgentSupervisor();
  // Suppress writes to ~/.claude/agent-registry.json triggered by emit().
  (s as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  // Replace sessionLogReader.rebindAgent with a spy so the happy-path test
  // (which fires the real recovery) doesn't try to bind against the live
  // dispatcher.
  const reader = (s as unknown as { sessionLogReader: { rebindAgent: (id: string) => void } }).sessionLogReader;
  reader.rebindAgent = () => {};
  return s;
}

// ── Tests ────────────────────────────────────────────────────────────

test('maybeRecoverCodexSid: nonexistent agent is a no-op (does not throw, no sid writes)', () => {
  const patch = patchDb(() => null);
  try {
    const supervisor = makeSupervisor();
    // Should not throw even though the agent doesn't exist.
    supervisor.maybeRecoverCodexSid('nonexistent-id');
    assert.equal(patch.sidUpdates.length, 0, 'no recovery work for nonexistent agent');
  } finally {
    patch.restore();
  }
});

test('maybeRecoverCodexSid: claude agent is a no-op even when resumeSessionId is null', () => {
  const agent = makeAgent('claude-agent', {
    provider: 'claude',
    resumeSessionId: null,
  });
  const patch = patchDb((id) => (id === agent.id ? agent : null));
  try {
    const supervisor = makeSupervisor();
    supervisor.maybeRecoverCodexSid(agent.id);
    assert.equal(patch.sidUpdates.length, 0, 'recovery must not fire for claude agents');
    assert.equal(agent.resumeSessionId, null, 'claude agent sid unchanged');
  } finally {
    patch.restore();
  }
});

test('maybeRecoverCodexSid: codex agent with resumeSessionId already set is a no-op', () => {
  const PRESET_SID = '11111111-2222-3333-4444-555555555555';
  const agent = makeAgent('codex-preset', {
    provider: 'codex',
    resumeSessionId: PRESET_SID,
  });
  const patch = patchDb((id) => (id === agent.id ? agent : null));
  try {
    const supervisor = makeSupervisor();
    supervisor.maybeRecoverCodexSid(agent.id);
    assert.equal(patch.sidUpdates.length, 0, 'must not re-write a sid that is already set');
    assert.equal(agent.resumeSessionId, PRESET_SID, 'preset sid is preserved');
  } finally {
    patch.restore();
  }
});

test('maybeRecoverCodexSid: codex agent with null sid + matching rollout → sid recovered and persisted', () => {
  const ROLLOUT_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  // Use a temp dir as the synthetic USERPROFILE so the recovery scans our
  // fixture rollout file instead of the real user's ~/.codex/sessions/.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bug28-home-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug28-cwd-'));
  // Place the rollout under <fakeHome>/.codex/sessions/2026/05/17/.
  // Stale-rollout hardening: recovery now rejects rollouts whose session
  // timestamp predates the agent's launch floor (makeAgent createdAt is
  // 2026-05-16T00:00:00Z), so the fixture rollout must be dated AFTER it.
  const sessionsRoot = path.join(fakeHome, '.codex', 'sessions');
  const dayDir = path.join(sessionsRoot, '2026', '05', '17');
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutPath = path.join(
    dayDir,
    `rollout-2026-05-17T12-00-00-${ROLLOUT_SID}.jsonl`
  );
  fs.writeFileSync(
    rolloutPath,
    JSON.stringify({
      timestamp: '2026-05-17T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: ROLLOUT_SID,
        cwd: workspaceDir,
        model_provider: 'openai',
        cli_version: '0.133.0',
      },
    }) + '\n'
  );

  const originalUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;

  const agent = makeAgent('codex-needs-recovery', {
    provider: 'codex',
    resumeSessionId: null,
    workingDirectory: workspaceDir,
  });
  const patch = patchDb((id) => (id === agent.id ? agent : null));
  try {
    const supervisor = makeSupervisor();
    supervisor.maybeRecoverCodexSid(agent.id);
    assert.equal(
      patch.sidUpdates.length,
      1,
      `expected exactly one sid persistence call; got ${JSON.stringify(patch.sidUpdates)}`
    );
    assert.equal(patch.sidUpdates[0].id, agent.id, 'sid persisted against the correct agent id');
    assert.equal(
      patch.sidUpdates[0].sessionId,
      ROLLOUT_SID,
      'sid persisted matches the on-disk rollout UUID'
    );
  } finally {
    patch.restore();
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

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
