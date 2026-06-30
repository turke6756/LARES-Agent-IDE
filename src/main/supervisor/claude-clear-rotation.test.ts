// Pure-function tests for decideClearRotation — the BUG-26-class safety guard
// that decides whether a Claude agent should rotate to a hook-bound /clear
// successor. No fs, no DB, NO active-agent/cwd-uniqueness input: the candidate
// is already bound to THIS agent, and the on-disk validation is injected as a
// stub. The defining invariant: the function never discovers a successor by
// cwd/slug, so two same-cwd agents are simply irrelevant to it.
//
//   npm run build:main
//   node dist/main/main/supervisor/claude-clear-rotation.test.js

import assert from 'node:assert/strict';
import { decideClearRotation, type ClearRotationAgent, type ClearRotationTrigger } from './claude-clear-rotation';
import type { AgentProvider } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeAgent(overrides: Partial<ClearRotationAgent> = {}): ClearRotationAgent {
  return {
    id: 'a1',
    provider: 'claude' as AgentProvider,
    workingDirectory: 'C:\\repo',
    resumeSessionId: 'cur',
    createdAt: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

const TRUE = (): boolean => true;
const FALSE = (): boolean => false;
const NEVER = (): boolean => { throw new Error('validateSuccessor should not be called'); };

test('1: claude + hook candidate + validator true → returns candidate (no active-agent input)', () => {
  const out = decideClearRotation({
    agent: makeAgent(),
    trigger: { kind: 'hook', candidateSessionId: 'new' },
    validateSuccessor: TRUE,
  });
  assert.equal(out, 'new');
});

test('2: validator receives (cwd, currentSid, candidate, startedAt) verbatim', () => {
  const seen: string[] = [];
  const out = decideClearRotation({
    agent: makeAgent({ workingDirectory: 'C:\\repo', resumeSessionId: 'cur', createdAt: 'T0' }),
    trigger: { kind: 'hook', candidateSessionId: 'new' },
    validateSuccessor: (wd, cur, cand, started) => { seen.push(wd, cur, cand, started); return true; },
  });
  assert.equal(out, 'new');
  assert.deepEqual(seen, ['C:\\repo', 'cur', 'new', 'T0']);
});

test('3: provider !== claude → null and validator not called', () => {
  const out = decideClearRotation({
    agent: makeAgent({ provider: 'codex' as AgentProvider }),
    trigger: { kind: 'hook', candidateSessionId: 'new' },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('4: null resumeSessionId → null and validator not called', () => {
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: null }),
    trigger: { kind: 'hook', candidateSessionId: 'new' },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('5: candidate equals current session → null (inert ordinary prompt)', () => {
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: 'cur' }),
    trigger: { kind: 'hook', candidateSessionId: 'cur' },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('6: validator false → null', () => {
  const out = decideClearRotation({
    agent: makeAgent(),
    trigger: { kind: 'hook', candidateSessionId: 'new' },
    validateSuccessor: FALSE,
  });
  assert.equal(out, null);
});

test('7: stale trigger with staleSessionId !== resumeSessionId → null, validator not called', () => {
  // The row already rotated past this stale session; the retry must be ignored.
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: 'cur' }),
    trigger: { kind: 'stale', staleSessionId: 'OLD-different', candidateSessionId: 'new' },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('8: stale trigger pinned to current session, with candidate + validator true → rotates', () => {
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: 'cur' }),
    trigger: { kind: 'stale', staleSessionId: 'cur', candidateSessionId: 'new' },
    validateSuccessor: TRUE,
  });
  assert.equal(out, 'new');
});

test('9: stale trigger with no candidate → null and validator not called', () => {
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: 'cur' }),
    trigger: { kind: 'stale', staleSessionId: 'cur', candidateSessionId: undefined },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('10: stale trigger with null candidate → null and validator not called', () => {
  const out = decideClearRotation({
    agent: makeAgent({ resumeSessionId: 'cur' }),
    trigger: { kind: 'stale', staleSessionId: 'cur', candidateSessionId: null },
    validateSuccessor: NEVER,
  });
  assert.equal(out, null);
});

test('11: rediscovery trigger validates exactly like a hook trigger', () => {
  const out = decideClearRotation({
    agent: makeAgent(),
    trigger: { kind: 'rediscovery', candidateSessionId: 'new' },
    validateSuccessor: TRUE,
  });
  assert.equal(out, 'new');
  const out2 = decideClearRotation({
    agent: makeAgent(),
    trigger: { kind: 'rediscovery', candidateSessionId: 'new' },
    validateSuccessor: FALSE,
  });
  assert.equal(out2, null);
});

test('12: two same-cwd agents are irrelevant — the function has no active-agent list', () => {
  // Distinct agents with the SAME cwd each validate ONLY their own candidate.
  // There is no shared-cwd veto and no cross-binding surface at all.
  const triggerA: ClearRotationTrigger = { kind: 'hook', candidateSessionId: 'sA' };
  const triggerB: ClearRotationTrigger = { kind: 'hook', candidateSessionId: 'sB' };
  const validated: string[] = [];
  const mk = (id: string, cur: string) => makeAgent({ id, resumeSessionId: cur, workingDirectory: 'C:\\shared' });
  const outA = decideClearRotation({
    agent: mk('a1', 'curA'),
    trigger: triggerA,
    validateSuccessor: (_wd, _cur, cand) => { validated.push(`a1:${cand}`); return true; },
  });
  const outB = decideClearRotation({
    agent: mk('a2', 'curB'),
    trigger: triggerB,
    validateSuccessor: (_wd, _cur, cand) => { validated.push(`a2:${cand}`); return true; },
  });
  assert.equal(outA, 'sA');
  assert.equal(outB, 'sB');
  // a1 only ever saw sA; a2 only ever saw sB. No cross-binding possible.
  assert.deepEqual(validated, ['a1:sA', 'a2:sB']);
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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
