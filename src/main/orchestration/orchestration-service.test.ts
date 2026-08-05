// OrchestrationService lifecycle tests (plan §7).
//
// Drives the service with INJECTED runners + a fake deliver fn so the lifecycle
// (detach / persist / emit / deliver / abort / boot-reconcile) is exercised
// without the real groupthink relay loop. The SQLite native binding is compiled
// for Electron's ABI (not plain node), so — like api-server-status.test.ts —
// we patch the database module's exports with an in-memory store rather than
// opening a real DB. The service reads those exports at call time, so patching
// the shared module object is picked up.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/orchestration-service.test.js

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { assertGroupthinkProvider, OrchestrationService } from './service';
import { DashboardClient, OrchestrationRun, OrchestrationRunContext, OrchestrationRunner } from './types';

// ── In-memory DB patch ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../database') as Record<string, any>;
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const runsStore = new Map<string, OrchestrationRun>();
const eventsStore: Array<{ runId: string; ts: string; kind: string; payload: unknown }> = [];

db.getWorkspace = (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: os.tmpdir() } : null);
// Fix 3 (planning-surface demo): start_run now resolves getPlan(planId).path for
// rail runs. These lifecycle tests don't assert path resolution, so a plans store
// keyed by id suffices; unknown ids fall back to null → the legacy planPath default.
const plansStore = new Map<string, { id: string; workspaceId: string; path: string; format?: string }>();
db.getPlan = (id: string) => (plansStore.has(id) ? clone(plansStore.get(id)!) : null);
db.insertOrchestration = (r: OrchestrationRun) => { runsStore.set(r.runId, clone(r)); };
db.updateOrchestration = (r: OrchestrationRun) => { runsStore.set(r.runId, clone(r)); };
db.getOrchestrationRun = (id: string) => (runsStore.has(id) ? clone(runsStore.get(id)!) : null);
db.listOrchestrationRuns = () => Array.from(runsStore.values()).map(clone);
db.insertOrchestrationEvent = (e: any) => { eventsStore.push(clone(e)); };
db.insertOrchestrationMember = () => {};
db.markActiveRunsAborted = (reason: string) => {
  const affected: OrchestrationRun[] = [];
  for (const r of runsStore.values()) {
    if (r.status === 'starting' || r.status === 'running') {
      affected.push(clone(r));
      r.status = 'aborted';
      r.error = reason;
    }
  }
  return affected;
};

const getRun = (runId: string): OrchestrationRun | null => db.getOrchestrationRun(runId);
const eventsFor = (runId: string) => eventsStore.filter((e) => e.runId === runId);

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Helpers ──────────────────────────────────────────────────────────

function makeClient(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    launchAgent: async () => ({ id: 'agent-x' } as any),
    getAgent: () => null,
    getMessages: async () => [],
    sendInput: async () => {},
    sendInputConfirmed: async () => ({ delivered: true, confirmed: true, mode: 'hook' as const }),
    resubmitEnter: () => {},
    recoverChatBinding: () => {},
    isInputInFlight: () => false,
    stopAgent: async () => {},
    ...overrides,
  };
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void; }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function makeDeliver(ok = true) {
  const calls: Array<{ supervisorId: string; text: string }> = [];
  const fn = async (supervisorId: string, text: string) => { calls.push({ supervisorId, text }); return { ok }; };
  return { fn, calls };
}

function baseReq(extra: Record<string, unknown> = {}) {
  return {
    name: 'groupthink' as const,
    workspaceId: 'ws-1',
    supervisorId: 'sup-1',
    topic: 'Plan a thing',
    mode: 'serial' as const,
    ...extra,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

test('assertGroupthinkProvider accepts launchable providers and rejects discontinued or unsupported values', () => {
  for (const role of ['lead_provider', 'reviewer_provider'] as const) {
    for (const provider of ['claude', 'codex', 'grok', 'agy']) {
      assert.doesNotThrow(() => assertGroupthinkProvider(role, provider));
    }
    assert.doesNotThrow(() => assertGroupthinkProvider(role, undefined));

    for (const provider of ['gemini', 'unknown', '']) {
      assert.throws(
        () => assertGroupthinkProvider(role, provider),
        (err: unknown) => {
          const typed = err as { statusCode?: number; message?: string };
          assert.equal(typed.statusCode, 422);
          if (provider === 'gemini') {
            assert.match(typed.message ?? '', /Gemini provider discontinued/);
          } else {
            assert.match(typed.message ?? '', new RegExp(`Unsupported ${role}`));
            assert.match(typed.message ?? '', /claude, codex, grok, agy/);
          }
          return true;
        },
      );
    }
  }
});

test('discontinued Gemini providers are rejected before an orchestration run is persisted', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  for (const field of ['leadProvider', 'reviewerProvider'] as const) {
    const before = runsStore.size;
    assert.throws(
      () => svc.start_run(baseReq({ [field]: 'gemini' })),
      (err: unknown) => {
        const typed = err as { statusCode?: number; message?: string };
        assert.equal(typed.statusCode, 422);
        assert.match(typed.message ?? '', /Gemini provider discontinued/);
        assert.match(typed.message ?? '', /Antigravity \(agy\)/);
        return true;
      },
    );
    assert.equal(runsStore.size, before);
  }
});

test('fresh runs accept every provider in either slot, including same-provider pairs', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  for (const provider of ['claude', 'codex', 'grok', 'agy']) {
    const leadRun = svc.start_run(baseReq({ leadProvider: provider }));
    assert.equal(getRun(leadRun.runId)?.leadProvider, provider);

    const reviewerRun = svc.start_run(baseReq({ reviewerProvider: provider }));
    assert.equal(getRun(reviewerRun.runId)?.reviewerProvider, provider);

    const sameProviderRun = svc.start_run(baseReq({ leadProvider: provider, reviewerProvider: provider }));
    assert.equal(getRun(sameProviderRun.runId)?.leadProvider, provider);
    assert.equal(getRun(sameProviderRun.runId)?.reviewerProvider, provider);
  }
});

test('fresh runs reject unknown and empty providers before persistence', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  for (const field of ['leadProvider', 'reviewerProvider'] as const) {
    for (const provider of ['unknown', '']) {
      const before = runsStore.size;
      assert.throws(
        () => svc.start_run(baseReq({ [field]: provider })),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
      );
      assert.equal(runsStore.size, before);
    }
  }
});

function priorRun(runId: string, leadProvider = 'claude', reviewerProvider = 'codex'): OrchestrationRun {
  const now = new Date().toISOString();
  return {
    runId,
    name: 'groupthink',
    mode: 'serial',
    status: 'aborted',
    workspaceId: 'ws-1',
    supervisorId: 'sup-1',
    topic: 'Resume provider test',
    planPath: path.join(os.tmpdir(), `${runId}.md`),
    leadProvider,
    reviewerProvider,
    turnTimeoutMs: 600000,
    lastRelayedTs: {},
    startedAt: now,
    updatedAt: now,
  };
}

test('resume rejects provider mutation with 409, including legacy-command-derived providers', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  db.insertOrchestration(priorRun('resume-mismatch'));

  assert.throws(
    () => svc.start_run(baseReq({ resumeRunId: 'resume-mismatch', leadProvider: 'grok' })),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 409,
  );
  assert.throws(
    () => svc.start_run(baseReq({
      resumeRunId: 'resume-mismatch',
      legacyCommand: 'node scripts/groupthink-v2.js --reviewerProvider=agy',
    })),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 409,
  );
});

test('resume accepts matching providers', () => {
  const runner: OrchestrationRunner = async () => {};
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });
  db.insertOrchestration(priorRun('resume-match', 'grok', 'agy'));

  const resumed = svc.start_run(baseReq({
    resumeRunId: 'resume-match',
    leadProvider: 'grok',
    reviewerProvider: 'agy',
  }));
  assert.equal(resumed.runId, 'resume-match');
});

test('historical Gemini runs remain readable but cannot be resumed', () => {
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn);
  db.insertOrchestration(priorRun('resume-gemini', 'gemini', 'codex'));

  assert.throws(
    () => svc.start_run(baseReq({ resumeRunId: 'resume-gemini' })),
    (err: unknown) => {
      const typed = err as { statusCode?: number; message?: string };
      assert.equal(typed.statusCode, 422);
      assert.match(typed.message ?? '', /cannot be resumed/);
      return true;
    },
  );
});

test('detached start_run returns a runId before the runner completes; status starts running', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  assert.ok(runId, 'start_run returns a runId synchronously');

  await waitFor(() => getRun(runId)?.status === 'running');
  assert.equal(getRun(runId)!.status, 'running', 'still running while the runner is blocked');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'started'), 'started event emitted');
  assert.equal(calls.length, 0, 'no delivery before completion');

  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  const done = getRun(runId)!;
  assert.equal(done.status, 'complete');
  assert.ok(done.endedAt, 'endedAt stamped on completion');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'complete'), 'complete event emitted');
  assert.equal(calls.length, 1, 'delivered once on completion');
  assert.match(calls[0].text, /groupthink\.complete/);
});

test('a STALL throw transitions the run to stalled + emits a resume_hint', async () => {
  const runner: OrchestrationRunner = async () => { throw new Error('STALL: turn timeout exceeded'); };
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'stalled');
  const run = getRun(runId)!;
  assert.equal(run.status, 'stalled');
  assert.match(run.error || '', /STALL/);
  assert.ok(eventsFor(runId).some((e) => e.kind === 'stalled'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /orchestration\.groupthink\.stalled/);
  assert.match(calls[0].text, new RegExp(runId), 'resume_hint carries the runId');
});

test('a non-stall throw transitions the run to error', async () => {
  const runner: OrchestrationRunner = async () => { throw new Error('boom: unexpected'); };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'error');
  assert.equal(getRun(runId)!.status, 'error');
  assert.ok(eventsFor(runId).some((e) => e.kind === 'error'));
});

test('abort cancels the run, delivers an aborted event, and persists aborted', async () => {
  const runner: OrchestrationRunner = async (_client, ctx: OrchestrationRunContext) =>
    new Promise<void>((_resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error('aborted'));
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'running');

  const res = svc.abort(runId);
  assert.equal(res.ok, true);
  assert.equal(getRun(runId)!.status, 'aborted');
  await waitFor(() => calls.some((c) => /orchestration\.groupthink\.aborted/.test(c.text)));
  // The runner rejection after abort must NOT also deliver a stalled event.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!calls.some((c) => /stalled/.test(c.text)), 'no stalled delivery on an aborted run');
});

test('delivery_failed event is recorded when the supervisor is unreachable', async () => {
  const runner: OrchestrationRunner = async () => {};
  const { fn } = makeDeliver(false);   // deliver always reports ok:false
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'complete');
  await waitFor(() => eventsFor(runId).some((e) => e.kind === 'delivery_failed'));
  assert.ok(eventsFor(runId).some((e) => e.kind === 'delivery_failed'));
});

test('boot reconcile marks orphaned running rows aborted + emits a resume hint', async () => {
  const orphan: OrchestrationRun = {
    runId: 'orphan01',
    name: 'groupthink',
    mode: 'serial',
    status: 'running',
    workspaceId: 'ws-1',
    supervisorId: 'sup-boot',
    topic: 'left mid-flight',
    planPath: path.join(os.tmpdir(), 'plan.md'),
    leadProvider: 'claude',
    reviewerProvider: 'codex',
    turnTimeoutMs: 600000,
    lastRelayedTs: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insertOrchestration(orphan);

  const { fn, calls } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn);
  svc.start();

  assert.equal(getRun('orphan01')!.status, 'aborted');
  await waitFor(() => calls.some((c) => /dashboard_restarted/.test(c.text)));
  const delivered = calls.find((c) => /dashboard_restarted/.test(c.text))!;
  assert.match(delivered.text, /orphan01/, 'resume hint carries the orphaned runId');
  assert.equal(delivered.supervisorId, 'sup-boot');
});

// ── WP6: planning-surface rail persistence ──────────────────────────────────

test('WP6: start_run persists planId + sectionAnchor onto the run row', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const { runId } = svc.start_run(baseReq({ planId: 'plan-abc', sectionAnchor: 'sec_x1' }));
  const run = getRun(runId)!;
  assert.equal(run.planId, 'plan-abc', 'planId frozen on the run');
  assert.equal(run.sectionAnchor, 'sec_x1', 'sectionAnchor frozen on the run');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
});

test('WP-P8B: concurrent dispatches may target the same plan after HTML writeback removal', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const first = svc.start_run(baseReq({ planId: 'plan-shared', sectionAnchor: 'sec_a' }));
  await waitFor(() => getRun(first.runId)?.status === 'running');
  const second = svc.start_run(baseReq({ planId: 'plan-shared', sectionAnchor: 'sec_b' }));
  await waitFor(() => getRun(second.runId)?.status === 'running');
  assert.notEqual(first.runId, second.runId);

  gate.resolve();
  await waitFor(() => getRun(first.runId)?.status === 'complete');
  await waitFor(() => getRun(second.runId)?.status === 'complete');
});

test('WP6: runs without a planId may coexist', () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const { fn } = makeDeliver();
  const svc = new OrchestrationService(makeClient(), fn, { serial: runner, parallel: runner });

  const a = svc.start_run(baseReq());   // legacy fresh-file run, no plan rail
  const b = svc.start_run(baseReq());   // another — no lock applies
  assert.ok(a.runId && b.runId && a.runId !== b.runId, 'two rail-less runs coexist');
  gate.resolve();
});

// ── GT-C §1.6 / §1.10 — T1 trail materialization ordering ────────────

test('a rail run skips legacy stampPlanMembers', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  let stampCalled = false;
  (svc as any).stampPlanMembers = () => { stampCalled = true; };

  const { runId } = svc.start_run(baseReq({ planId: 'plan-t1', sectionAnchor: 'sec_z' }));
  await waitFor(() => getRun(runId)?.status === 'running');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  assert.equal(stampCalled, false, 'the legacy whole-file stamp is skipped on a rail surface');
});

test('a non-rail run stamps its legacy fresh-file output', async () => {
  const gate = deferred();
  const runner: OrchestrationRunner = async () => { await gate.promise; };
  const svc = new OrchestrationService(makeClient(), makeDeliver().fn, { serial: runner, parallel: runner });

  let stampCalled = false;
  (svc as any).stampPlanMembers = () => { stampCalled = true; };

  const { runId } = svc.start_run(baseReq());
  await waitFor(() => getRun(runId)?.status === 'running');
  gate.resolve();
  await waitFor(() => getRun(runId)?.status === 'complete');
  assert.equal(stampCalled, true, 'the non-rail path still stamps groupthink_run');
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
