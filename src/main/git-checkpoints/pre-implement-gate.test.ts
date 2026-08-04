// WP-P5C-gate — pre-Implement enforcement seam.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/pre-implement-gate.test.js
//
// PURE LOGIC. Proves the WP-P5C-gate contract at the shared SC-WP-2B DispatchDeps
// boundary (`resolveRequestedPlanBinding` / `buildDispatchTurnContext`):
//   - a `format='structured'` plan lacking an active execution run cannot be bound to
//     a worker — via an explicit plan+item, an explicit plan with NO item, or the
//     agent-default source;
//   - once an active execution run exists (post-Implement), the same binding is
//     allowed;
//   - a legacy HTML/md plan (isStructured:false) is NEVER gated — behavior unchanged;
//   - the gate is consulted with the RESOLVED plan id (explicit id; agent.planId for
//     the default source), and never for a null-plan binding (`explicit-none`);
//   - a boundary that wires no gate leaves the seam inactive (legacy transition);
//   - a gate lookup that THROWS fails closed (refused, never opened);
//   - a trusted lifecycle stamp bypasses the gate; a rejected wire binding collapses
//     the built TurnContext to null (fail-open builder, delivery unaffected).

import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import {
  buildDispatchTurnContext,
  resolveRequestedPlanBinding,
  withResolvedPlanStamp,
  type DispatchAgentInfo,
  type DispatchDeps,
  type PlanImplementGate,
} from './dispatch-context';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function capability(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

// A repo of plan gate verdicts, keyed by plan id. Any plan not listed is unknown
// (gate returns null → ungated legacy).
type GateRepo = Record<string, PlanImplementGate>;

const STRUCTURED_NO_RUN: PlanImplementGate = { isStructured: true, hasActiveExecutionRun: false };
const STRUCTURED_ACTIVE: PlanImplementGate = { isStructured: true, hasActiveExecutionRun: true };
const LEGACY_HTML: PlanImplementGate = { isStructured: false, hasActiveExecutionRun: false };

const agentWith = (planId: string | null): DispatchAgentInfo => ({ workspaceId: 'ws-1', planId });

function deps(gate: GateRepo, over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    getAgent: (id) => id === 'worker' ? agentWith('plan-struct') : null,
    resolveCapability: async () => capability(),
    // Every plan named in a gate test is treated as a valid workspace member so the
    // gate — not a plan-not-in-workspace rejection — is what decides.
    planInWorkspace: () => true,
    planItemInPlan: () => true,
    planImplementGate: (planId) => gate[planId] ?? null,
    ...over,
  };
}

// ── explicit bindings ──────────────────────────────────────────────────────────

test('structured plan without an active run: explicit plan+item is REFUSED', () => {
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: 'item-1',
  }), { ok: false, reason: 'structured-plan-not-implemented' });
});

test('structured plan without an active run: explicit plan with NO item is REFUSED', () => {
  // The spec calls this case out explicitly — an explicit planId with no planItemId.
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: null,
  }), { ok: false, reason: 'structured-plan-not-implemented' });
});

test('structured plan WITH an active run: explicit plan+item is ALLOWED', () => {
  const d = deps({ 'plan-struct': STRUCTURED_ACTIVE });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: 'item-1',
  }), {
    ok: true,
    stamp: { planId: 'plan-struct', planItemId: 'item-1', source: 'explicit' },
  });
});

test('structured plan WITH an active run: explicit plan with no item is ALLOWED', () => {
  const d = deps({ 'plan-struct': STRUCTURED_ACTIVE });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: null,
  }), {
    ok: true,
    stamp: { planId: 'plan-struct', planItemId: null, source: 'explicit' },
  });
});

// ── agent-default binding ────────────────────────────────────────────────────────

test('agent-default onto a structured plan without an active run is REFUSED', () => {
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith('plan-struct'), undefined), {
    ok: false, reason: 'structured-plan-not-implemented',
  });
  // The `agent-default` explicit mode form is gated identically.
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith('plan-struct'), { mode: 'agent-default' }), {
    ok: false, reason: 'structured-plan-not-implemented',
  });
});

test('agent-default onto a structured plan WITH an active run is ALLOWED', () => {
  const d = deps({ 'plan-struct': STRUCTURED_ACTIVE });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith('plan-struct'), undefined), {
    ok: true,
    stamp: { planId: 'plan-struct', planItemId: null, source: 'agent-default' },
  });
});

test('the gate is consulted with the RESOLVED plan id (agent.planId for the default)', () => {
  const seen: string[] = [];
  const d = deps({ 'plan-struct': STRUCTURED_ACTIVE }, {
    planImplementGate: (planId) => { seen.push(planId); return STRUCTURED_ACTIVE; },
  });
  resolveRequestedPlanBinding(d, agentWith('plan-struct'), undefined);
  resolveRequestedPlanBinding(d, agentWith(null), { mode: 'explicit', planId: 'plan-explicit', planItemId: null });
  assert.deepEqual(seen, ['plan-struct', 'plan-explicit']);
});

// ── null-plan bindings are never gated ───────────────────────────────────────────

test('explicit-none never consults the gate (nothing is bound)', () => {
  let consulted = false;
  const d = deps({}, { planImplementGate: () => { consulted = true; return STRUCTURED_NO_RUN; } });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith('plan-struct'), { mode: 'none' }), {
    ok: true, stamp: { planId: null, planItemId: null, source: 'explicit-none' },
  });
  assert.equal(consulted, false, 'a null-plan stamp is never gated');
});

test('agent-default with no default plan (null planId) is not gated', () => {
  let consulted = false;
  const d = deps({}, { planImplementGate: () => { consulted = true; return STRUCTURED_NO_RUN; } });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), undefined), {
    ok: true, stamp: { planId: null, planItemId: null, source: 'agent-default' },
  });
  assert.equal(consulted, false);
});

// ── legacy HTML plans are unaffected ─────────────────────────────────────────────

test('legacy HTML plan (isStructured:false) is NEVER gated — explicit and default', () => {
  const d = deps({ 'plan-html': LEGACY_HTML });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-html', planItemId: null,
  }), { ok: true, stamp: { planId: 'plan-html', planItemId: null, source: 'explicit' } });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith('plan-html'), undefined), {
    ok: true, stamp: { planId: 'plan-html', planItemId: null, source: 'agent-default' },
  });
});

test('a plan unknown to the gate (null verdict) is passed through as legacy', () => {
  const d = deps({}); // gate repo empty → every lookup returns null
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-mystery', planItemId: null,
  }), { ok: true, stamp: { planId: 'plan-mystery', planItemId: null, source: 'explicit' } });
});

// ── seam-off and fail-closed ─────────────────────────────────────────────────────

test('a boundary that wires no gate leaves the seam inactive (legacy transition)', () => {
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN }, { planImplementGate: undefined });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: null,
  }), { ok: true, stamp: { planId: 'plan-struct', planItemId: null, source: 'explicit' } });
});

test('a gate lookup that THROWS fails closed (refused, never opened)', () => {
  const d = deps({}, { planImplementGate: () => { throw new Error('db down'); } });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: null,
  }), { ok: false, reason: 'structured-plan-not-implemented' });
});

// ── ordering: item validity is not a way around the gate ─────────────────────────

test('an invalid item still rejects on the item reason (gate is not consulted early)', () => {
  // A structured plan with an item absent from it rejects as plan-item-not-in-plan —
  // the gate never has to weigh in, and this stays distinguishable from the gate reason.
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN }, { planItemInPlan: () => false });
  assert.deepEqual(resolveRequestedPlanBinding(d, agentWith(null), {
    mode: 'explicit', planId: 'plan-struct', planItemId: 'ghost',
  }), { ok: false, reason: 'plan-item-not-in-plan' });
});

// ── end-to-end through the context builder ───────────────────────────────────────

test('buildDispatchTurnContext: a gated wire binding collapses the context to null', async () => {
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN });
  const ctx = await buildDispatchTurnContext(d, 'worker', {
    origin: 'api',
    requestedPlanBinding: { mode: 'explicit', planId: 'plan-struct', planItemId: null },
  });
  assert.equal(ctx, null, 'a refused pre-Implement binding builds no turn context');
});

test('buildDispatchTurnContext: an active-run structured plan builds the context', async () => {
  const d = deps({ 'plan-struct': STRUCTURED_ACTIVE });
  const ctx = await buildDispatchTurnContext(d, 'worker', {
    origin: 'api',
    requestedPlanBinding: { mode: 'explicit', planId: 'plan-struct', planItemId: 'item-1' },
  });
  assert.ok(ctx);
  assert.deepEqual(ctx!.planStamp, { planId: 'plan-struct', planItemId: 'item-1', source: 'explicit' });
});

test('buildDispatchTurnContext: a trusted lifecycle stamp BYPASSES the gate', async () => {
  // The Implement/dispatch rail has already minted the run; its trusted symbol stamp
  // must not be re-gated even though the gate would otherwise refuse this plan.
  const d = deps({ 'plan-struct': STRUCTURED_NO_RUN });
  const dispatch = withResolvedPlanStamp(
    { origin: 'orchestration', requestedPlanBinding: { mode: 'none' } },
    { planId: 'plan-struct', planItemId: 'item-1', source: 'explicit' },
  );
  const ctx = await buildDispatchTurnContext(d, 'worker', dispatch);
  assert.ok(ctx, 'a trusted lifecycle stamp dispatches even for a pre-run structured plan');
  assert.deepEqual(ctx!.planStamp, { planId: 'plan-struct', planItemId: 'item-1', source: 'explicit' });
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
