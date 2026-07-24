// Git-Native WP-G1.4 — turn-completion-tracker: the per-agent COMPLETION-side
// parallel to `turn-evidence.ts` (which is starts-only). It answers exactly one
// question — "has this agent's current turn finished?" — from a *fallback
// consult order* of increasingly-weak signals, and emits `turnComplete` once.
//
// FALLBACK CONSULT ORDER (highest-fidelity first):
//   1. Stop-hook transition            (source 'hook')         — the runner's own
//      Stop hook fired: the model's turn is definitively over.
//   2. session-log `assistant-text` /
//      `assistant-text-patch` with
//      `turnComplete:true`             (source 'session-log')  — the transcript
//      shows the assistant's final message closed the turn.
//   3. terminal runner-exit event      (source 'terminal')     — the PTY runner
//      exited; whatever it was doing is over.
//   4. debounced `status→idle`         (source 'idle-fallback')— LAST RESORT, and
//      ONLY after correlated start evidence for THIS turn. A raw idle can be
//      stale (left over from a prior turn, or a status flap), so an idle with no
//      preceding start in the current turn must NEVER complete it.
//
// CLOSE-ON-FIRST-ACCEPTABLE-EVIDENCE. The list above is a *consult order*, not a
// re-openable precedence: whichever acceptable signal lands first CLOSES the turn
// and emits `turnComplete(agentId, { source })`. Once closed, the row is
// immutable EXCEPT one thing: a bounded, METADATA-ONLY `after_quality` upgrade.
// If, within a short injectable window after close, a *higher-fidelity* signal
// arrives, the recorded source/after_quality is upgraded (idle-fallback → hook,
// etc.) and an `upgrade:true` event is emitted. An upgrade NEVER re-opens the
// turn, never changes any refs (this layer holds none), and never fires once the
// window has elapsed. A same-or-lower-fidelity signal after close is a dedup.
//
// This module is intentionally self-contained: it takes injected inputs (clock,
// timer seam, windows) and exposes plain feed methods + a subscribe API. WP-G1.7
// wires the live supervisor's hook / session-log / terminal / status feeds into
// it and the WP-G1.5 coordinator subscribes to `onTurnComplete`.

/** The four accepted completion signals, in consult (and fidelity) order. */
export type CompletionSource = 'hook' | 'session-log' | 'terminal' | 'idle-fallback';

/** `after_quality` column vocabulary. Source → after_quality is the identity map
 *  for the four completing sources (database.ts:1476). */
export type AfterQuality = CompletionSource;

export interface TurnCompleteEvent {
  /** The signal that currently owns the turn's completion (post-upgrade). */
  source: CompletionSource;
  /** Recorded `after_quality` — identity-mapped from `source`. */
  afterQuality: AfterQuality;
  /** false for the initial close; true for a later metadata-only upgrade. */
  upgrade: boolean;
  /** On an upgrade, the source this one replaced; absent on initial close. */
  previousSource?: CompletionSource;
}

export type TurnCompleteListener = (agentId: string, ev: TurnCompleteEvent) => void;

/** Opaque timer handle so a test can inject a deterministic fake scheduler. */
export type TimerHandle = unknown;

export interface TurnCompletionTrackerOptions {
  /** Monotonic-ish clock in ms; defaults to `Date.now`. Injected so the upgrade
   *  window can be driven deterministically in tests. */
  now?: () => number;
  /** Debounce applied to `status→idle` before it may complete a turn. */
  idleDebounceMs?: number;
  /** Window after close during which a higher-fidelity signal may upgrade the
   *  recorded `after_quality` (metadata only). */
  upgradeWindowMs?: number;
  /** Scheduler seam (defaults to the global timers). Injected so idle debounce
   *  is deterministic in tests without real sleeps. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

// Defaults: a ~¾s idle debounce (long enough to ride out a status flap, short
// enough not to lag real completion), and a 5 s upgrade window (comfortably
// covers a Stop hook / patch landing a beat after a weaker signal).
const DEFAULT_IDLE_DEBOUNCE_MS = 750;
const DEFAULT_UPGRADE_WINDOW_MS = 5_000;

/** Higher rank = higher fidelity. An upgrade is allowed only when a newer
 *  signal outranks the one that currently owns the closed turn. */
const RANK: Record<CompletionSource, number> = {
  hook: 3,
  'session-log': 2,
  terminal: 1,
  'idle-fallback': 0,
};

interface TurnState {
  /** Generation counter — bumped by `beginTurn`; identifies "this turn" so a
   *  debounce timer armed for an earlier turn can be ignored if it survives. */
  gen: number;
  /** true from `beginTurn` until a signal closes it. */
  open: boolean;
  /** Correlated start evidence seen since this turn began (idle-fallback gate). */
  hasStart: boolean;
  /** The owning source once closed; null while open. */
  source: CompletionSource | null;
  /** Clock time of the initial close; the upgrade window is measured from here. */
  closedAt: number | null;
  /** Pending idle debounce timer, if any. */
  idleTimer: TimerHandle | null;
}

export class TurnCompletionTracker {
  private readonly now: () => number;
  private readonly idleDebounceMs: number;
  private readonly upgradeWindowMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;

  private readonly states = new Map<string, TurnState>();
  private readonly listeners = new Set<TurnCompleteListener>();

  constructor(opts: TurnCompletionTrackerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.idleDebounceMs = opts.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
    this.upgradeWindowMs = opts.upgradeWindowMs ?? DEFAULT_UPGRADE_WINDOW_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ── subscribe API ──────────────────────────────────────────────────────────

  /** Register a completion listener; returns an unsubscribe fn. */
  onTurnComplete(listener: TurnCompleteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── turn lifecycle ──────────────────────────────────────────────────────────

  /** Open a fresh turn for an agent. Resets all per-turn state (start evidence,
   *  completion, pending idle debounce). Call this when the coordinator opens a
   *  row (before-checkpoint). A turn must be open before any signal can complete
   *  it; signals for an agent with no open turn are ignored. */
  beginTurn(agentId: string): void {
    const prev = this.states.get(agentId);
    if (prev?.idleTimer != null) {
      this.clearTimer(prev.idleTimer);
    }
    const gen = (prev?.gen ?? 0) + 1;
    this.states.set(agentId, {
      gen,
      open: true,
      hasStart: false,
      source: null,
      closedAt: null,
      idleTimer: null,
    });
  }

  /** Record correlated start evidence for the agent's current turn. This is the
   *  ONLY thing that unlocks the idle-fallback path — a turn that never saw a
   *  start cannot be completed by a (possibly stale) idle. No-op if no turn is
   *  open. */
  noteStart(agentId: string): void {
    const st = this.states.get(agentId);
    if (!st || !st.open) return;
    st.hasStart = true;
  }

  // ── completion feeds (consult order) ──────────────────────────────────────────

  /** (1) Stop-hook transition — highest fidelity. */
  noteHookStop(agentId: string): void {
    this.resolve(agentId, 'hook');
  }

  /** (2) session-log `assistant-text`/`assistant-text-patch` with
   *  `turnComplete:true`. */
  noteSessionLogComplete(agentId: string): void {
    this.resolve(agentId, 'session-log');
  }

  /** (3) terminal runner-exit. */
  noteTerminalExit(agentId: string): void {
    this.resolve(agentId, 'terminal');
  }

  /** (4) status→idle — fallback only, debounced, and gated on start evidence.
   *  Arms (or re-arms) a debounce timer; when it fires the idle completes the
   *  turn ONLY if the turn is still open AND correlated start evidence was seen.
   *  A stale idle (no start this turn) is dropped when the timer fires. */
  noteIdle(agentId: string): void {
    const st = this.states.get(agentId);
    // No open turn → nothing an idle could complete. (A closed turn is never
    // upgraded by idle: it is the lowest fidelity.)
    if (!st || !st.open) return;
    // Debounce: coalesce a burst of idle flaps into a single pending decision.
    if (st.idleTimer != null) this.clearTimer(st.idleTimer);
    const gen = st.gen;
    st.idleTimer = this.setTimer(() => {
      const cur = this.states.get(agentId);
      // Ignore a timer that outlived its turn (a new beginTurn bumped the gen).
      if (!cur || cur.gen !== gen) return;
      cur.idleTimer = null;
      if (!cur.open) return; // already completed by a stronger signal
      if (!cur.hasStart) return; // stale idle without correlated start — DROP
      this.resolve(agentId, 'idle-fallback');
    }, this.idleDebounceMs);
  }

  // ── core resolution ──────────────────────────────────────────────────────────

  /**
   * Apply one completion signal under close-on-first + bounded-upgrade rules:
   *   - no open/closed turn state → ignore;
   *   - turn open → CLOSE it with this source, emit `turnComplete` (upgrade:false);
   *   - turn closed, within the upgrade window, and this source outranks the
   *     current owner → METADATA-ONLY upgrade, emit `turnComplete` (upgrade:true);
   *   - otherwise (dup, weaker/equal, or window elapsed) → ignore.
   */
  private resolve(agentId: string, source: CompletionSource): void {
    const st = this.states.get(agentId);
    if (!st) return;

    if (st.open) {
      st.open = false;
      st.source = source;
      st.closedAt = this.now();
      if (st.idleTimer != null) {
        this.clearTimer(st.idleTimer);
        st.idleTimer = null;
      }
      this.emit(agentId, { source, afterQuality: source, upgrade: false });
      return;
    }

    // Already closed — the only legal mutation is a bounded, higher-fidelity,
    // metadata-only upgrade.
    if (st.source == null || st.closedAt == null) return;
    if (RANK[source] <= RANK[st.source]) return; // dup or weaker → no-op
    if (this.now() - st.closedAt > this.upgradeWindowMs) return; // window elapsed
    const previousSource = st.source;
    st.source = source;
    // closedAt is intentionally NOT advanced: the window is anchored to the
    // original close, so upgrades cannot chain past the bound.
    this.emit(agentId, { source, afterQuality: source, upgrade: true, previousSource });
  }

  private emit(agentId: string, ev: TurnCompleteEvent): void {
    for (const l of this.listeners) l(agentId, ev);
  }

  // ── teardown ──────────────────────────────────────────────────────────────────

  /** Drop all state for an agent and cancel any pending idle timer. Call on
   *  session rebind / terminal / forget. */
  reset(agentId: string): void {
    const st = this.states.get(agentId);
    if (st?.idleTimer != null) this.clearTimer(st.idleTimer);
    this.states.delete(agentId);
  }

  /** Cancel every pending timer and drop all state (supervisor teardown). */
  disposeAll(): void {
    for (const st of this.states.values()) {
      if (st.idleTimer != null) this.clearTimer(st.idleTimer);
    }
    this.states.clear();
    this.listeners.clear();
  }
}
