// WP8 (hook-absence-resilience) — the HARD REQUIREMENT lock. Asserts that EVERY
// failed / delivered-unconfirmed outcome carries the verbatim double-click
// terminal-check sentence, and that a detected prompt is named.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/shared/send-outcome-copy.test.js

import assert from 'node:assert/strict';
import { sendOutcomeMessage, TERMINAL_CHECK_SENTENCE } from './send-outcome-copy';
import type { SendOutcome } from './types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function outcome(o: Partial<SendOutcome> & { disposition: SendOutcome['disposition'] }): SendOutcome {
  return { agentId: 'a', delivered: o.disposition !== 'failed', completedAt: 0, ...o };
}

test('delivered-unconfirmed includes the verbatim terminal-check sentence (amber)', () => {
  const copy = sendOutcomeMessage(outcome({ disposition: 'delivered-unconfirmed', reason: 'confirmation-timeout' }));
  assert.equal(copy.tone, 'warn', 'delivered-unconfirmed is amber, never "error"');
  assert.ok(copy.text.includes(TERMINAL_CHECK_SENTENCE),
    `must include the mandatory sentence; got: ${copy.text}`);
  assert.ok(!/send failed/i.test(copy.text), 'delivered-unconfirmed must never read as "Send failed"');
});

test('failed includes the SAME verbatim terminal-check sentence (red)', () => {
  const copy = sendOutcomeMessage(outcome({ disposition: 'failed', delivered: false, reason: 'delivery-failed' }));
  assert.equal(copy.tone, 'error');
  assert.ok(copy.text.includes(TERMINAL_CHECK_SENTENCE),
    `must include the mandatory sentence; got: ${copy.text}`);
});

test('a detected prompt is NAMED (label + excerpt) and still carries the sentence', () => {
  const copy = sendOutcomeMessage(outcome({
    disposition: 'delivered-unconfirmed', reason: 'interactive-prompt',
    prompt: { kind: 'trust-dialog', label: 'workspace trust dialog', excerpt: 'Do you trust the files in this folder?' },
  }));
  assert.ok(copy.text.includes('workspace trust dialog'), 'names the prompt label');
  assert.ok(copy.text.includes('Do you trust the files in this folder?'), 'quotes the excerpt');
  assert.ok(copy.text.includes(TERMINAL_CHECK_SENTENCE), 'still carries the mandatory sentence');
});

test('confirmed is a brief/empty ok banner', () => {
  const copy = sendOutcomeMessage(outcome({ disposition: 'confirmed', confirmationSource: 'hook' }));
  assert.equal(copy.tone, 'ok');
  assert.equal(copy.text, '');
});

let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); }
  catch (err) { failed++; console.error(`  FAIL ${t.name}`); console.error(err); }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
