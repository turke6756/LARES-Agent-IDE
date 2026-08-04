// Unit tests for the canonical Notification classifier
// (plans/idle-vs-waiting-notification-fix.md §A).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/shared/notification-classify.test.js

import assert from 'node:assert/strict';
import {
  NON_BLOCKING_NOTIFICATION_TYPES,
  isNonBlockingNotificationType,
  isTurnCompleteNotificationMessage,
} from './notification-classify';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// Every canonical non-blocking type classifies as non-blocking.
test('each NON_BLOCKING_NOTIFICATION_TYPES entry → true', () => {
  for (const t of NON_BLOCKING_NOTIFICATION_TYPES) {
    assert.equal(isNonBlockingNotificationType(t), true, `${t} must be non-blocking`);
  }
});

// Blocking / unknown / missing types fall through to waiting (false).
test('blocking + unknown + missing types → false', () => {
  for (const t of ['permission_prompt', 'elicitation_dialog', 'unknown']) {
    assert.equal(isNonBlockingNotificationType(t), false, `${t} must NOT be non-blocking`);
  }
  assert.equal(isNonBlockingNotificationType(undefined), false, 'undefined → false (conservative)');
  assert.equal(isNonBlockingNotificationType(''), false, 'empty string → false (conservative)');
});

// Case- and surrounding-whitespace-insensitive.
test('case + surrounding-whitespace insensitivity', () => {
  assert.equal(isNonBlockingNotificationType(' Idle_Prompt '), true, '" Idle_Prompt " → true');
  assert.equal(isNonBlockingNotificationType('IDLE_PROMPT'), true, 'IDLE_PROMPT → true');
  assert.equal(isNonBlockingNotificationType('  auth_success'), true, 'leading ws → true');
});

// ── isTurnCompleteNotificationMessage (grok turn-completion notice) ──────

// The grok lane's turn-completion message is informational, not an input gate.
test('grok "Turn complete" message → true (turn-completion notice)', () => {
  assert.equal(isTurnCompleteNotificationMessage('Turn complete'), true, '"Turn complete" → true');
  assert.equal(isTurnCompleteNotificationMessage('  turn complete  '), true, 'surrounding ws → true');
  assert.equal(isTurnCompleteNotificationMessage('TURN COMPLETE'), true, 'case-insensitive → true');
});

// Genuine input-needed / permission notices must still latch waiting (false),
// as must empty/missing messages.
test('input-needed + permission + empty messages → false (still latch waiting)', () => {
  assert.equal(isTurnCompleteNotificationMessage('Claude is waiting for your input'), false, 'input prompt → false');
  assert.equal(isTurnCompleteNotificationMessage('Bash tool requires permission'), false, 'permission prompt → false');
  assert.equal(isTurnCompleteNotificationMessage('Do you trust the files in this folder?'), false, 'trust prompt → false');
  assert.equal(isTurnCompleteNotificationMessage(undefined), false, 'undefined → false (conservative)');
  assert.equal(isTurnCompleteNotificationMessage(''), false, 'empty string → false (conservative)');
});

// ── Runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
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
