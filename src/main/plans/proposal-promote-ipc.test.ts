// WP-P3C′ acceptance — the `proposal:promote` / `proposal:promotionStatus` IPC.
//
//   npm run build:main
//   node dist/main/main/plans/proposal-promote-ipc.test.js
//
// Proves (mapping to the WP Accept list): the picked supervisor is re-validated
// SERVER-side (non-privileged / cross-workspace / unknown → rejected, nothing
// minted); the discriminated `PromoteProposalResult` is returned (adopted → the
// plan; promotion-pending → the request id + plan artifact id); the rejecting core
// outcomes (foreign / duplicate / failed) throw, never a silent status;
// `promotionStatus` reflects the durable promotion_requests / plans state; and a
// REPEAT promote reflects the existing operation (the handler mints nothing of its
// own — no second worker). All promotion business logic is injected behind the
// service seam, so these are pure handler tests (no DB, no electron).

import assert from 'node:assert/strict';

import {
  runPromoteProposal,
  runPromotionStatus,
  type PromoteIpcDeps,
  type PromotionService,
} from './plan-ipc';
import type { Agent, Plan } from '../../shared/types';
import type { PromoteResult, ProposalRef } from './promote-proposal';
import type { StructuredPlanRow, PromotionRequestRow } from '../database';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-1';

function proposalRef(over: Partial<ProposalRef> = {}): ProposalRef {
  return {
    proposalId: 'prop-row-1',
    artifactId: 'prop_abc123',
    relPath: '.lares/proposals/2026-08-03-auth.md',
    workspaceId: WS,
    ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  // Only the fields hasSupervisorPrivilege + the workspace check read matter.
  return { id: 'sup-1', workspaceId: WS, isSupervisor: true, ...over } as Agent;
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-row-1', workspaceId: WS, path: '.lares/plans/x/plan.md', slug: null,
    format: 'structured', runState: 'hardening', mtimeMs: 0, sizeBytes: 0,
    createdAt: '', updatedAt: '', deletedAt: null, ...over,
  };
}

function structuredRow(over: Partial<StructuredPlanRow> = {}): StructuredPlanRow {
  return {
    id: 'plan-row-1', workspaceId: WS, artifactId: 'plan_abc123',
    folderRelPath: '.lares/plans/x', path: '.lares/plans/x/plan.md', format: 'structured',
    runState: 'hardening', mtimeMs: 0, sizeBytes: 0, deletedAt: null, ...over,
  };
}

function requestRow(over: Partial<PromotionRequestRow> = {}): PromotionRequestRow {
  return {
    id: 'req-1', workspaceId: WS, proposalId: 'prop-row-1', proposalArtifactId: 'prop_abc123',
    planArtifactId: 'plan_abc123', targetFolderRelPath: '.lares/plans/x', supervisorId: 'sup-1',
    orchestrationId: null, state: 'pending', attemptCount: 1, failureReason: null,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

/** A service whose `promote` returns a fixed PromoteResult and records its calls. */
function fakeService(result: PromoteResult, proposal: ProposalRef | null = proposalRef()): {
  service: PromotionService; calls: { promote: number; resolve: number };
} {
  const calls = { promote: 0, resolve: 0 };
  const service: PromotionService = {
    async promote() { calls.promote++; return result; },
    resolveProposal() { calls.resolve++; return proposal; },
  };
  return { service, calls };
}

function baseDeps(over: Partial<PromoteIpcDeps> = {}): PromoteIpcDeps {
  return {
    service: fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' }).service,
    getAgent: () => agent(),
    getPlan: () => plan(),
    getPlanByWorkspaceArtifactId: () => structuredRow(),
    getPromotionRequestById: () => requestRow(),
    ...over,
  };
}

async function rejects(fn: () => Promise<unknown>, matcher: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof Error && matcher.test(err.message), `expected /${matcher.source}/, got: ${String(err)}`);
    return true;
  });
}

// ── promote: server-side supervisor revalidation ─────────────────────────────

test('rejects a non-privileged agent SERVER-side (nothing minted)', async () => {
  const { service, calls } = fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service, getAgent: () => agent({ isSupervisor: false, privilegeLane: undefined }) });
  await rejects(() => runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps), /eligible supervisor/);
  assert.equal(calls.promote, 0, 'promote() (the minting path) was never called');
});

test('rejects a supervisor from a DIFFERENT workspace', async () => {
  const { service, calls } = fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service, getAgent: () => agent({ workspaceId: 'ws-other' }) });
  await rejects(() => runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps), /eligible supervisor/);
  assert.equal(calls.promote, 0);
});

test('rejects an unknown supervisor id', async () => {
  const deps = baseDeps({ getAgent: () => null });
  await rejects(() => runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'ghost' }, deps), /eligible supervisor/);
});

test('accepts a privileged persona on the supervisor lane (isSupervisor=false, privilegeLane=supervisor)', async () => {
  const { service } = fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service, getAgent: () => agent({ isSupervisor: false, privilegeLane: 'supervisor' }) });
  const res = await runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps);
  assert.equal(res.status, 'promotion-pending');
});

// ── promote: discriminated result mapping ────────────────────────────────────

test('adopted core result → { status: "adopted", plan }', async () => {
  const { service } = fakeService({ status: 'adopted', planId: 'plan-row-1', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service, getPlanByWorkspaceArtifactId: () => structuredRow(), getPlan: () => plan({ id: 'plan-row-1' }) });
  const res = await runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps);
  assert.equal(res.status, 'adopted');
  assert.equal((res as { status: 'adopted'; plan: Plan }).plan.id, 'plan-row-1');
});

test('promotion-pending core result → { status, promotionRequestId, planArtifactId }', async () => {
  const { service } = fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service });
  const res = await runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps);
  assert.deepEqual(res, { status: 'promotion-pending', promotionRequestId: 'req-1', planArtifactId: 'plan_abc123' });
});

test('rejecting core outcomes (foreign / duplicate / failed) throw, never a silent status', async () => {
  for (const [result, matcher] of [
    [{ status: 'rejected-foreign', diagnostic: 'claimed by prop_other' } as PromoteResult, /prop_other/],
    [{ status: 'duplicate-blocked', diagnostic: '2 claimants' } as PromoteResult, /claimants/],
    [{ status: 'failed', requestId: 'req-1', reason: 'launch boom' } as PromoteResult, /launch boom/],
  ] as const) {
    const { service } = fakeService(result);
    await rejects(() => runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, baseDeps({ service })), matcher);
  }
});

test('adopted but the plans row is missing → throws (never a plan-less adopted)', async () => {
  const { service } = fakeService({ status: 'adopted', planId: 'plan-row-1', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service, getPlanByWorkspaceArtifactId: () => null });
  await rejects(() => runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps), /no plan row/);
});

test('missing service and unknown proposal reject honestly', async () => {
  await rejects(() => runPromoteProposal({ proposalId: 'p', supervisorId: 's' }, baseDeps({ service: null })), /unavailable/);
  const { service } = fakeService({ status: 'promotion-pending', planArtifactId: 'x', requestId: 'r' }, null);
  await rejects(() => runPromoteProposal({ proposalId: 'p', supervisorId: 's' }, baseDeps({ service })), /proposal not found/);
});

test('bad input (missing proposalId / supervisorId) rejects', async () => {
  await rejects(() => runPromoteProposal({ supervisorId: 's' }, baseDeps()), /proposalId/);
  await rejects(() => runPromoteProposal({ proposalId: 'p' }, baseDeps()), /supervisorId/);
});

test('a REPEAT promote reflects the existing operation — the handler mints nothing new', async () => {
  // Model core idempotency: promote() returns the SAME request id both times and
  // never a second/new one. The handler must simply reflect it.
  const { service, calls } = fakeService({ status: 'promotion-pending', planArtifactId: 'plan_abc123', requestId: 'req-1' });
  const deps = baseDeps({ service });
  const first = await runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps);
  const second = await runPromoteProposal({ proposalId: 'prop-row-1', supervisorId: 'sup-1' }, deps);
  assert.deepEqual(first, second, 'repeat reflects the same pending operation');
  assert.equal(calls.promote, 2, 'each call delegates to the idempotent core, which mints no second worker');
});

// ── promotionStatus: reflects durable DB state ───────────────────────────────

test('promotionStatus reflects a pending request (plan null)', () => {
  const deps = baseDeps({ getPromotionRequestById: () => requestRow({ state: 'pending' }) });
  const status = runPromotionStatus({ promotionRequestId: 'req-1' }, deps);
  assert.equal(status.state, 'pending');
  assert.equal(status.plan, null);
  assert.equal(status.planArtifactId, 'plan_abc123');
  assert.equal(status.attemptCount, 1);
});

test('promotionStatus reflects an adopted request (plan resolved from the plans row)', () => {
  const deps = baseDeps({
    getPromotionRequestById: () => requestRow({ state: 'adopted' }),
    getPlanByWorkspaceArtifactId: () => structuredRow(),
    getPlan: () => plan({ id: 'plan-row-1' }),
  });
  const status = runPromotionStatus({ promotionRequestId: 'req-1' }, deps);
  assert.equal(status.state, 'adopted');
  assert.equal(status.plan?.id, 'plan-row-1');
});

test('promotionStatus reflects a failed request (failureReason surfaced, plan null)', () => {
  const deps = baseDeps({ getPromotionRequestById: () => requestRow({ state: 'failed', failureReason: 'scaffold boom' }) });
  const status = runPromotionStatus({ promotionRequestId: 'req-1' }, deps);
  assert.equal(status.state, 'failed');
  assert.equal(status.failureReason, 'scaffold boom');
  assert.equal(status.plan, null);
});

test('promotionStatus on an unknown request id throws', () => {
  const deps = baseDeps({ getPromotionRequestById: () => null });
  assert.throws(() => runPromotionStatus({ promotionRequestId: 'nope' }, deps), /unknown promotion request/);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
