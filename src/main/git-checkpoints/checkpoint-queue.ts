// checkpoint-queue.ts — per-key priority serialization with eager, timer-driven
// deadline expiry (Git-Native WP-G1.2). MAIN-PROCESS ONLY.
//
// Every Lares checkpoint / recovery git op runs through this queue so that ops
// touching the SAME object database never overlap, while ops on different repos
// stay fully concurrent. The serialization key is the caller's
// `commonDirQueueKey` (plan §2.8) — case-folding on Windows already happened in
// git-runtime, so we treat the key as an OPAQUE string and never re-normalize it.
//
// Why a scheduler, not a plain promise chain:
//   The per-agent `inputQueues` idiom in supervisor/index.ts is a FIFO
//   promise-chain with `.catch` isolation. We keep both of those properties —
//   at most one running op per key, and a rejected op never poisons the key —
//   but a FIFO chain cannot (a) reorder by priority or (b) expire a queued item
//   *before its turn*. Both are core to this WP, so the queue is a small
//   priority scheduler instead of a literal `.then` chain. The behavioral
//   contract (single-flight per key, catch-isolation) is identical.
//
// The heart of the WP — EAGER, TIMER-DRIVEN EXPIRY:
//   Each queued item arms its OWN deadline timer at enqueue. When that timer
//   fires and the item has NOT started, the item is atomically removed from the
//   key's queue and its promise resolves IMMEDIATELY as `{ skipped: 'deadline' }`
//   — without waiting for the currently-running op to finish or for the item's
//   own turn to dequeue. So a long AFTER holding a key can never delay a BEFORE
//   past the BEFORE's deadline. An already-STARTED item is never cancelled by
//   its timer. Priority only orders items that are both eligible to start; it
//   never overrides eager expiry.
//
// Pure logic: no git exec, no filesystem. All timers are unref'd so a pending
// deadline never holds the process open, and every item's timer is cleared the
// moment it starts or completes (no dangling handles after resolution).

/** Serialization priorities, strongest first: `RESTORE > BEFORE > AFTER > MAINTENANCE`. */
export type CheckpointPriority = 'RESTORE' | 'BEFORE' | 'AFTER' | 'MAINTENANCE';

/** Higher rank dequeues first. MAINTENANCE (0) is additionally idle-only (below). */
const PRIORITY_RANK: Record<CheckpointPriority, number> = {
  RESTORE: 3,
  BEFORE: 2,
  AFTER: 1,
  MAINTENANCE: 0,
};

/** Resolution value when an item's deadline fired before it started. */
export interface SkippedDeadline {
  skipped: 'deadline';
}

export interface WithPriorityOptions {
  priority: CheckpointPriority;
  /** Absolute wall-clock deadline (epoch ms). `Infinity` = never expire (see
   *  {@link CheckpointQueue.withLock}). A queued item that reaches this instant
   *  before starting resolves `{ skipped: 'deadline' }`. */
  deadlineAt: number;
}

/** One telemetry sample per op that actually STARTED (skipped items emit none).
 *  `queueWaitMs` (enqueue→start) and `execMs` (start→finish) are recorded
 *  separately so latency SLOs can attribute queue pressure vs. exec cost. */
export interface QueueTelemetrySample {
  key: string;
  priority: CheckpointPriority;
  queueWaitMs: number;
  execMs: number;
}

/** Injected telemetry sink; the default is a no-op. */
export type QueueTelemetrySink = (sample: QueueTelemetrySample) => void;

interface QueueItem {
  readonly priority: CheckpointPriority;
  readonly rank: number;
  readonly deadlineAt: number;
  readonly seq: number;
  readonly enqueuedAt: number;
  readonly run: () => Promise<unknown>;
  readonly settle: (value: unknown) => void;
  readonly fail: (err: unknown) => void;
  started: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface KeyState {
  readonly queue: QueueItem[];
  running: boolean;
}

/**
 * Per-key priority queue with eager deadline expiry. One instance serves the
 * whole app; keys partition it by object database.
 */
export class CheckpointQueue {
  private readonly states = new Map<string, KeyState>();
  private seqCounter = 0;

  constructor(private readonly telemetry: QueueTelemetrySink = () => {}) {}

  /**
   * Enqueue `fn` on `key` at the given priority + absolute deadline. Resolves
   * with `fn`'s result once it runs to completion, or rejects with whatever
   * `fn` rejects. If the deadline fires while the item is still queued (never
   * started), the returned promise instead resolves `{ skipped: 'deadline' }`
   * and `fn` is never invoked.
   */
  withPriority<T>(
    key: string,
    opts: WithPriorityOptions,
    fn: () => Promise<T>,
  ): Promise<T | SkippedDeadline> {
    return new Promise<T | SkippedDeadline>((resolve, reject) => {
      const state = this.stateFor(key);
      const item: QueueItem = {
        priority: opts.priority,
        rank: PRIORITY_RANK[opts.priority],
        deadlineAt: opts.deadlineAt,
        seq: this.seqCounter++,
        enqueuedAt: Date.now(),
        run: fn as () => Promise<unknown>,
        settle: resolve as (value: unknown) => void,
        fail: reject,
        started: false,
        cancelled: false,
        timer: null,
      };

      // Arm the item's own deadline timer at ENQUEUE — this is what makes expiry
      // eager rather than dequeue-time. A non-finite deadline never expires.
      if (Number.isFinite(item.deadlineAt)) {
        const delay = Math.max(0, item.deadlineAt - Date.now());
        item.timer = setTimeout(() => this.onDeadline(key, item), delay);
        if (typeof item.timer.unref === 'function') item.timer.unref();
      }

      state.queue.push(item);
      this.pump(key);
    });
  }

  /**
   * Run the compound restore sequence uninterrupted: highest priority and a
   * deadline of `Infinity`, so it is never expired mid-flight and, once it holds
   * the key, its whole safety-snapshot→mutation sequence runs to completion.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | SkippedDeadline> {
    return this.withPriority(key, { priority: 'RESTORE', deadlineAt: Infinity }, fn);
  }

  /** Number of items currently WAITING on `key` (not the running one). For health. */
  queueDepth(key: string): number {
    const state = this.states.get(key);
    if (!state) return 0;
    // Cancelled items are spliced out on expiry and started items on dequeue, so
    // `queue` already holds only live waiters.
    return state.queue.length;
  }

  private stateFor(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { queue: [], running: false };
      this.states.set(key, state);
    }
    return state;
  }

  /** The deadline timer fired: cancel the item IFF it has not started. */
  private onDeadline(key: string, item: QueueItem): void {
    // Its timer just fired — nothing left to clear.
    item.timer = null;
    // A started (or already-cancelled) item is never cancelled by its timer.
    if (item.started || item.cancelled) return;

    item.cancelled = true;
    const state = this.states.get(key);
    if (state) {
      const i = state.queue.indexOf(item);
      if (i >= 0) state.queue.splice(i, 1);
    }
    // Resolve IMMEDIATELY — do not wait for the running op or this item's turn.
    item.settle({ skipped: 'deadline' } satisfies SkippedDeadline);
    this.maybeCleanup(key);
  }

  /** Start the next eligible item on `key` if nothing is already running. */
  private pump(key: string): void {
    const state = this.states.get(key);
    if (!state || state.running) return;

    // Select the highest-priority live item; FIFO (lowest seq) breaks ties.
    // Because we only reach here when nothing is running, "MAINTENANCE is
    // idle-only" reduces to "MAINTENANCE is eligible only when no
    // RESTORE/BEFORE/AFTER item is queued" — and picking the max rank enforces
    // exactly that: a MAINTENANCE item can only be the max when it is alone.
    let best: QueueItem | null = null;
    for (const it of state.queue) {
      if (it.cancelled) continue;
      if (best === null || it.rank > best.rank || (it.rank === best.rank && it.seq < best.seq)) {
        best = it;
      }
    }
    if (!best) {
      this.maybeCleanup(key);
      return;
    }

    // Dequeue seam: honor the cancelled flag here too, closing the
    // fire-just-as-it-dequeues race (an item cancelled after selection but
    // before we commit must never have its callback invoked).
    if (best.cancelled) return;

    const idx = state.queue.indexOf(best);
    if (idx >= 0) state.queue.splice(idx, 1);

    // Commit to running: mark started FIRST so a same-tick timer fire no-ops,
    // then clear the (now moot) deadline timer — no dangling handle.
    best.started = true;
    if (best.timer) {
      clearTimeout(best.timer);
      best.timer = null;
    }
    state.running = true;

    const startAt = Date.now();
    const queueWaitMs = startAt - best.enqueuedAt;

    Promise.resolve()
      .then(() => best.run())
      .then(
        (value) => this.finish(key, best, startAt, queueWaitMs, () => best.settle(value)),
        (err) => this.finish(key, best, startAt, queueWaitMs, () => best.fail(err)),
      );
  }

  /** An op finished (resolved OR rejected): record telemetry, release the key,
   *  deliver the caller's outcome, then pump the next item. Rejection is
   *  isolated here — it never blocks the next op on the key. */
  private finish(
    key: string,
    item: QueueItem,
    startAt: number,
    queueWaitMs: number,
    deliver: () => void,
  ): void {
    const execMs = Date.now() - startAt;
    try {
      this.telemetry({ key, priority: item.priority, queueWaitMs, execMs });
    } catch {
      /* a telemetry sink must never break the queue */
    }

    const state = this.states.get(key);
    if (state) state.running = false;

    deliver();
    this.pump(key);
  }

  /** Drop a fully-idle key so the map does not grow without bound. */
  private maybeCleanup(key: string): void {
    const state = this.states.get(key);
    if (state && !state.running && state.queue.length === 0) {
      this.states.delete(key);
    }
  }
}
