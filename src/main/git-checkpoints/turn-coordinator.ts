// turn-coordinator.ts — owns turn IDs and the before/after boundary lifecycle
// (Git-Native WP-G1.5). MAIN-PROCESS ONLY. This is the state machine that sits
// between delivery (`_deliverAndConfirm`, WP-G1.7) and the snapshot core
// (`CheckpointService.captureEdge`, WP-G1.3b): it opens a `turn_records` row and
// takes the BEFORE snapshot before any PTY byte, closes it on completion with an
// AFTER snapshot, and keeps EXACTLY ONE open turn per agent through overlap,
// delivery-reject, crash, stop, shutdown, and startup reconciliation.
//
// LOAD-BEARING INVARIANTS (WP-G1.5 + plan §0):
//   • BEFORE the edge: `beforeCheckpoint` opens the row and attempts the snapshot
//     BEFORE any byte is delivered. A clean capture → `before_quality='guaranteed'`.
//   • FAIL OPEN: a snapshot failure/skip NEVER blocks delivery — the row records
//     `before_quality='degraded'` + exact `failure_reason`, `before_oid` NULL,
//     `before_ready=0`, and delivery proceeds. `beforeCheckpoint` never throws.
//   • NEVER TWO OPEN turns for one agent. An overlapping submitted send while a
//     turn is still `open` closes the prior as `interrupted` (`after_quality='none'`,
//     best-effort degraded after-snapshot), THEN opens ONE new `degraded` row with
//     `failure_reason='overlapping-active-turn'` and re-points the witness recorder.
//   • DELIVERY REJECT: `onDeliveryFailed` closes the row `delivery_failed` — never
//     left `open`.
//   • IDEMPOTENT: repeated completion/crash/stop events and startup reconciliation
//     are guarded by the DB terminal-status check (`closeTurn` is a no-op on a
//     terminal row) plus an in-memory `closing` latch, so nothing double-closes.
//   • COMPLETION rides `turn-completion-tracker` (WP-G1.4): the first acceptable
//     signal → AFTER snapshot + close `accepted`, `after_quality = source`.
//   • Manual-terminal LATE-BOUND turns pass `quality:'late'` — never masquerading
//     as a guaranteed pre-write snap.
//   • Startup closes dangling `open` rows as `crashed`; the ref/DB reconciliation
//     itself is WP-G1.8 and is left as a seam here.
//
// Every git touch is delegated to the injected `capture` seam (the service) and
// every DB touch to the injected `store` seam, so the whole state machine is
// testable with in-memory fakes and no real timers / git / fs.

import type { AllocateTurnFields, TurnRecord, TurnStatus } from '../database';
import type { ResolvedPlanStamp } from '../../shared/commit-candidates';
import {
  allocateAndInsertTurn as dbAllocateAndInsertTurn,
  updateTurnRecord as dbUpdateTurnRecord,
  closeTurn as dbCloseTurn,
  getTurnRecord as dbGetTurnRecord,
  listTurnRecords as dbListTurnRecords,
} from '../database';
import type { GitCapability, ResolvedIntentStamp } from '../../shared/types';
import { deriveTaskLabel } from './dispatch-context';
import type { CaptureEdgeParams, EdgeCaptureResult } from './checkpoint-service';
import type { AfterQuality, TurnCompleteEvent } from '../supervisor/turn-completion-tracker';

// ── injectable seams ──────────────────────────────────────────────────────────

/** The subset of the WP-A0 turn_records accessors this coordinator writes. Defaults
 *  bind to the real database.ts exports; tests inject an in-memory fake so the
 *  open → capture → close transitions are observable without a real DB. */
export interface CoordinatorTurnStore {
  allocateAndInsertTurn(workspaceId: string, fields: AllocateTurnFields): TurnRecord;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  closeTurn(
    id: string,
    status: Exclude<TurnStatus, 'open'>,
    extra?: Record<string, unknown>,
    endedAt?: number | null,
  ): TurnRecord | null;
  getTurnRecord(id: string): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
}

const DEFAULT_STORE: CoordinatorTurnStore = {
  allocateAndInsertTurn: dbAllocateAndInsertTurn,
  updateTurnRecord: (id, updates) => dbUpdateTurnRecord(id, updates as never),
  closeTurn: (id, status, extra, endedAt) => dbCloseTurn(id, status, extra as never, endedAt),
  getTurnRecord: dbGetTurnRecord,
  listTurnRecords: dbListTurnRecords,
};

/** The `CheckpointService.captureEdge` shape — the ONLY git touch this layer makes.
 *  Bound to `service.captureEdge.bind(service)` in production; a fake in tests. */
export type CaptureEdgeFn = (params: CaptureEdgeParams) => Promise<EdgeCaptureResult>;

/** The subset of `turn-completion-tracker` this coordinator drives + subscribes to.
 *  A turn must be `beginTurn`-ed before any signal can complete it (WP-G1.4). */
export interface CompletionSubscription {
  onTurnComplete(listener: (agentId: string, ev: TurnCompleteEvent) => void): () => void;
  beginTurn(agentId: string): void;
  reset(agentId: string): void;
}

/** Optional eager push seam so the witness recorder (WP-G1.7) can be re-pointed the
 *  instant the active turn changes. The pull path (`currentOpenTurnId`) is always
 *  available; this is a convenience for a push-model wiring. */
export interface WitnessRouter {
  setActiveTurn(agentId: string, turnId: string | null): void;
}

export interface TurnCoordinatorOptions {
  /** The service's `captureEdge` (git snapshot). Required — the coordinator owns no git. */
  capture: CaptureEdgeFn;
  completion: CompletionSubscription;
  store?: CoordinatorTurnStore;
  witnessRouter?: WitnessRouter;
  /** now() seam — defaults to Date.now. Injected so `ended_at`/`started_at` are
   *  deterministic in tests. */
  now?: () => number;
}

// ── the before-checkpoint context (dispatch identity + capability) ─────────────

/** Success-case BEFORE quality the coordinator may assert. A clean, pre-write
 *  snapshot is `guaranteed`; a manual-terminal late-bound turn is `late`. Anything
 *  the service could not capture is downgraded to `degraded` (never asserted here). */
export type BeforeQuality = 'guaranteed' | 'late';

export interface TurnContext {
  workspaceId: string;
  /** Launch identity — NEVER a cwd/slug (invariant #4: many agents share one dir). */
  agentId: string;
  capability: GitCapability;
  agentTitle?: string | null;
  ownerAgentId?: string | null;
  ownerBrickGeneration?: number | null;
  /** Frozen by the dispatch boundary. Optional only for pre-stamping adapters; live
   * dispatch contexts always supply it. */
  planStamp?: ResolvedPlanStamp;
  /** Main-resolved save intent; wire callers cannot populate this carrier. */
  intentStamp?: ResolvedIntentStamp;
  sessionId?: string | null;
  taskLabel?: string | null;
  /** Free prompt text for this turn (WP3). A turn-opening input — deliberately NOT on
   *  `DispatchContext` (which stays dispatch metadata). When `taskLabel` (the dispatch
   *  brief) is blank, `openTurn` derives the label from this via `deriveTaskLabel`. */
  promptText?: string;
  /** `guaranteed` (default) for a normal pre-write edge; `late` for a manual-terminal
   *  late-bound turn. Downgraded to `degraded` automatically if capture fails. */
  quality?: BeforeQuality;
  /** Absolute enqueue time forwarded to the queue's wall-clock contract. */
  enqueueTime?: number;
}

export interface BeforeCheckpointResult {
  turnId: string;
  /** true only when the BEFORE edge is a real, ready snapshot. */
  ready: boolean;
  /** Recorded `before_quality` for the row. */
  quality: BeforeQuality | 'degraded';
  failureReason: string | null;
}

// ── per-agent open-turn state ──────────────────────────────────────────────────

interface AgentTurnState {
  agentId: string;
  turnId: string;
  ctx: TurnContext;
  /** Latched the instant a terminal transition begins, so a racing completion /
   *  crash / delivery-reject event can never double-close the same turn. */
  closing: boolean;
}

export class TurnCoordinator {
  private readonly capture: CaptureEdgeFn;
  private readonly completion: CompletionSubscription;
  private readonly store: CoordinatorTurnStore;
  private readonly witnessRouter?: WitnessRouter;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  /** EXACTLY ONE entry per agent while a turn is open — the never-two-open ledger. */
  private readonly openByAgent = new Map<string, AgentTurnState>();

  constructor(opts: TurnCoordinatorOptions) {
    this.capture = opts.capture;
    this.completion = opts.completion;
    this.store = opts.store ?? DEFAULT_STORE;
    this.witnessRouter = opts.witnessRouter;
    this.now = opts.now ?? Date.now;
    // Completion rides the tracker: its first acceptable signal closes the turn.
    this.unsubscribe = this.completion.onTurnComplete((agentId, ev) => this.onCompletion(agentId, ev));
  }

  // ── the pull path for the witness recorder (WP-G1.7) ───────────────────────────

  /** The open turn a witnessed write/create for this agent must attach to, or null.
   *  Re-pointed automatically whenever the active turn changes (overlap / close). */
  currentOpenTurnId(agentId: string): string | null {
    return this.openByAgent.get(agentId)?.turnId ?? null;
  }

  /** The full pull target the witness recorder (WP-G1.7) needs to normalize a
   *  witnessed path and attach it to the right turn: the open turn id PLUS the
   *  exact `repoRoot`/`workspacePrefix` the before-snapshot used (so `touched[]`
   *  paths are repo-relative, aligned with the captured tree, and scoped to the
   *  canonical workspace). Sourced from the open turn's own capability — the
   *  authoritative record — so it can never drift from what was snapshotted.
   *  Returns null when there is no open turn or the capability lacks a repoRoot. */
  currentWitnessTarget(
    agentId: string,
  ): { turnId: string; repoRoot: string; workspacePrefix: string } | null {
    const state = this.openByAgent.get(agentId);
    const repoRoot = state?.ctx.capability.repoRoot;
    if (!state || !repoRoot) return null;
    return { turnId: state.turnId, repoRoot, workspacePrefix: state.ctx.capability.workspacePrefix ?? '' };
  }

  // ── before edge ────────────────────────────────────────────────────────────────

  /**
   * Open a fresh turn row and take the BEFORE snapshot before any PTY byte. NEVER
   * throws (fail open to delivery). If a turn is already open for this agent, this is
   * an OVERLAPPING submitted send: the prior is closed `interrupted` and the new row
   * is opened `degraded` with `failure_reason='overlapping-active-turn'`.
   */
  async beforeCheckpoint(agentId: string, ctx: TurnContext): Promise<BeforeCheckpointResult> {
    const existing = this.openByAgent.get(agentId);
    if (existing) {
      // Overlap: never two open. Close the prior first, then open one degraded row.
      await this.closePriorForOverlap(existing);
      return this.openTurn(agentId, ctx, { quality: 'degraded', mandatedReason: 'overlapping-active-turn' });
    }
    return this.openTurn(agentId, ctx, { quality: ctx.quality ?? 'guaranteed' });
  }

  private async openTurn(
    agentId: string,
    ctx: TurnContext,
    opts: { quality: BeforeQuality | 'degraded'; mandatedReason?: string },
  ): Promise<BeforeCheckpointResult> {
    // 1. Allocate + open the row (identity/attribution only; OIDs filled by capture).
    const turn = this.store.allocateAndInsertTurn(ctx.workspaceId, {
      agentId,
      agentTitle: ctx.agentTitle ?? null,
      ownerAgentId: ctx.ownerAgentId ?? null,
      ownerBrickGeneration: ctx.ownerBrickGeneration ?? null,
      planId: ctx.planStamp?.planId ?? null,
      planItemId: ctx.planStamp?.planItemId ?? null,
      planStampSource: ctx.planStamp?.source ?? 'agent-default',
      intentId: ctx.intentStamp?.intentId ?? null,
      intentStampSource: ctx.intentStamp?.source ?? null,
      sessionId: ctx.sessionId ?? null,
      // WP3: explicit dispatch brief (`taskLabel`) wins; else derive from the first
      // usable prompt line; else null. `.trim() || …` makes a blank brief fall through.
      taskLabel: ctx.taskLabel?.trim() || deriveTaskLabel(ctx.promptText) || null,
      startedAt: this.now(),
      status: 'open',
    });
    const state: AgentTurnState = { agentId, turnId: turn.id, ctx, closing: false };
    this.openByAgent.set(agentId, state);
    // 2. Re-point the witness recorder BEFORE delivery so writes route to this row.
    this.completion.beginTurn(agentId);
    this.witnessRouter?.setActiveTurn(agentId, turn.id);

    // 3. Take the BEFORE snapshot — fail open on every failure path.
    let result: EdgeCaptureResult | null = null;
    try {
      result = await this.capture({
        edge: 'before',
        turnId: turn.id,
        workspaceId: ctx.workspaceId,
        agentId,
        capability: ctx.capability,
        quality: opts.quality,
        enqueueTime: ctx.enqueueTime,
      });
    } catch (err) {
      // A thrown capture must NOT block delivery — record degraded + fail open.
      this.safeUpdate(turn.id, {
        beforeQuality: 'degraded',
        failureReason: opts.mandatedReason ?? `before-capture-threw:${describeError(err)}`,
      });
      return { turnId: turn.id, ready: false, quality: 'degraded', failureReason: opts.mandatedReason ?? 'before-capture-threw' };
    }

    // 4. Enforce the mandated overlap reason regardless of capture outcome: writes
    //    still in flight from the prior model may land in this window, so it is
    //    degraded even when the snapshot bytes were captured.
    if (opts.mandatedReason) {
      this.safeUpdate(turn.id, { beforeQuality: 'degraded', failureReason: opts.mandatedReason });
      return { turnId: turn.id, ready: false, quality: 'degraded', failureReason: opts.mandatedReason };
    }

    if (result.status === 'ready') {
      // Clean pre-write snapshot — the service already stamped before_quality=quality.
      return { turnId: turn.id, ready: true, quality: opts.quality as BeforeQuality, failureReason: null };
    }

    // Non-ready, non-overlap: the service's `abandon` already recorded degraded +
    // exact reason for a capture failure; a capability/enumeration SKIP writes no
    // row, so record the degraded downgrade here. Either way delivery proceeds.
    if (result.status === 'skipped') {
      this.safeUpdate(turn.id, {
        beforeQuality: 'degraded',
        failureReason: result.skipReason ?? 'checkpoint-skipped',
      });
    }
    return {
      turnId: turn.id,
      ready: false,
      quality: 'degraded',
      failureReason: result.failureReason ?? result.skipReason ?? null,
    };
  }

  // ── after edge / completion ─────────────────────────────────────────────────────

  /** Completion rides the tracker. The FIRST acceptable signal (upgrade:false) takes
   *  the AFTER snapshot and closes the turn `accepted` with `after_quality = source`.
   *  A later metadata-only upgrade cannot re-open or rewrite a terminal row, so it is
   *  a no-op at this layer (the tracker still owns the in-memory upgrade). */
  private onCompletion(agentId: string, ev: TurnCompleteEvent): void {
    if (ev.upgrade) return; // metadata-only upgrade — terminal row is immutable here
    const state = this.openByAgent.get(agentId);
    if (!state) return; // no open turn (already closed) — nothing to complete
    void this.completeTurn(state, ev.afterQuality);
  }

  private async completeTurn(state: AgentTurnState, quality: AfterQuality): Promise<void> {
    if (state.closing) return; // a racing signal already owns this close
    state.closing = true;
    try {
      await this.tryAfterSnapshot(state, quality);
    } finally {
      // Close `accepted`, stamping after_quality = the completion source. after_ready
      // (set by the snapshot) is an independent record of whether bytes were captured.
      this.store.closeTurn(state.turnId, 'accepted', { afterQuality: quality }, this.now());
      this.clearAgent(state.agentId);
    }
  }

  // ── crash / stop / shutdown ──────────────────────────────────────────────────────

  /** Mark an agent's open turn `crashed` (best-effort degraded after-snapshot). */
  markCrashed(agentId: string): void {
    this.terminateOpen(agentId, 'crashed');
  }

  /** Mark an agent's open turn `stopped` (deliberate stop). */
  markStopped(agentId: string): void {
    this.terminateOpen(agentId, 'stopped');
  }

  /** Mark an agent's open turn `interrupted` (restart / rebind). */
  markInterrupted(agentId: string): void {
    this.terminateOpen(agentId, 'interrupted');
  }

  private terminateOpen(agentId: string, status: 'crashed' | 'stopped' | 'interrupted'): void {
    const state = this.openByAgent.get(agentId);
    if (!state) return;
    if (state.closing) return;
    state.closing = true;
    void (async () => {
      try {
        await this.tryAfterSnapshot(state, 'none');
      } finally {
        this.store.closeTurn(state.turnId, status, { afterQuality: 'none' }, this.now());
        this.clearAgent(state.agentId);
      }
    })();
  }

  /** Delivery rejected the bytes: close the row `delivery_failed` (never leave it
   *  `open`). No after-snapshot — nothing was delivered. Idempotent. */
  onDeliveryFailed(agentId: string): string | null {
    const state = this.openByAgent.get(agentId);
    if (!state) return null;
    state.closing = true;
    this.store.closeTurn(state.turnId, 'delivery_failed', undefined, this.now());
    this.clearAgent(state.agentId);
    return state.turnId;
  }

  // ── overlap: close the prior turn ────────────────────────────────────────────────

  private async closePriorForOverlap(prior: AgentTurnState): Promise<void> {
    if (prior.closing) {
      // Already terminating on another path — just drop it from the ledger.
      this.clearAgent(prior.agentId);
      return;
    }
    prior.closing = true;
    // Best-effort degraded after-snapshot of the prior turn WHILE it is still open, so
    // the (partial) after state is recoverable; failure does not block. after_quality
    // stays 'none' — an interrupted turn never completed cleanly.
    await this.tryAfterSnapshot(prior, 'none');
    this.store.closeTurn(prior.turnId, 'interrupted', { afterQuality: 'none' }, this.now());
    this.clearAgent(prior.agentId);
  }

  // ── startup reconciliation ───────────────────────────────────────────────────────

  /**
   * Close every dangling `open` row for the workspace as `crashed` (a process that
   * exited without closing its turn). Idempotent: `closeTurn` is a no-op on a terminal
   * row, so a second pass finds nothing open. Ref/DB reconciliation of the persisted
   * candidate OIDs is WP-G1.8 — this is the seam where that runs.
   */
  reconcileOpenTurns(workspaceId: string): number {
    let closed = 0;
    for (const row of this.store.listTurnRecords(workspaceId)) {
      if (row.status !== 'open') continue;
      this.store.closeTurn(row.id, 'crashed', { afterQuality: 'none' }, this.now());
      closed++;
    }
    // Drop any stale in-memory state for this workspace (fresh process has none).
    for (const [agentId, state] of this.openByAgent) {
      if (state.ctx.workspaceId === workspaceId) this.clearAgent(agentId);
    }
    // SEAM (WP-G1.8): ref/DB crash-consistency reconciliation lives in
    // `reconciler.ts`. `reconciler.reconcileWorkspace` runs the edge reconciliation
    // FIRST (regenerating/adopting the deterministic ref for each persisted-non-ready
    // edge) and then drives the dangling-open close through this method (passed as its
    // `closeOpenTurns` seam), so a live coordinator's close path and the boot path
    // share one implementation. This method itself stays the pure close primitive.
    return closed;
  }

  // ── teardown ─────────────────────────────────────────────────────────────────────

  /** Close all open turns `interrupted` (best-effort after-snapshot) and unsubscribe.
   *  Supervisor shutdown. Returns after every close is issued. */
  async shutdown(): Promise<void> {
    const states = [...this.openByAgent.values()];
    for (const state of states) {
      if (state.closing) continue;
      state.closing = true;
      try {
        await this.tryAfterSnapshot(state, 'none');
      } finally {
        this.store.closeTurn(state.turnId, 'interrupted', { afterQuality: 'none' }, this.now());
        this.clearAgent(state.agentId);
      }
    }
    this.unsubscribe();
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────

  /** Best-effort AFTER snapshot for a still-open turn. Swallows every failure — the
   *  after edge fails open (plan §6: fail-open on the after edge only). */
  private async tryAfterSnapshot(state: AgentTurnState, quality: AfterQuality | 'none'): Promise<void> {
    try {
      await this.capture({
        edge: 'after',
        turnId: state.turnId,
        workspaceId: state.ctx.workspaceId,
        agentId: state.agentId,
        capability: state.ctx.capability,
        quality,
      });
    } catch {
      /* best-effort — a failed after-snapshot never blocks the close */
    }
  }

  private clearAgent(agentId: string): void {
    this.openByAgent.delete(agentId);
    this.completion.reset(agentId);
    this.witnessRouter?.setActiveTurn(agentId, null);
  }

  /** updateTurnRecord that swallows the terminal-immutability throw — used only on
   *  the still-open before edge, where a concurrent close is a benign race. */
  private safeUpdate(turnId: string, updates: Record<string, unknown>): void {
    try {
      this.store.updateTurnRecord(turnId, updates);
    } catch {
      /* row raced to terminal — the degraded downgrade is moot on a closed row */
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown-error';
  }
}
