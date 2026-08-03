// WP-P0B — trusted format-gate scope test for `assertPlanRailFree`.
//
// The one-writer guard now applies ONLY to legacy `format === 'html'` plans, and
// the format is read from the TRUSTED `plans` row (`getPlan`) — never from a
// caller-supplied value. This test drives the full format-gate matrix:
//
//   html       → GUARDED   (active run / live agent / materializing all 409)
//   structured → BYPASS    (guard short-circuits even with an active reservation)
//   md         → BYPASS
//   unknown id → BYPASS    (getPlan → null; safe no-crash)
//   empty id   → BYPASS
//
// Plus: the decision follows the stored row (flipping the DB format flips the
// verdict, proving the guard reads trusted state), and all three external
// dispatch call sites still invoke the guard (source-grep, drift guard).
//
//   npm run build:main
//   node dist/main/main/orchestration/plan-ownership.scope.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Patched module exports (the guard resolves getPlan / list* / getLive* off the
// required module object at call time; the singleton trailMaterializer likewise). ──
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const trail = require('../plans/execution-trail-writer') as { trailMaterializer: Record<string, any> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertPlanRailFree } = require('./plan-ownership') as {
  assertPlanRailFree(planId: string, opts?: { exemptRunId?: string; exemptAgentIds?: string[] }): void;
};

// Mutable harness state, reset per case.
let storedFormat: string | null | 'MISSING' = 'html';
let activeRuns: Array<{ planId: string; runId: string; status: string }> = [];
let liveAgent: { id: string; status: string } | null = null;
let materializing = false;

db.getPlan = (id: string) =>
  storedFormat === 'MISSING'
    ? null
    : { id, workspaceId: 'ws', path: 'plans/p.html', slug: null, format: storedFormat };
db.listOrchestrationRuns = () => activeRuns.map((r) => ({ ...r }));
db.getLiveRailAgentForPlan = () => (liveAgent ? { ...liveAgent } : null);
trail.trailMaterializer.isMaterializing = () => materializing;

function reset(format: string | null | 'MISSING'): void {
  storedFormat = format;
  activeRuns = [];
  liveAgent = null;
  materializing = false;
}
const is409 = (e: unknown): boolean => (e as { statusCode?: number }).statusCode === 409;

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── html → GUARDED ────────────────────────────────────────────────────────────

test('html + free → does not throw', () => {
  reset('html');
  assert.doesNotThrow(() => assertPlanRailFree('plan-html'));
});

test('html + active run → 409 (active writer)', () => {
  reset('html');
  activeRuns = [{ planId: 'plan-html', runId: 'run-1', status: 'running' }];
  assert.throws(() => assertPlanRailFree('plan-html'), is409);
  assert.throws(() => assertPlanRailFree('plan-html'), /active writer/i);
  // exemptRunId clears its own reservation.
  assert.doesNotThrow(() => assertPlanRailFree('plan-html', { exemptRunId: 'run-1' }));
});

test('html + live plan-bound agent → 409 (live agent)', () => {
  reset('html');
  liveAgent = { id: 'agent-9', status: 'working' };
  assert.throws(() => assertPlanRailFree('plan-html'), is409);
  assert.throws(() => assertPlanRailFree('plan-html'), /live plan-bound agent/i);
});

test('html + in-flight trail materialization → 409 (finalizing)', () => {
  reset('html');
  materializing = true;
  assert.throws(() => assertPlanRailFree('plan-html'), is409);
  assert.throws(() => assertPlanRailFree('plan-html'), /finalizing/i);
});

// ── structured / md → BYPASS (even with a live reservation present) ─────────────

test('structured + active run + live agent + materializing → BYPASS (no throw)', () => {
  reset('structured');
  activeRuns = [{ planId: 'plan-s', runId: 'run-2', status: 'running' }];
  liveAgent = { id: 'agent-1', status: 'working' };
  materializing = true;
  assert.doesNotThrow(() => assertPlanRailFree('plan-s'),
    'a structured plan is not an HTML writeback surface — the guard must short-circuit');
});

test('md + active run → BYPASS (no throw)', () => {
  reset('md');
  activeRuns = [{ planId: 'plan-md', runId: 'run-3', status: 'running' }];
  assert.doesNotThrow(() => assertPlanRailFree('plan-md'));
});

// ── unknown / missing / empty id → safe no-crash BYPASS ─────────────────────────

test('unknown plan id (getPlan → null) + active run → BYPASS, no crash', () => {
  reset('MISSING');
  activeRuns = [{ planId: 'plan-ghost', runId: 'run-4', status: 'running' }];
  assert.doesNotThrow(() => assertPlanRailFree('plan-ghost'));
});

test('empty-string plan id → BYPASS, no crash', () => {
  reset('MISSING');
  assert.doesNotThrow(() => assertPlanRailFree(''));
});

// ── the verdict follows the TRUSTED stored row, not any caller input ─────────────

test('flipping the stored format flips the verdict for the SAME id + reservation', () => {
  activeRuns = [{ planId: 'plan-flip', runId: 'run-5', status: 'running' }];
  liveAgent = null;
  materializing = false;

  storedFormat = 'structured';
  assert.doesNotThrow(() => assertPlanRailFree('plan-flip'), 'structured row → bypass');

  storedFormat = 'html';
  assert.throws(() => assertPlanRailFree('plan-flip'), is409, 'html row → guarded');
  // The signature carries NO format parameter — the caller cannot supply one.
  assert.equal(assertPlanRailFree.length <= 2, true, 'assertPlanRailFree takes only (planId, opts)');
});

test('only starting|running runs reserve; a completed run on an html plan does not', () => {
  reset('html');
  activeRuns = [{ planId: 'plan-html', runId: 'run-6', status: 'complete' }];
  assert.doesNotThrow(() => assertPlanRailFree('plan-html'));
});

// ── drift guard: all three external dispatch call sites invoke the guard ─────────

// __dirname at runtime is dist/main/main/orchestration → four hops to repo root.
const REPO = path.join(__dirname, '..', '..', '..', '..');
const CALL_SITES = [
  path.join('src', 'main', 'api-server.ts'),
  path.join('src', 'main', 'ipc-handlers.ts'),
  path.join('src', 'main', 'orchestration', 'service.ts'),
];

test('all three dispatch call sites still call assertPlanRailFree (source drift guard)', () => {
  for (const rel of CALL_SITES) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.match(src, /assertPlanRailFree\(/, `${rel} must invoke assertPlanRailFree`);
  }
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
