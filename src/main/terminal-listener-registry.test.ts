// Unit tests for the WP-3d epoch-scoped active-listener registry.
//
//   npm run build:main
//   node dist/main/main/terminal-listener-registry.test.js
//
// The registry is what makes `terminal:detach` epoch-scoped: an LRU eviction
// under a retired epoch must never tear down a listener a fresh reattach
// registered under a newer epoch. These tests exercise that survival scenario
// plus the unconditional (rebound) path and the legacy 1-arg detach.

import assert from 'node:assert/strict';
import { TerminalListenerRegistry, type TerminalDataListener } from './terminal-listener-registry';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

/** A distinguishable listener (identity is what removal returns). */
function mkListener(tag: string): TerminalDataListener {
  const l = (() => {}) as TerminalDataListener;
  (l as any).__tag = tag;
  return l;
}

test('register + has tracks the entry', () => {
  const reg = new TerminalListenerRegistry();
  assert.equal(reg.has('a'), false);
  reg.register('a', mkListener('L1'), 'epochA');
  assert.equal(reg.has('a'), true);
});

test('removeForEpoch removes when the epoch matches', () => {
  const reg = new TerminalListenerRegistry();
  const l = mkListener('L1');
  reg.register('a', l, 'epochA');
  const res = reg.removeForEpoch('a', 'epochA');
  assert.equal(res.noop, false);
  assert.equal(res.removed, l);
  assert.equal(reg.has('a'), false);
});

test('removeForEpoch is a no-op when the registered epoch differs (epoch-B listener survives)', () => {
  const reg = new TerminalListenerRegistry();
  // Attach under epoch A.
  reg.register('a', mkListener('A'), 'epochA');
  // Rebound tears the epoch-A listener down unconditionally...
  assert.ok(reg.removeUnconditional('a'));
  // ...and a fresh reattach registers a NEW listener under epoch B.
  const lB = mkListener('B');
  reg.register('a', lB, 'epochB');
  // The DELAYED eviction detach still carries the retired epoch A.
  const res = reg.removeForEpoch('a', 'epochA');
  assert.equal(res.noop, true, 'stale-epoch detach is flagged no-op');
  assert.equal(res.removed, null, 'stale-epoch detach removes nothing');
  assert.equal(reg.has('a'), true, 'epoch-B listener survives');
  // And a correctly-scoped epoch-B detach still removes it.
  const res2 = reg.removeForEpoch('a', 'epochB');
  assert.equal(res2.removed, lB);
  assert.equal(reg.has('a'), false);
});

test('removeForEpoch on an unknown id is a benign no-removal (not flagged noop)', () => {
  const reg = new TerminalListenerRegistry();
  const res = reg.removeForEpoch('missing', 'epochA');
  assert.equal(res.noop, false, 'nothing to preserve → detachAgent still runs');
  assert.equal(res.removed, null);
});

test('removeForEpoch with undefined expectedEpoch (legacy caller) removes unconditionally', () => {
  const reg = new TerminalListenerRegistry();
  const l = mkListener('L1');
  reg.register('a', l, 'epochA');
  const res = reg.removeForEpoch('a', undefined);
  assert.equal(res.noop, false);
  assert.equal(res.removed, l);
  assert.equal(reg.has('a'), false);
});

test('a null-epoch entry (dead agent, epoch never recorded) matches a null expected epoch', () => {
  const reg = new TerminalListenerRegistry();
  const l = mkListener('L1');
  reg.register('a', l, null);
  // A mismatched non-null epoch is preserved...
  assert.equal(reg.removeForEpoch('a', 'epochX').noop, true);
  // ...but the matching null epoch removes it.
  const res = reg.removeForEpoch('a', null);
  assert.equal(res.removed, l);
  assert.equal(reg.has('a'), false);
});

test('removeUnconditional returns null for an unknown id', () => {
  const reg = new TerminalListenerRegistry();
  assert.equal(reg.removeUnconditional('nope'), null);
});

// ── Runner ────────────────────────────────────────────────────────────
(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
