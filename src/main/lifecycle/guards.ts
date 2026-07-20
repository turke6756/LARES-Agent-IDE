// Idle-agent lifecycle §B4 — stop guards & eligibility.
//
// Two pure-ish pieces, deliberately separated:
//
//   assembleGuardSnapshot()  — the ONE async pass that reads every guard source
//                              for a whole batch of agents. Anything that
//                              throws, is missing, or returns undefined becomes
//                              `guard_unavailable` for that agent rather than a
//                              silent "clear".
//   evaluateStopEligibility() — SYNCHRONOUS and pure over that snapshot, so the
//                              decision is reproducible and testable with no
//                              I/O and no clock skew inside a batch.
//
// The mode is the whole policy:
//   - 'stale-idle'  → FAIL CLOSED. Every active guard (including
//                     `guard_unavailable` and `ownership_unverified`) excludes
//                     the agent. Nothing is auto-stopped that we cannot fully
//                     account for.
//   - 'explicit'    → the human named this agent. Guards do not veto them; they
//                     come back as `warnings` and the caller decides (B9 gates
//                     execution on `confirmActive`).
//
// All dependencies are injected: no import of the supervisor, the browser
// manager or the DB from here, so the whole module unit-tests without Electron.

import type {
  AgentStatus,
  StopEligibility,
  StopEligibilityMode,
  StopExclusionCode,
} from '../../shared/types';

// ── Dependency surface ───────────────────────────────────────────────────────

export interface GuardAgentRow {
  id: string;
  status: AgentStatus;
  idleSince: string | null;
}

export type StopOwnershipKind = 'verified-job' | 'verified-tree' | 'wsl-tmux' | 'gone' | 'unverifiable';

export interface AgentBrowserState {
  agentId: string;
  tabCount: number;
  loading: boolean;
  signinPending: boolean;
  needsHumanAttention: boolean;
  pendingDownload: boolean;
  activeLease: boolean;
}

/**
 * Every guard source. Each may throw or return undefined — the assembler
 * converts that into `guard_unavailable` for the affected agent instead of
 * letting an unreadable guard read as "clear".
 */
export interface GuardDeps {
  /** The agent row, or null/undefined when it does not exist → `not_found`. */
  getAgent(agentId: string): GuardAgentRow | null | undefined;
  /** Live (non-terminal) agents owned by this agent — a supervisor's children. */
  getLiveChildren(agentId: string): GuardAgentRow[];
  /** Supervisor ids that own a starting/running deliberation. */
  activeOrchestrationIds(): Iterable<string>;
  hasPendingDelivery(agentId: string): boolean;
  isContinuationInFlight(agentId: string): boolean;
  isLifecycleLocked(agentId: string): boolean;
  /** True when THIS app instance holds a runner for the agent. */
  hasLiveRunner(agentId: string): boolean;
  verifyStopOwnership(agentId: string): { kind: StopOwnershipKind } | null | undefined;
  /** null → cannot enumerate → `guard_unavailable` (never "clear"). */
  getAgentBrowserState(agentId: string): AgentBrowserState | null | undefined;
  now(): number;
}

export interface AssembleOptions {
  /**
   * The agent whose lifecycle lock the CALLER already holds (B6.1 runs the
   * snapshot from inside `withLifecycleLock`). Its own lock must never exclude
   * it — otherwise every locked stop would immediately declare itself
   * `lifecycle_busy` and nothing would ever stop.
   */
  selfLockedAgent?: string;
  /** Idle age required by 'stale-idle' mode. null = no threshold applies. */
  staleThresholdMs?: number | null;
}

/** One agent's guard readings. Every field is a fact, not a decision. */
export interface AgentGuardState {
  agentId: string;
  found: boolean;
  status: AgentStatus | null;
  idleSince: string | null;
  idleForMs: number | null;
  activeChild: boolean;
  activeOrchestration: boolean;
  pendingDelivery: boolean;
  /** A continuation swap in flight, or a browser tab flagged for the human. */
  humanAttention: boolean;
  browserLease: boolean;
  /** A verified live process this instance holds no runner for. */
  detachedProcess: boolean;
  ownershipUnverified: boolean;
  lifecycleBusy: boolean;
  /** Guard sources that threw / returned undefined. Non-empty → fail closed. */
  unavailable: string[];
}

export interface GuardSnapshot {
  takenAt: number;
  staleThresholdMs: number | null;
  agents: Map<string, AgentGuardState>;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function emptyState(agentId: string): AgentGuardState {
  return {
    agentId,
    found: false,
    status: null,
    idleSince: null,
    idleForMs: null,
    activeChild: false,
    activeOrchestration: false,
    pendingDelivery: false,
    humanAttention: false,
    browserLease: false,
    detachedProcess: false,
    ownershipUnverified: false,
    lifecycleBusy: false,
    unavailable: [],
  };
}

/** Run one guard read; a throw or an `undefined` result marks it unavailable. */
function read<T>(state: AgentGuardState, name: string, fn: () => T): T | undefined {
  try {
    const v = fn();
    if (v === undefined) {
      state.unavailable.push(name);
      return undefined;
    }
    return v;
  } catch {
    state.unavailable.push(name);
    return undefined;
  }
}

/** Parse an ISO/SQLite `idle_since` into epoch-ms; NaN → unusable. */
export function parseIdleSince(raw: string | null): number | null {
  if (!raw) return null;
  // SQLite `datetime('now')` yields 'YYYY-MM-DD HH:MM:SS' in UTC with no zone
  // marker; Date would read that as LOCAL time and silently shift the clock.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * ONE snapshot for the whole batch: every agent is judged against the same
 * clock and the same orchestration/lock reading, so a long batch cannot see the
 * world shift underneath it mid-loop.
 */
export async function assembleGuardSnapshot(
  agentIds: string[],
  deps: GuardDeps,
  opts?: AssembleOptions,
): Promise<GuardSnapshot> {
  const takenAt = (() => {
    try { return deps.now(); } catch { return Date.now(); }
  })();
  const staleThresholdMs = opts?.staleThresholdMs ?? null;
  const snapshot: GuardSnapshot = { takenAt, staleThresholdMs, agents: new Map() };

  // Batch-wide reads first. A failure here marks EVERY agent's guard
  // unavailable rather than pretending no orchestration is running.
  let orchestrationIds: Set<string> | null = null;
  try {
    const ids = deps.activeOrchestrationIds();
    orchestrationIds = ids === undefined ? null : new Set(ids);
  } catch {
    orchestrationIds = null;
  }

  for (const agentId of agentIds) {
    const state = emptyState(agentId);
    snapshot.agents.set(agentId, state);

    if (orchestrationIds === null) state.unavailable.push('activeOrchestrationIds');
    else state.activeOrchestration = orchestrationIds.has(agentId);

    const row = read(state, 'getAgent', () => deps.getAgent(agentId));
    if (row === undefined) continue; // guard source failed — fail-closed downstream
    if (row === null) continue; // genuinely absent → found stays false → not_found
    state.found = true;
    state.status = row.status;
    state.idleSince = row.idleSince ?? null;
    const idleAt = parseIdleSince(state.idleSince);
    state.idleForMs = idleAt === null ? null : Math.max(0, takenAt - idleAt);

    const children = read(state, 'getLiveChildren', () => deps.getLiveChildren(agentId));
    if (children !== undefined) state.activeChild = children.length > 0;

    const pending = read(state, 'hasPendingDelivery', () => deps.hasPendingDelivery(agentId));
    if (pending !== undefined) state.pendingDelivery = pending;

    const continuation = read(state, 'isContinuationInFlight', () => deps.isContinuationInFlight(agentId));

    const locked = read(state, 'isLifecycleLocked', () => deps.isLifecycleLocked(agentId));
    if (locked !== undefined) {
      // The caller's OWN lock must never exclude the agent it is stopping.
      state.lifecycleBusy = locked && agentId !== opts?.selfLockedAgent;
    }

    const ownership = read(state, 'verifyStopOwnership', () => deps.verifyStopOwnership(agentId));
    if (ownership === undefined || ownership === null) {
      if (ownership === null) state.unavailable.push('verifyStopOwnership');
    } else {
      state.ownershipUnverified = ownership.kind === 'unverifiable';
      const verifiedLive =
        ownership.kind === 'verified-job' || ownership.kind === 'verified-tree' || ownership.kind === 'wsl-tmux';
      if (verifiedLive) {
        const attached = read(state, 'hasLiveRunner', () => deps.hasLiveRunner(agentId));
        // A verified live process this instance is NOT attached to: stopping it
        // means reaching outside our own runner map. Honest to surface.
        if (attached !== undefined) state.detachedProcess = !attached;
      }
    }

    const browser = read(state, 'getAgentBrowserState', () => deps.getAgentBrowserState(agentId));
    if (browser === null) {
      // Explicitly "could not enumerate" — NOT "no tabs".
      state.unavailable.push('getAgentBrowserState');
    } else if (browser !== undefined) {
      // An empty tab list is a CLEAR reading: every flag stays false.
      state.browserLease = browser.activeLease || browser.loading || browser.pendingDownload;
      state.humanAttention = browser.needsHumanAttention || browser.signinPending;
    }

    // A mid-flight continuation is the human's work in progress just as much as
    // a tab waiting on them; so is an agent parked on a question.
    if (continuation === true) state.humanAttention = true;
    if (row.status === 'waiting') state.humanAttention = true;
  }

  return snapshot;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Decide, from a snapshot alone, whether `agentId` may be stopped.
 *
 * `stale-idle` fails closed on EVERY active guard, `guard_unavailable` and
 * `ownership_unverified` included. `explicit` returns eligible with the same
 * set as `warnings` — except `not_found`, which no mode can stop.
 */
export function evaluateStopEligibility(
  agentId: string,
  mode: StopEligibilityMode,
  snapshot: GuardSnapshot,
): StopEligibility {
  const state = snapshot.agents.get(agentId);
  if (!state) {
    // Never assembled → we know nothing at all. Fail closed in both modes.
    return { agentId, eligible: false, exclusions: ['guard_unavailable'], warnings: [], idleSince: null };
  }
  if (!state.found) {
    const code: StopExclusionCode = state.unavailable.length > 0 ? 'guard_unavailable' : 'not_found';
    return { agentId, eligible: false, exclusions: [code], warnings: [], idleSince: null };
  }

  const codes: StopExclusionCode[] = [];
  if (state.unavailable.length > 0) codes.push('guard_unavailable');
  if (state.status !== 'idle') codes.push('not_idle');
  // The idle threshold is a STALE-IDLE concept only: an explicit stop the human
  // asked for is not "too recent to stop".
  if (mode === 'stale-idle' && snapshot.staleThresholdMs !== null) {
    // No usable idle clock is NOT a pass: an agent whose idle_since we cannot
    // read has not demonstrably been idle long enough.
    if (state.idleForMs === null || state.idleForMs < snapshot.staleThresholdMs) codes.push('threshold_not_met');
  }
  if (state.activeChild) codes.push('active_child');
  if (state.activeOrchestration) codes.push('active_orchestration');
  if (state.pendingDelivery) codes.push('pending_delivery');
  if (state.humanAttention) codes.push('human_attention');
  if (state.browserLease) codes.push('browser_lease');
  if (state.detachedProcess) codes.push('detached_process');
  if (state.ownershipUnverified) codes.push('ownership_unverified');
  if (state.lifecycleBusy) codes.push('lifecycle_busy');

  if (mode === 'stale-idle') {
    return { agentId, eligible: codes.length === 0, exclusions: codes, warnings: [], idleSince: state.idleSince };
  }
  // explicit: the human named this agent. Report, do not veto.
  return { agentId, eligible: true, exclusions: [], warnings: codes, idleSince: state.idleSince };
}

/** Idle-age thresholds, in ms. `never` disables the sweep entirely. */
export const AUTO_STOP_THRESHOLD_MS: Record<string, number | null> = {
  never: null,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};
