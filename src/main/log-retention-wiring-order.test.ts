// WP-8 (terminal-log retention) — the load-bearing index.ts construction order.
//
//   npm run build:main
//   node dist/main/main/log-retention-wiring-order.test.js
//
// The retention feature is turned ON by STARTING the scheduler, and the order in
// which that happens relative to heap-telemetry construction is load-bearing: a
// scheduler started before telemetry exists would fire a sweep whose telemetry
// line has no writer to reach. Because that wiring lives in `index.ts` (not a
// unit-testable factory), this is a SOURCE-ORDER guard — the same technique the
// no-whole-file-log-read guard uses — asserting the ordered tokens appear in the
// required sequence in the real source.
//
// It kills the plan's "starting the scheduler before telemetry/sinks are
// assigned" mutation: moving `retentionScheduler?.start()` above
// `heapTelemetry = createHeapTelemetry(...)` flips the two indices and fails
// here. It also pins the shutdown order (scheduler drained before telemetry
// stops before the supervisor drain).

import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert/strict';

declare const __dirname: string;

function findIndexTs(): string {
  const candidates = [path.join(process.cwd(), 'src', 'main', 'index.ts')];
  let d = __dirname;
  for (let i = 0; i < 12; i++) { candidates.push(path.join(d, 'src', 'main', 'index.ts')); d = path.dirname(d); }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('log-retention-wiring-order: could not locate src/main/index.ts');
}

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const SRC = fs.readFileSync(findIndexTs(), 'utf8');

/** Index of the first occurrence of `needle`; asserts it is present exactly so a
 *  rename that removes the wiring is caught rather than silently passing. */
function at(needle: string): number {
  const i = SRC.indexOf(needle);
  assert.notEqual(i, -1, `expected index.ts to contain \`${needle}\``);
  // And that it is unique enough not to be ambiguous for ordering.
  assert.equal(SRC.indexOf(needle, i + 1), -1, `expected \`${needle}\` to appear exactly once`);
  return i;
}

test('startup order: construct scheduler → construct telemetry → START scheduler', () => {
  const constructScheduler = at('new LogRetentionScheduler(');
  const constructTelemetry = at('heapTelemetry = createHeapTelemetry(');
  const startScheduler = at('retentionScheduler?.start(');

  assert.ok(constructScheduler < constructTelemetry, 'scheduler is constructed before heap telemetry');
  assert.ok(
    constructTelemetry < startScheduler,
    'THE invariant: the scheduler is STARTED only AFTER heap telemetry is constructed — ' +
      'starting it earlier drops every sweep telemetry line',
  );
});

test('the scheduler is actually started (feature turned ON, not merely constructed)', () => {
  assert.ok(SRC.includes('retentionScheduler?.start('), 'retentionScheduler?.start() is present');
});

test('the real sinks + IPC replaced WP-5 no-ops', () => {
  assert.ok(SRC.includes('makeRetentionSinks('), 'real scan sinks installed');
  assert.ok(SRC.includes('registerLogRetentionIpc('), 'pull/acknowledge IPC registered');
  assert.ok(
    !/emitSweepEvent:\s*\(\)\s*=>\s*\{\s*\/\* WP-8 installs/.test(SRC),
    'the WP-5 no-op emitSweepEvent placeholder is gone',
  );
});

test('shutdown order: drain scheduler → stop telemetry → supervisor drain', () => {
  const stopScheduler = at('await retentionScheduler?.stop(');
  const stopTelemetry = at('heapTelemetry?.stop(');
  const drainSupervisor = at('await supervisor?.drainForShutdown(');
  assert.ok(stopScheduler < stopTelemetry, 'the scheduler drains before heap telemetry stops');
  assert.ok(stopTelemetry < drainSupervisor, 'telemetry stops before the supervisor drain');
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
