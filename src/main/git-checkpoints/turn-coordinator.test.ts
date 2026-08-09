// Git-Native WP-G1.5 — turn-coordinator tests.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/turn-coordinator.test.js
//
// PURE LOGIC (no real git / fs / timers): an in-memory turn store that mirrors the
// WP-A0 DB semantics that matter (open→terminal immutability, idempotent close,
// turn_seq allocation) + a programmable `captureEdge` fake that reproduces the
// service's row side-effects (ready → stamp oid/ready/quality; abandoned → degraded
// + reason; skipped → no write) drive the whole before/after state machine. We prove
// the WP-G1.5 test list:
//   - a clean before edge opens `guaranteed` (oid + ready);
//   - a snapshot failure fails OPEN → `degraded`, no `before_oid`, `before_ready=0`,
//     the turn stays open (delivery proceeds);
//   - a delivery reject closes the row `delivery_failed` (never left open);
//   - an overlapping submitted send closes the prior `interrupted` and opens exactly
//     ONE new `degraded` row (`overlapping-active-turn`) — never two open;
//   - completion (hook / idle-fallback via the REAL tracker) closes `accepted` with
//     `after_quality = source`, and repeats are idempotent;
//   - startup reconciliation closes dangling open rows `crashed`, idempotently;
//   - a manual-terminal late-bound turn opens `late`;
//   - crash/stop mark the row terminal with a best-effort after-snapshot.

import assert from 'node:assert/strict';

import type { AllocateTurnFields, TurnRecord, TurnStatus } from '../database';
import type { GitCapability } from '../../shared/types';
import type { CaptureEdgeParams, EdgeCaptureResult } from './checkpoint-service';
import type { AfterQuality, TurnCompleteEvent } from '../supervisor/turn-completion-tracker';
import { TurnCompletionTracker } from '../supervisor/turn-completion-tracker';
import {
  TurnCoordinator,
  type CaptureEdgeFn,
  type CompletionSubscription,
  type CoordinatorTurnStore,
  type TurnContext,
} from './turn-coordinator';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const A = 'agent-A';
const WS = 'ws-1';

/** Let all pending microtasks (the `void completeTurn(...)` chains) settle. */
const flush = (): Promise<void> => new Promise((res) => setImmediate(res));

// ── in-memory turn store (mirrors the WP-A0 accessors' load-bearing semantics) ──

const TERMINAL: ReadonlySet<TurnStatus> = new Set<TurnStatus>([
  'accepted', 'interrupted', 'crashed', 'stopped', 'delivery_failed', 'skipped', 'reverted',
]);

function blankRow(id: string, workspaceId: string, turnSeq: number, f: AllocateTurnFields): TurnRecord {
  return {
    id, workspaceId, turnSeq,
    agentId: f.agentId ?? null, agentTitle: f.agentTitle ?? null,
    ownerAgentId: f.ownerAgentId ?? null, ownerBrickGeneration: f.ownerBrickGeneration ?? null,
    sessionId: f.sessionId ?? null, taskLabel: f.taskLabel ?? null,
    startedAt: f.startedAt ?? null, endedAt: null, status: f.status ?? 'open',
    beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
    beforeReady: false, afterReady: false, beforeQuality: null, afterQuality: null,
    beforeRawFilterBypassed: false, beforeFilteredPaths: null, beforePrunedAt: null, afterPrunedAt: null,
    touched: null, diffStats: null, compactDiff: null, compactDiffProvenance: null, failureReason: null,
  };
}

class FakeStore implements CoordinatorTurnStore {
  readonly rows = new Map<string, TurnRecord>();
  private idc = 0;

  allocateAndInsertTurn(workspaceId: string, fields: AllocateTurnFields): TurnRecord {
    const id = fields.id ?? `turn-${++this.idc}`;
    let max = 0;
    for (const r of this.rows.values()) if (r.workspaceId === workspaceId && r.turnSeq > max) max = r.turnSeq;
    const row = blankRow(id, workspaceId, max + 1, fields);
    this.rows.set(id, row);
    return { ...row };
  }

  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    if (TERMINAL.has(r.status)) throw new Error(`turn ${id} is terminal ('${r.status}') and immutable`);
    const next = (updates as { status?: TurnStatus }).status;
    if (next !== undefined && next !== r.status && !TERMINAL.has(next)) {
      throw new Error(`illegal turn transition 'open' → '${next}'`);
    }
    Object.assign(r, updates);
    return { ...r };
  }

  closeTurn(id: string, status: Exclude<TurnStatus, 'open'>, extra?: Record<string, unknown>, endedAt?: number | null): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    if (TERMINAL.has(r.status)) return { ...r }; // idempotent no-op on a terminal row
    Object.assign(r, extra ?? {}, { status, endedAt: endedAt ?? 0 });
    return { ...r };
  }

  getTurnRecord(id: string): TurnRecord | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  listTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r }));
  }

  listOpenTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && r.status === 'open')
      .map((r) => ({ ...r }));
  }

  openCount(): number {
    return [...this.rows.values()].filter((r) => r.status === 'open').length;
  }
}

// ── programmable captureEdge fake (reproduces the service's row side-effects) ────

type Outcome =
  | { kind: 'ready' }
  | { kind: 'abandoned'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'throw'; message: string };

function makeCapture(store: CoordinatorTurnStore, decide: (p: CaptureEdgeParams) => Outcome = () => ({ kind: 'ready' })) {
  const calls: CaptureEdgeParams[] = [];
  const fn: CaptureEdgeFn = async (p) => {
    calls.push(p);
    const o = decide(p);
    if (o.kind === 'throw') throw new Error(o.message);
    if (o.kind === 'skip') {
      return base(p, { status: 'skipped', skipReason: o.reason });
    }
    if (o.kind === 'abandoned') {
      // Mirror CheckpointService.abandon: degraded + reason, no oid/ref.
      store.updateTurnRecord(p.turnId,
        p.edge === 'before'
          ? { beforeQuality: 'degraded', failureReason: o.reason }
          : { afterQuality: 'none', failureReason: o.reason });
      return base(p, { status: 'abandoned', quality: p.edge === 'before' ? 'degraded' : 'none', failureReason: o.reason });
    }
    // ready — mirror CheckpointService.finalize's ready-write.
    const oid = `oid-${p.edge}-${p.turnId}`;
    const ref = `refs/lares/checkpoints/${p.turnId}/${p.edge}`;
    store.updateTurnRecord(p.turnId,
      p.edge === 'before'
        ? { beforeOid: oid, beforeRef: ref, beforeReady: true, beforeQuality: p.quality }
        : { afterOid: oid, afterRef: ref, afterReady: true, afterQuality: p.quality });
    return base(p, { status: 'ready', oid, ref, ready: true, quality: p.quality });
  };
  return { fn, calls };
}

function base(p: CaptureEdgeParams, over: Partial<EdgeCaptureResult> & { status: EdgeCaptureResult['status'] }): EdgeCaptureResult {
  return {
    status: over.status, edge: p.edge, turnId: p.turnId,
    oid: over.oid ?? null, ref: over.ref ?? null, ready: over.ready ?? false,
    quality: over.quality ?? null, failureReason: over.failureReason ?? null,
    skipReason: over.skipReason,
  };
}

// ── fakes for the completion tracker (subscription-only) ────────────────────────

class FakeCompletion implements CompletionSubscription {
  private listener: ((agentId: string, ev: TurnCompleteEvent) => void) | null = null;
  readonly begun: string[] = [];
  readonly resets: string[] = [];
  onTurnComplete(l: (agentId: string, ev: TurnCompleteEvent) => void): () => void {
    this.listener = l;
    return () => { this.listener = null; };
  }
  beginTurn(agentId: string): void { this.begun.push(agentId); }
  reset(agentId: string): void { this.resets.push(agentId); }
  emit(agentId: string, source: AfterQuality, upgrade = false): void {
    this.listener?.(agentId, { source, afterQuality: source, upgrade, previousSource: undefined } as TurnCompleteEvent);
  }
}

/** A synchronous fake scheduler for the REAL TurnCompletionTracker (idle debounce). */
class FakeScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  set = (fn: () => void, ms: number): number => { const id = this.nextId++; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clear = (h: unknown): void => { this.timers.delete(h as number); };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null; let dueAt = Infinity;
      for (const [id, t] of this.timers) if (t.at <= target && t.at < dueAt) { dueAt = t.at; dueId = id; }
      if (dueId === null) break;
      const t = this.timers.get(dueId)!; this.timers.delete(dueId); this.now = t.at; t.fn();
    }
    this.now = target;
  }
}

// ── capability + context fixtures ───────────────────────────────────────────────

function capFake(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo',
    commonDir: '/repo/.git',
    commonDirQueueKey: '/repo',
    repoRoot: '/repo',
    workspacePrefix: '',
    protectedRoot: false,
    reason: 'ok',
    detail: null,
  };
}

function mkCtx(over: Partial<TurnContext> = {}): TurnContext {
  return { workspaceId: WS, agentId: A, capability: capFake(), taskLabel: 'do a thing', ...over };
}

// ── tests ────────────────────────────────────────────────────────────────────

test('before edge opens a guaranteed turn: oid + ready, row stays open', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  assert.equal(res.ready, true);
  assert.equal(res.quality, 'guaranteed');
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'open');
  assert.equal(row.beforeQuality, 'guaranteed');
  assert.equal(row.beforeReady, true);
  assert.ok(row.beforeOid, 'before_oid is set for a clean snapshot');
  assert.equal(co.currentOpenTurnId(A), res.turnId, 'witness recorder points at the open turn');
  assert.deepEqual(comp.begun, [A], 'the completion tracker was told to begin the turn');
});

test('snapshot failure fails OPEN: degraded, no before_oid, before_ready=0, still open', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store, () => ({ kind: 'abandoned', reason: 'snapshot-failed' }));
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  assert.equal(res.ready, false, 'the before edge is not ready');
  assert.equal(res.quality, 'degraded');
  assert.equal(res.failureReason, 'snapshot-failed');
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'open', 'delivery proceeds — the turn is NOT closed on snapshot failure');
  assert.equal(row.beforeQuality, 'degraded');
  assert.equal(row.beforeReady, false);
  assert.equal(row.beforeOid, null, 'no recovery guarantee — before_oid is NULL');
  assert.equal(row.failureReason, 'snapshot-failed');
});

test('a capability/enumeration skip records degraded + reason and fails open', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store, () => ({ kind: 'skip', reason: 'non-repo' }));
  const co = new TurnCoordinator({ capture: cap.fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  assert.equal(res.ready, false);
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'open');
  assert.equal(row.beforeQuality, 'degraded');
  assert.equal(row.failureReason, 'non-repo');
  assert.equal(row.beforeOid, null);
});

test('a thrown capture never blocks delivery — degraded, row open', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store, () => ({ kind: 'throw', message: 'boom' }));
  const co = new TurnCoordinator({ capture: cap.fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx()); // must resolve, not reject
  assert.equal(res.ready, false);
  assert.equal(res.quality, 'degraded');
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'open');
  assert.equal(row.beforeQuality, 'degraded');
});

test('manual-terminal late-bound turn opens `late`', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const co = new TurnCoordinator({ capture: cap.fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx({ quality: 'late' }));
  assert.equal(res.ready, true);
  assert.equal(res.quality, 'late');
  assert.equal(store.getTurnRecord(res.turnId)!.beforeQuality, 'late', 'late never masquerades as guaranteed');
});

test('delivery reject closes the row `delivery_failed`, never left open; idempotent', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  const closed = co.onDeliveryFailed(A);
  assert.equal(closed, res.turnId);
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'delivery_failed');
  assert.equal(co.currentOpenTurnId(A), null, 'no open turn remains');
  assert.equal(store.openCount(), 0);
  // Idempotent: a second reject for the (now closed) agent is a no-op.
  assert.equal(co.onDeliveryFailed(A), null);
  assert.equal(store.getTurnRecord(res.turnId)!.status, 'delivery_failed');
});

test('overlapping submit closes prior `interrupted` and opens ONE new `degraded` row — never two open', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const first = await co.beforeCheckpoint(A, mkCtx());
  const second = await co.beforeCheckpoint(A, mkCtx()); // overlap: prior still open

  assert.notEqual(second.turnId, first.turnId);
  assert.equal(store.openCount(), 1, 'NEVER two open turns for one agent');
  assert.equal(co.currentOpenTurnId(A), second.turnId, 'witness recorder re-pointed to the new row');

  const prior = store.getTurnRecord(first.turnId)!;
  assert.equal(prior.status, 'interrupted');
  assert.equal(prior.afterQuality, 'none');

  const next = store.getTurnRecord(second.turnId)!;
  assert.equal(next.status, 'open');
  assert.equal(next.beforeQuality, 'degraded');
  assert.equal(next.failureReason, 'overlapping-active-turn');

  // A best-effort degraded after-snapshot of the prior was attempted.
  assert.ok(
    cap.calls.some((c) => c.edge === 'after' && c.turnId === first.turnId),
    'prior turn got a best-effort after-snapshot attempt',
  );
});

test('pending AFTER capture serializes the successor as a normal turn and old cleanup cannot clear it', async () => {
  const store = new FakeStore();
  const comp = new FakeCompletion();
  let releaseAfter!: () => void;
  let afterStarted!: () => void;
  const afterStartedPromise = new Promise<void>((resolve) => { afterStarted = resolve; });
  const afterGate = new Promise<void>((resolve) => { releaseAfter = resolve; });
  const baseCapture = makeCapture(store);
  const capture: CaptureEdgeFn = async (p) => {
    if (p.edge === 'after' && p.turnId === 'turn-1') {
      afterStarted();
      await afterGate;
    }
    return baseCapture.fn(p);
  };
  const co = new TurnCoordinator({ capture, completion: comp, store, now: () => 1000 });

  const first = await co.beforeCheckpoint(A, mkCtx());
  comp.emit(A, 'idle-fallback');
  await afterStartedPromise;

  const successorPending = co.beforeCheckpoint(A, mkCtx());
  await flush();
  assert.equal(store.rows.size, 1, 'successor waits until the closing AFTER capture is durable');

  releaseAfter();
  const successor = await successorPending;
  assert.equal(store.getTurnRecord(first.turnId)!.status, 'accepted');
  assert.equal(successor.quality, 'guaranteed');
  assert.equal(successor.failureReason, null);
  assert.equal(co.currentOpenTurnId(A), successor.turnId,
    'compare-and-delete cleanup for the old turn cannot erase its successor');
  assert.equal(store.openCount(), 1);
});

test('completion (fake tracker) closes `accepted` with after_quality = source; repeats dedup', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  comp.emit(A, 'hook');
  await flush();

  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'accepted');
  assert.equal(row.afterQuality, 'hook', 'after_quality = completion source');
  assert.equal(row.afterReady, true, 'the after snapshot was taken');
  assert.equal(co.currentOpenTurnId(A), null);
  assert.ok(comp.resets.includes(A), 'the tracker was reset on close');

  // Idempotent: a second completion (or a metadata upgrade) can't re-close/rewrite.
  comp.emit(A, 'hook');
  comp.emit(A, 'hook', /*upgrade*/ true);
  await flush();
  assert.equal(store.getTurnRecord(res.turnId)!.status, 'accepted');
});

test('completion via the REAL turn-completion-tracker (idle-fallback) closes accepted', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const sched = new FakeScheduler();
  const tracker = new TurnCompletionTracker({
    now: () => sched.now, setTimer: sched.set, clearTimer: sched.clear,
    idleDebounceMs: 100, upgradeWindowMs: 1000,
  });
  const co = new TurnCoordinator({ capture: cap.fn, completion: tracker, store, now: () => sched.now });

  const res = await co.beforeCheckpoint(A, mkCtx()); // → tracker.beginTurn(A)
  tracker.noteStart(A);
  tracker.noteIdle(A);
  sched.advance(100); // debounce elapses → idle-fallback completes → onCompletion
  await flush();

  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'accepted');
  assert.equal(row.afterQuality, 'idle-fallback');
  assert.equal(co.currentOpenTurnId(A), null);
});

test('crash marks the open turn `crashed` with a best-effort after-snapshot', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const co = new TurnCoordinator({ capture: cap.fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  co.markCrashed(A);
  await flush();
  const row = store.getTurnRecord(res.turnId)!;
  assert.equal(row.status, 'crashed');
  assert.equal(row.afterQuality, 'none');
  assert.equal(co.currentOpenTurnId(A), null);
});

test('stop marks the open turn `stopped`', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const co = new TurnCoordinator({ capture: cap.fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const res = await co.beforeCheckpoint(A, mkCtx());
  co.markStopped(A);
  await flush();
  assert.equal(store.getTurnRecord(res.turnId)!.status, 'stopped');
});

test('startup reconciliation closes dangling open rows `crashed`, idempotently', async () => {
  const store = new FakeStore();
  // Put an old dangling row beyond the UI accessor's newest-50 window.
  const open1 = store.allocateAndInsertTurn(WS, { agentId: A, status: 'open' });
  for (let i = 0; i < 55; i++) {
    store.allocateAndInsertTurn(WS, { agentId: `terminal-${i}`, status: 'accepted' });
  }
  const open2 = store.allocateAndInsertTurn(WS, { agentId: 'agent-B', status: 'open' });
  const done = store.allocateAndInsertTurn(WS, { agentId: 'agent-C', status: 'accepted' });
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });

  const n = co.reconcileOpenTurns(WS);
  assert.equal(n, 2, 'exactly the two open rows were closed');
  assert.equal(store.getTurnRecord(open1.id)!.status, 'crashed');
  assert.equal(store.getTurnRecord(open2.id)!.status, 'crashed');
  assert.equal(store.getTurnRecord(done.id)!.status, 'accepted', 'a terminal row is never re-closed');

  // Idempotent: a second pass finds nothing open.
  assert.equal(co.reconcileOpenTurns(WS), 0);
});

test('shutdown closes all open turns `interrupted` and unsubscribes', async () => {
  const store = new FakeStore();
  const cap = makeCapture(store);
  const comp = new FakeCompletion();
  const co = new TurnCoordinator({ capture: cap.fn, completion: comp, store, now: () => 1000 });

  const a = await co.beforeCheckpoint('agent-1', mkCtx({ agentId: 'agent-1' }));
  const b = await co.beforeCheckpoint('agent-2', mkCtx({ agentId: 'agent-2' }));
  await co.shutdown();

  assert.equal(store.getTurnRecord(a.turnId)!.status, 'interrupted');
  assert.equal(store.getTurnRecord(b.turnId)!.status, 'interrupted');
  assert.equal(store.openCount(), 0);
  // After unsubscribe a late completion event does nothing.
  comp.emit('agent-1', 'hook');
  await flush();
  assert.equal(store.getTurnRecord(a.turnId)!.status, 'interrupted');
});

// ── WP3: task_label populated at openTurn (defect-2) ────────────────────────────

test('openTurn: an orchestration/dispatch submit (explicit brief) yields non-null task_label', async () => {
  const store = new FakeStore();
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });
  // A dispatch carries the brief as ctx.taskLabel (buildDispatchTurnContext maps it).
  const res = await co.beforeCheckpoint(A, mkCtx({ taskLabel: 'Implement the cache', promptText: undefined }));
  assert.equal(store.getTurnRecord(res.turnId)!.taskLabel, 'Implement the cache');
});

test('openTurn: a human-terminal submit (no brief, promptText only) derives a non-null task_label', async () => {
  const store = new FakeStore();
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });
  // Human terminals carry no taskLabel; _deliverAndConfirm attaches ctx.promptText = text.
  const res = await co.beforeCheckpoint(A, mkCtx({ taskLabel: undefined, promptText: '@worker  fix the\tlogin bug\nand ship it' }));
  assert.equal(store.getTurnRecord(res.turnId)!.taskLabel, 'fix the login bug', 'derived from the first prompt line');
});

test('openTurn precedence: explicit brief BEATS promptText (mutation check)', async () => {
  const store = new FakeStore();
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });
  const res = await co.beforeCheckpoint(A, mkCtx({ taskLabel: 'Explicit brief', promptText: 'derived would-be label' }));
  const label = store.getTurnRecord(res.turnId)!.taskLabel;
  assert.equal(label, 'Explicit brief', 'the brief wins; the derived promptText label must NOT be used');
  assert.notEqual(label, 'derived would-be label');
});

test('openTurn precedence: a BLANK brief falls through to the derived promptText label', async () => {
  const store = new FakeStore();
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });
  const res = await co.beforeCheckpoint(A, mkCtx({ taskLabel: '   ', promptText: 'derived label' }));
  assert.equal(store.getTurnRecord(res.turnId)!.taskLabel, 'derived label', 'a whitespace-only brief is not a usable label');
});

test('openTurn: no brief and no usable promptText → task_label null', async () => {
  const store = new FakeStore();
  const co = new TurnCoordinator({ capture: makeCapture(store).fn, completion: new FakeCompletion(), store, now: () => 1000 });
  const res = await co.beforeCheckpoint(A, mkCtx({ taskLabel: undefined, promptText: '   \n\n  ' }));
  assert.equal(store.getTurnRecord(res.turnId)!.taskLabel, null);
});

// ── runner ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
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
}

void main();
