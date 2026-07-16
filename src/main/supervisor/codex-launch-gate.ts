// Layer B — global codex-launch serialization gate.
//
// Codex mints its session id internally and only exposes it via late side
// effects (SessionStart hook ~350 ms after the first user message, or the
// `state_5.sqlite` `threads` row ~1 s after). All codex agents deliberately
// share one working directory (architectural invariant, root CLAUDE.md), so
// concurrent/temporally-close codex launches race each other during that
// launch→sid-bind window. This gate serializes that window: at most ONE codex
// launch in flight per codex home (`'windows'` and `'wsl'` are distinct homes)
// through to its sid bind.
//
// Edward's directive: the gate ships regardless of Layer A, because codex can
// silently re-gate hook trust (gotcha B8) — when the SessionStart hook doesn't
// fire, the gate keeps concurrent launches safe on the ~35 s discovery path.
//
// Design contract:
//   - RELEASE ON BIND, not on a fixed sleep: the holder is released the moment
//     its sid binds (hook-bind or discovery hit) or discovery declines/errors.
//   - HARD CAP: a dead launch whose discovery never settles cannot wedge the
//     queue — a per-holder timer force-releases after `hardCapMs`.
//   - INSTANT common case: the FIRST launch acquires with zero wait (lock free);
//     only a CONCURRENT launch waits, and only until the previous one binds
//     (sub-second once Layer A's hook-bind lands).
//   - Never queues claude/gemini: callers only wrap codex launches.
//
// Pure/injectable (timers + clock) so it is unit-testable without the app.

export interface CodexLaunchGateOptions {
  /** Force-release a holder after this long, so a launch whose discovery never
   *  settles can't wedge the queue. */
  hardCapMs: number;
  /** Escape hatch (env DASH_CODEX_LAUNCH_GATE=off). When false, `acquire`
   *  resolves immediately with a no-op release and no serialization. */
  enabled?: boolean;
  /** Test seam: clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: schedule the hard-cap timer. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam: cancel the hard-cap timer. Defaults to clearTimeout. */
  clearTimer?: (handle: unknown) => void;
  /** Observability sink. Defaults to console.log. */
  log?: (msg: string) => void;
}

export interface CodexLaunchGateAcquisition {
  /** Idempotent — safe to call from hook-bind, discovery-settle, AND the hard
   *  cap; only the first call has effect. */
  release: () => void;
  /** How long this acquire waited behind earlier holders (0 = lock was free). */
  waitedMs: number;
  /** How many launches were already queued on this key when we requested. */
  queuedBehind: number;
}

export class CodexLaunchGate {
  private readonly hardCapMs: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;

  // Per-key promise chain: the tail resolves when the current holder releases.
  // Only ever two keys ('windows' | 'wsl'), so no map pruning is needed.
  private readonly tail = new Map<string, Promise<void>>();
  // Per-key count of launches currently requesting-or-holding (observability).
  private readonly depth = new Map<string, number>();

  constructor(opts: CodexLaunchGateOptions) {
    this.hardCapMs = opts.hardCapMs;
    this.enabled = opts.enabled !== false;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = opts.log ?? ((m) => console.log(m));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Acquire the gate for `key`. Resolves when it is this launch's turn; the
   *  returned `release` MUST be called (by whichever of hook-bind / discovery /
   *  hard-cap fires first) to let the next launch proceed. */
  async acquire(key: string): Promise<CodexLaunchGateAcquisition> {
    if (!this.enabled) {
      return { release: () => {}, waitedMs: 0, queuedBehind: 0 };
    }

    const prev = this.tail.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    // The NEXT acquirer waits until THIS holder releases (`gate`), which itself
    // waits until every earlier holder has released (`prev`).
    this.tail.set(key, prev.then(() => gate));

    const queuedBehind = this.depth.get(key) ?? 0;
    this.depth.set(key, queuedBehind + 1);

    const requestedAt = this.now();
    await prev;
    const waitedMs = this.now() - requestedAt;

    let released = false;
    let timer: unknown;
    const doRelease = (): void => {
      if (released) return;
      released = true;
      if (timer !== undefined) this.clearTimer(timer);
      const d = (this.depth.get(key) ?? 1) - 1;
      if (d <= 0) this.depth.delete(key);
      else this.depth.set(key, d);
      releaseGate();
    };
    // Hard cap: a launch whose discovery never settles can't hold forever.
    timer = this.setTimer(() => {
      if (released) return;
      this.log(`[supervisor] codex launch gate: hard-cap ${this.hardCapMs}ms hit on ${key} — force-releasing`);
      doRelease();
    }, this.hardCapMs);
    (timer as { unref?: () => void })?.unref?.();

    return { release: doRelease, waitedMs, queuedBehind };
  }
}
