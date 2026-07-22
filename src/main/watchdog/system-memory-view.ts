// Composed System-Memory view DTO (System-Memory polish Part 2).
//
// The single main-process compositor behind `memory:system-view`: joins the
// canonical live-agent registry (getActiveAgents) to the latest attribution
// rollup and the sampler's commit snapshot, and derives the commit-charge
// breakdown (App / live agents / other-system) with explicit completeness.
//
// Composition rules that matter:
//   - "Live agents" is the REGISTRY count. The join iterates the registry and
//     looks attribution rows up by agentId — never the other way around.
//     Ownership rows include prior-epoch trees; presenting them as the live set
//     can never reconcile with the live count.
//   - Unknown ≠ zero. A live agent with no ownership row (mid-launch) gets
//     null memory fields, not 0 B. The one deliberate known-zero: ZERO live
//     agents ⇒ liveAgents = { bytes: 0, complete: true }.
//   - Only commit/private bytes enter the breakdown. Working-set numbers stay
//     in their own per-row column and never divide `commitChargeBytes`.
//   - The exact "Other/system" residual exists only when the charge is known
//     AND both categories are complete AND every live agent attributed;
//     otherwise the remainder is labeled "+ unattributed" by the renderer.
//
// PURE + dependency-injected, same style as attribution.ts — unit-testable
// with no database, no sampler, no electron.

import type { AttributionResult, CommitCategory } from './attribution';

export interface SystemMemoryViewDeps {
  /** Canonical live registry: getActiveAgents() rows (id, title, status, idleSince). */
  listLiveAgents: () => Array<{ id: string; title: string; status: string; idleSince: string | null }>;
  /** Latest attribution result (may be null before first refresh). */
  getAttribution: () => AttributionResult | null;
  /** Latest sampler snapshot (for commitChargeBytes/commitKnown), may be null. */
  getSnapshot: () => { commitKnown: boolean; commitChargeBytes: number | null; commitLimitBytes: number | null; at: number } | null;
  now: () => number;
}

export interface LiveAgentMemoryRow {
  agentId: string;
  title: string;                      // registry title; never blank — falls back to agentId
  status: string;                     // AgentStatus at composition time
  idleSince: string | null;           // registry idleSince (SQLite UTC string)
  transport: 'conpty' | 'wsl' | null; // null ⇒ no ownership row for this live agent
  source: 'job' | 'tree-walk' | 'none' | null;
  workingSetBytes: number | null;     // null ⇒ unattributable (no row / source none)
  commitBytes: number | null;
  commitComplete: boolean;
  pidCount: number;
}

export interface CommitBreakdown {
  commitChargeBytes: number | null;        // null ⇔ sampler commitKnown false
  electron: CommitCategory | null;
  liveAgents: CommitCategory | null;       // sum over LIVE rows only (never AppOwnedTotals)
  unattributedLiveAgentCount: number;      // live rows with commitBytes === null or !commitComplete
  /** Exact only when charge known AND both categories complete AND every live
   *  agent attributed; otherwise null — UI labels the remainder
   *  "Other/system + unattributed". */
  otherSystemBytes: number | null;
  /** True when the exact residual was negative within tolerance (clamped), or
   *  attribution `at` is > 60 s older than the commit sample. */
  approximate: boolean;
  attributionAt: number | null;
  sampleAt: number | null;
}

export interface SystemMemoryViewResult {
  liveAgents: LiveAgentMemoryRow[];   // exactly one row per registry live agent
  liveAgentCount: number;             // === liveAgents.length, by construction
  /** Ownership rows whose agentId is NOT in the live registry (prior-epoch /
   *  terminal). Kept visible: memory-consuming trees must not silently vanish
   *  from a memory view — the orphan sweep is where they get reclaimed. */
  unregisteredTrees: Array<{ agentId: string; transport: string; workingSetBytes: number; commitBytes: number; pidCount: number; source: string }>;
  breakdown: CommitBreakdown;
  at: number;
}

/** Sampling-skew tolerance for a slightly negative residual: the snapshot and
 *  the attribution pass are taken at different instants, so App+agents can
 *  legitimately exceed the sampled total by a hair. Clamp within tolerance
 *  rather than flickering into "incomplete". */
const RESIDUAL_TOLERANCE_FRACTION = 0.02;
const RESIDUAL_TOLERANCE_FLOOR_BYTES = 64 * 1024 * 1024; // 64 MiB
const ATTRIBUTION_STALE_MS = 60_000;

export function composeSystemMemoryView(deps: SystemMemoryViewDeps): SystemMemoryViewResult {
  const registry = safe(() => deps.listLiveAgents(), []);
  const attr = safe<AttributionResult | null>(() => deps.getAttribution(), null);
  const snap = safe<ReturnType<SystemMemoryViewDeps['getSnapshot']>>(() => deps.getSnapshot(), null);
  const at = safe(() => deps.now(), 0);

  const byAgentId = new Map((attr?.perAgent ?? []).map((u) => [u.agentId, u]));
  const liveIds = new Set(registry.map((a) => a.id));

  // Join direction: iterate the LIVE registry, look attribution up by id. A
  // live agent with no row (e.g. mid-launch) is synthesized with null memory.
  const liveAgents: LiveAgentMemoryRow[] = registry.map((a) => {
    const u = byAgentId.get(a.id);
    if (!u || u.source === 'none') {
      return {
        agentId: a.id,
        title: a.title || a.id,
        status: a.status,
        idleSince: a.idleSince,
        transport: u?.transport ?? null,
        source: u ? u.source : null,
        workingSetBytes: null,
        commitBytes: null,
        commitComplete: false,
        pidCount: u?.pidCount ?? 0,
      };
    }
    return {
      agentId: a.id,
      title: a.title || a.id,
      status: a.status,
      idleSince: a.idleSince,
      transport: u.transport,
      source: u.source,
      workingSetBytes: u.cliTreeBytes,
      commitBytes: u.cliCommitBytes,
      commitComplete: u.commitComplete,
      pidCount: u.pidCount,
    };
  });

  const unregisteredTrees = (attr?.perAgent ?? [])
    .filter((u) => !liveIds.has(u.agentId))
    .map((u) => ({
      agentId: u.agentId,
      transport: u.transport,
      workingSetBytes: u.cliTreeBytes,
      commitBytes: u.cliCommitBytes,
      pidCount: u.pidCount,
      source: u.source,
    }));

  // Live-agent commit category — over LIVE rows only. AppOwnedTotals.ownedCli*
  // would fold unregistered trees in and misclassify orphan memory as
  // live-agent memory. Zero live agents is a KNOWN zero, not unknown.
  let liveCategory: CommitCategory | null;
  if (liveAgents.length === 0) {
    // A registry fact, independent of attribution: no live agents ⇒ their
    // commit share is a KNOWN zero.
    liveCategory = { bytes: 0, complete: true };
  } else if (attr == null) {
    // Attribution cold with live agents present: nothing measurable — null,
    // not a false "0 B".
    liveCategory = null;
  } else {
    let bytes = 0;
    let complete = true;
    for (const row of liveAgents) {
      if (row.commitBytes != null) bytes += row.commitBytes;
      if (!row.commitComplete) complete = false;
    }
    liveCategory = { bytes, complete };
  }
  const unattributedLiveAgentCount = liveAgents.filter(
    (r) => r.commitBytes === null || !r.commitComplete,
  ).length;

  const electron = attr?.electronCommit ?? null;
  const commitChargeBytes = snap != null && snap.commitKnown ? snap.commitChargeBytes : null;
  const attributionAt = attr?.at ?? null;
  const sampleAt = snap?.at ?? null;

  let otherSystemBytes: number | null = null;
  let approximate =
    attributionAt != null && sampleAt != null && sampleAt - attributionAt > ATTRIBUTION_STALE_MS;

  if (
    commitChargeBytes != null &&
    electron != null && electron.complete &&
    liveCategory != null && liveCategory.complete &&
    unattributedLiveAgentCount === 0
  ) {
    const raw = commitChargeBytes - electron.bytes - liveCategory.bytes;
    if (raw >= 0) {
      otherSystemBytes = raw;
    } else {
      const tolerance = Math.max(
        RESIDUAL_TOLERANCE_FRACTION * (snap?.commitLimitBytes ?? commitChargeBytes),
        RESIDUAL_TOLERANCE_FLOOR_BYTES,
      );
      if (Math.abs(raw) <= tolerance) {
        otherSystemBytes = 0; // sampling skew is normal — clamp, don't flicker
        approximate = true;
      } else {
        otherSystemBytes = null; // beyond tolerance: something is off — say "unknown"
        approximate = true;
      }
    }
  }

  return {
    liveAgents,
    liveAgentCount: liveAgents.length,
    unregisteredTrees,
    breakdown: {
      commitChargeBytes,
      electron,
      liveAgents: liveCategory,
      unattributedLiveAgentCount,
      otherSystemBytes,
      approximate,
      attributionAt,
      sampleAt,
    },
    at,
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
