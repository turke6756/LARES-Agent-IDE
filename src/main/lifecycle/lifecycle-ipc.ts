// Idle-agent lifecycle §B7/§B9 — the IPC surface and the bulk-stop runner.
//
// THE load-bearing rule of this module: **the renderer never supplies a stop
// reason.** Each endpoint assigns its own, so a compromised or buggy renderer
// cannot claim `automatic-stale-idle` (or `supervisor` / `restart` /
// `terminal-capture-failure`, which have no IPC entry at all) and forge the
// provenance the UI later renders as "Stopped automatically after 24h idle".
//
//   agent:stop             → 'manual-card'
//   agent:stop-bulk        → 'manual-selection'
//   agent:stop-stale-idle  → 'manual-stale-idle'
//
// Everything else the renderer sends is validated here too: the mode through
// `isStopEligibilityMode`, ids through a string check, then dedupe and a hard
// `BULK_STOP_MAX` cap.

import {
  BULK_STOP_MAX,
  DEFAULT_LIFECYCLE_SETTINGS,
  isStopEligibilityMode,
  type AgentStopReason,
  type AutoStopThreshold,
  type BulkStopItemResult,
  type BulkStopRequest,
  type BulkStopResult,
  type LifecycleSettings,
  type StaleIdlePreview,
  type StopEligibilityMode,
} from '../../shared/types';
import {
  assembleGuardSnapshot,
  evaluateStopEligibility,
  AUTO_STOP_THRESHOLD_MS,
  type GuardAgentRow,
  type GuardDeps,
} from './guards';

export const LIFECYCLE_CHANNELS = {
  stop: 'agent:stop',
  stopBulk: 'agent:stop-bulk',
  stopStaleIdle: 'agent:stop-stale-idle',
  previewStaleIdle: 'agent:preview-stale-idle',
  getSettings: 'lifecycle:get-settings',
  setSettings: 'lifecycle:set-settings',
  settingsChanged: 'lifecycle:settings-changed',
} as const;

export interface BulkStopDeps {
  /** §B6.1 — the locked, guard-evaluating stop. */
  stopIfEligible(
    agentId: string,
    mode: StopEligibilityMode,
    reason: AgentStopReason,
    opts?: { staleThresholdMs?: number | null; confirmActive?: boolean },
  ): Promise<BulkStopItemResult>;
  /** Every agent the stale-idle selector may consider. */
  listAgents(): GuardAgentRow[];
  guardDeps: GuardDeps;
  loadSettings(): LifecycleSettings;
  saveSettings(settings: LifecycleSettings): LifecycleSettings;
  /** Push the new settings to EVERY window, not just the sender's. */
  broadcastSettings(settings: LifecycleSettings): void;
}

// ── Request validation ───────────────────────────────────────────────────────

/**
 * Normalize whatever the renderer sent. Never throws on hostile input; an
 * unusable request comes back with an empty id list, which the runner turns
 * into an empty result rather than a crash.
 *
 * Note what is NOT read here: `reason`. There is no code path from renderer
 * input to a stop reason.
 */
export function normalizeBulkRequest(raw: unknown): { agentIds: string[]; mode: StopEligibilityMode; confirmActive: boolean } {
  const req = (raw ?? {}) as Partial<BulkStopRequest>;
  const mode: StopEligibilityMode = isStopEligibilityMode(req.mode) ? req.mode : 'explicit';
  const ids = Array.isArray(req.agentIds) ? req.agentIds : [];
  const seen = new Set<string>();
  const agentIds: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    agentIds.push(id);
    if (agentIds.length >= BULK_STOP_MAX) break; // dedupe FIRST, then cap
  }
  return { agentIds, mode, confirmActive: req.confirmActive === true };
}

// ── Bulk runner ──────────────────────────────────────────────────────────────

/**
 * SEQUENTIAL by design. Each agent's stop takes its own lifecycle lock and can
 * escalate to a verified kill; running them concurrently would multiply the
 * process-enumeration cost and make the run summary unreadable, for no user-
 * visible gain on a batch the human is watching.
 */
export async function runBulkStop(
  raw: unknown,
  reason: AgentStopReason,
  deps: BulkStopDeps,
  opts?: { staleThresholdMs?: number | null },
): Promise<BulkStopResult> {
  const { agentIds, mode, confirmActive } = normalizeBulkRequest(raw);
  const items: BulkStopItemResult[] = [];
  for (const agentId of agentIds) {
    try {
      items.push(await deps.stopIfEligible(agentId, mode, reason, {
        staleThresholdMs: opts?.staleThresholdMs ?? null,
        confirmActive,
      }));
    } catch (e) {
      // One agent's failure must not abort the rest of the batch.
      console.warn(`[lifecycle] bulk stop of ${agentId} threw:`, e);
      items.push({ agentId, result: 'failed', codes: [] });
    }
  }
  return { items };
}

// ── Stale-idle selection ─────────────────────────────────────────────────────

export function thresholdMsFor(label: AutoStopThreshold): number | null {
  return AUTO_STOP_THRESHOLD_MS[label] ?? null;
}

/**
 * The candidate set + verdicts for the current threshold. Shared by the preview
 * endpoint and the sweep, so what the panel SHOWS and what the sweep DOES are
 * produced by the same code — a preview that could drift from the action would
 * be worse than no preview.
 *
 * `never` yields an empty preview: no candidates, nothing excluded.
 */
export async function buildStaleIdlePreview(deps: BulkStopDeps): Promise<StaleIdlePreview> {
  const settings = deps.loadSettings();
  const thresholdLabel = settings.autoStopIdleThreshold;
  const staleThresholdMs = thresholdMsFor(thresholdLabel);
  const preview: StaleIdlePreview = {
    thresholdLabel,
    eligible: [],
    excluded: [],
    estimatedReclaimBytes: null,
  };
  if (staleThresholdMs === null) return preview;

  // Only idle agents are candidates; a non-idle agent would just come back
  // `not_idle` and bury the real exclusions in noise.
  const candidates = deps.listAgents().filter((a) => a.status === 'idle');
  const snap = await assembleGuardSnapshot(candidates.map((a) => a.id), deps.guardDeps, { staleThresholdMs });
  for (const agent of candidates) {
    const e = evaluateStopEligibility(agent.id, 'stale-idle', snap);
    if (e.eligible) preview.eligible.push({ agentId: agent.id, idleSince: e.idleSince ?? agent.idleSince ?? '' });
    // `threshold_not_met` is the normal state of most idle agents; listing them
    // as "excluded" would drown the panel.
    else if (!(e.exclusions.length === 1 && e.exclusions[0] === 'threshold_not_met')) {
      preview.excluded.push({ agentId: agent.id, codes: e.exclusions });
    }
  }
  return preview;
}

/** Stop every currently-eligible stale-idle agent. Used by both the manual
 *  "Stop stale idle" endpoint and the sweep — only the reason differs. */
export async function runStaleIdleStop(reason: AgentStopReason, deps: BulkStopDeps): Promise<BulkStopResult> {
  const preview = await buildStaleIdlePreview(deps);
  const staleThresholdMs = thresholdMsFor(preview.thresholdLabel);
  if (staleThresholdMs === null) return { items: [] };
  // Re-evaluated per agent INSIDE its lock by stopIfEligible — the preview only
  // decides who to ASK about, never who gets killed.
  return runBulkStop(
    { agentIds: preview.eligible.map((e) => e.agentId), mode: 'stale-idle' },
    reason,
    deps,
    { staleThresholdMs },
  );
}

// ── IPC registration ─────────────────────────────────────────────────────────

export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerLifecycleIpc(ipc: IpcLike, deps: BulkStopDeps): void {
  // Single-agent stop from the card. The id is the ONLY renderer input.
  ipc.handle(LIFECYCLE_CHANNELS.stop, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '') return { items: [] } satisfies BulkStopResult;
    return runBulkStop({ agentIds: [id], mode: 'explicit', confirmActive: true }, 'manual-card', deps);
  });

  ipc.handle(LIFECYCLE_CHANNELS.stopBulk, async (_e, req: unknown) =>
    runBulkStop(req, 'manual-selection', deps));

  ipc.handle(LIFECYCLE_CHANNELS.stopStaleIdle, async () =>
    runStaleIdleStop('manual-stale-idle', deps));

  ipc.handle(LIFECYCLE_CHANNELS.previewStaleIdle, async () => buildStaleIdlePreview(deps));

  ipc.handle(LIFECYCLE_CHANNELS.getSettings, () => deps.loadSettings());

  ipc.handle(LIFECYCLE_CHANNELS.setSettings, (_e, raw: unknown) => {
    // Validate main-side: the renderer's enum is not to be trusted.
    const t = (raw ?? {}) as { autoStopIdleThreshold?: unknown };
    const next: LifecycleSettings =
      typeof t.autoStopIdleThreshold === 'string' && t.autoStopIdleThreshold in AUTO_STOP_THRESHOLD_MS
        ? { autoStopIdleThreshold: t.autoStopIdleThreshold as AutoStopThreshold }
        : { ...DEFAULT_LIFECYCLE_SETTINGS };
    const saved = deps.saveSettings(next);
    // EVERY window — a detached window showing the same setting must not keep
    // rendering a stale threshold.
    deps.broadcastSettings(saved);
    return saved;
  });
}
