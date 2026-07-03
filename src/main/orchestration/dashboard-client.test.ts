// WP0 (BUG-37): the in-process DashboardClient's getMessages binding must fire
// the codex-sid recovery hook (maybeRecoverCodexSid) BEFORE the chat-service
// read, on EVERY call — mirroring the HTTP (api-server.ts:518) and IPC
// (ipc-handlers.ts:115,119) chat-read paths. Without it the orchestrator's poll
// loop is the one chat-read path that bypasses BUG-28 recovery, so a codex
// discovery race-loss blanks GroupThink's chat forever (the BUG-37 false-stall).
//
// This suite asserts CALL ORDER ONLY. Provider/sid/grace gating lives in and is
// tested by the supervisor-level suite (codex-sid-recovery-on-chat-read.test.ts).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/dashboard-client.test.js

import assert from 'node:assert/strict';
import { createDashboardClient } from './dashboard-client';
import type { AgentSupervisor } from '../supervisor';

// Records the interleaving of recovery vs. read on a shared sequence log so the
// test can assert recovery precedes read for each getMessages invocation.
function makeSupervisorSpy() {
  const seq: string[] = [];
  const supervisor = {
    maybeRecoverCodexSid: (id: string) => { seq.push(`recover:${id}`); },
    getChatService: () => ({
      getMessages: async (id: string, _opts: { limit: number; role?: 'assistant' | 'user' }) => {
        seq.push(`read:${id}`);
        return [];
      },
    }),
  } as unknown as AgentSupervisor;
  return { supervisor, seq };
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

test('getMessages fires recovery before the chat-service read', async () => {
  const { supervisor, seq } = makeSupervisorSpy();
  const client = createDashboardClient(supervisor);

  await client.getMessages('agent-1', { limit: 1, role: 'assistant' });

  assert.deepEqual(seq, ['recover:agent-1', 'read:agent-1'],
    'recovery must be invoked first, chat-service read second');
});

test('recovery + read fire on EVERY getMessages call (not just the first)', async () => {
  const { supervisor, seq } = makeSupervisorSpy();
  const client = createDashboardClient(supervisor);

  await client.getMessages('a', { limit: 1 });
  await client.getMessages('a', { limit: 1 });
  await client.getMessages('a', { limit: 1 });

  assert.deepEqual(seq, [
    'recover:a', 'read:a',
    'recover:a', 'read:a',
    'recover:a', 'read:a',
  ], 'each poll must re-fire recovery-then-read');
});

test('the recovered/read agent id is threaded through unchanged', async () => {
  const { supervisor, seq } = makeSupervisorSpy();
  const client = createDashboardClient(supervisor);

  await client.getMessages('reviewer-xyz', { limit: 5, role: 'assistant' });

  assert.deepEqual(seq, ['recover:reviewer-xyz', 'read:reviewer-xyz']);
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
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
