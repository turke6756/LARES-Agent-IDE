// WP3 (hook-absence-resilience, MVP slice) — TurnEvidenceTracker tests.
// Covers: live start capture, initialLoad rejection, synthetic-echo rejection,
// session-rebound rejection, and baseline-gated no-confirm-from-replay.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/turn-evidence.test.js

import assert from 'node:assert/strict';
import { TurnEvidenceTracker } from './turn-evidence';
import type { SessionEvent } from '../../shared/session-events';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function userText(uuid: string, text = 'go'): SessionEvent {
  return { type: 'user-text', uuid, timestamp: '', agentId: 'a', text };
}
function taskStarted(uuid: string): SessionEvent {
  return { type: 'task-started', uuid, timestamp: '', agentId: 'a' };
}
function assistant(uuid: string): SessionEvent {
  return { type: 'assistant-text', uuid, timestamp: '', agentId: 'a', text: 'hi' };
}

test('a live non-synthetic user-text after baseline confirms', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  assert.equal(t.hasStartSince('a', base), false, 'nothing yet');
  t.noteEvents('a', [userText('u1')], 's1', true);
  assert.equal(t.hasStartSince('a', base), true, 'a real user-text is a start');
});

test('a live task-started after baseline confirms', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  t.noteEvents('a', [taskStarted('ts1')], 's1', true);
  assert.equal(t.hasStartSince('a', base), true, 'task-started is a start');
});

test('SYNTHETIC-ECHO GUARD: a synthetic: user-text never confirms', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  t.noteEvents('a', [userText('synthetic:a:123')], 's1', true);
  assert.equal(t.hasStartSince('a', base), false,
    'the Lares-injected echo must not count as the agent starting a turn');
});

test('initialLoad (replay) advances the seq but never registers a live start', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  // Historical replay: not live.
  t.noteEvents('a', [userText('h1'), taskStarted('h2')], 's1', false);
  assert.equal(t.hasStartSince('a', base), false, 'replay must not confirm');
  // A subsequent LIVE start does confirm — and the replay advanced the seq so a
  // fresh baseline taken now is correctly ahead of the replayed events.
  const base2 = t.baseline('a', 's1');
  t.noteEvents('a', [userText('l1')], 's1', true);
  assert.equal(t.hasStartSince('a', base2), true, 'a later live start confirms');
});

test('baseline-gated: a start recorded BEFORE the baseline does not confirm it', () => {
  const t = new TurnEvidenceTracker();
  t.noteEvents('a', [userText('u1')], 's1', true); // start happens first
  const base = t.baseline('a', 's1');               // baseline captured AFTER it
  assert.equal(t.hasStartSince('a', base), false,
    'a prior turn start must not confirm a later send (no confirm-from-replay)');
});

test('SESSION-REBOUND GUARD: a start from a different session id does not confirm', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  // A start arrives, but tagged with a rotated session id (shared-cwd rebind).
  t.noteEvents('a', [userText('u1')], 's2', true);
  assert.equal(t.hasStartSince('a', base), false,
    'a start from session s2 must not confirm a send baselined against s1');
  // A start on the SAME session does confirm.
  t.noteEvents('a', [userText('u2')], 's1', true);
  assert.equal(t.hasStartSince('a', base), true, 'same-session start confirms');
});

test('reset() drops evidence so a stale session cannot confirm across a rebind', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  t.noteEvents('a', [userText('u1')], 's1', true);
  assert.equal(t.hasStartSince('a', base), true);
  t.reset('a');
  assert.equal(t.hasStartSince('a', base), false, 'reset clears prior evidence');
});

test('assistant-text is not a start (only user-text / task-started are)', () => {
  const t = new TurnEvidenceTracker();
  const base = t.baseline('a', 's1');
  t.noteEvents('a', [assistant('x1')], 's1', true);
  assert.equal(t.hasStartSince('a', base), false, 'assistant output is not a turn start');
});

let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); }
  catch (err) { failed++; console.error(`  FAIL ${t.name}`); console.error(err); }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
