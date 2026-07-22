// lane-attribution.ts — the four-tier honest attribution classifier (WP-C / P2).
//
// PURE + IO-free. Given the signals available for one MCP call (does its session
// resolve to a dashboard agent? does its stream carry explicit lane metadata? which
// toolset does the tool belong to?), decide ONE attribution tier and, where honest,
// a lane — WITHOUT chasing 100% attribution via slug/cwd heuristics (the root
// CLAUDE.md invariant: cwd/slug is many-to-one per agent, so a shared working
// directory can NEVER be treated as one agent).
//
// Precedence, strongest first (see AttributionTier in shared/types.ts):
//   1. agent-attributed                  — session/agent metadata resolves.
//   2. lane-attributed-explicit          — stream_lane_stats.lane is present.
//   3. lane-inferred-from-current-grant  — the tool's toolset is granted to EXACTLY
//                                          ONE lane per `toolsetsForLane`. Lower
//                                          confidence; carries a `reason`. NEVER
//                                          emitted for a toolset granted to > 1 lane.
//                                          Grant-EPOCH history (config_epochs) is
//                                          deferred — we do NOT invent epoch metadata.
//   4. unattributed                      — first-class, visible, never dropped.
//
// The aggregate product (tierBreakdown / coverage % / confidence band / firewall)
// lives in the sibling `attribution.ts`, which consumes the tiers this module emits.

import type { AgentRoleLane, AttributionTier } from '../../shared/types';
import { toolsetsForLane } from '../supervisor/mcp-config-builder';

// ─────────────────────────────────────────────────────────────────────────────
// cwd → lane (the honesty cornerstone of the behavior-grounded optimizer,
// behavior-grounded-optimizer-design.md §4.2). `lane` lives in exactly one place
// (stream_lane_stats) and every downstream query joins to it; this is the single
// source of truth for deriving it.
//
// Pure + IO-free. Lane is derived from a stream's FIRST-entry (launch) working
// directory — NOT last-seen — because dashboard agents launch in a `.lares/**`
// template subdir and then `cd` to the workspace root (wp2b §4.3 / master caution).
// The launch cwd is the stable role signal; the post-cd cwd is not.
//
// This is a DIFFERENT concern from `classifyAttribution` below: this maps a launch
// cwd → lane; `classifyAttribution` classifies a single MCP call's attribution tier.
// They are complementary and co-located here.
// ─────────────────────────────────────────────────────────────────────────────

/** The lane a launch cwd resolves to. Superset of `AgentRoleLane` with `unknown`
 *  for an unrecognized `.lares/**` (or legacy `.dashboard/**`) template dir or an unusable path. */
export type LaneVerdict = 'supervisor' | 'researcher' | 'worker' | 'legacy' | 'unknown';

const TEMPLATE_TAILS: readonly { tail: string; lane: LaneVerdict }[] = [
  { tail: '.lares/supervisor', lane: 'supervisor' },
  { tail: '.lares/researcher', lane: 'researcher' },
  { tail: '.lares/workers/claude', lane: 'worker' },
  { tail: '.lares/workers/codex', lane: 'worker' },
  // Legacy `.dashboard/**` template dirs — historical session streams (and
  // rename-failed fallback sessions) permanently carry the old name, so the
  // lane derivation must keep recognizing both. Never used for construction.
  { tail: '.dashboard/supervisor', lane: 'supervisor' },
  { tail: '.dashboard/researcher', lane: 'researcher' },
  { tail: '.dashboard/workers/claude', lane: 'worker' },
  { tail: '.dashboard/workers/codex', lane: 'worker' },
];

/** Normalize a raw working_dir to forward slashes, lowercased, no trailing sep. */
function normDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Derive the role-lane from a stream's launch working directory. */
export function laneForWorkingDir(dir: string | null | undefined): LaneVerdict {
  if (!dir || !dir.trim()) return 'unknown';
  const n = normDir(dir);
  for (const { tail, lane } of TEMPLATE_TAILS) {
    if (n === tail || n.endsWith('/' + tail)) return lane;
  }
  if (
    n === '.lares' || n.includes('/.lares/') || n.endsWith('/.lares') ||
    n === '.dashboard' || n.includes('/.dashboard/') || n.endsWith('/.dashboard')
  ) {
    return 'unknown';
  }
  return 'legacy';
}

// ─────────────────────────────────────────────────────────────────────────────
// Four-tier per-call attribution classifier (WP-C / P2).
// ─────────────────────────────────────────────────────────────────────────────

/** The label the tier-4 (unattributed) bucket carries in the tool × lane cross-tab. */
export const UNATTRIBUTED_LANE = '(unattributed)';

/** All role-lanes whose grants define the grant topology. `legacy` grants nothing,
 *  so it never contributes an exclusive toolset — but it is included for
 *  completeness so the topology is derived from the SAME source of truth the
 *  launcher uses (`toolsetsForLane`), not a hand-maintained copy. */
export const KNOWN_LANES: readonly AgentRoleLane[] = ['supervisor', 'worker', 'researcher', 'legacy'];

/** toolset → the set of lanes that grant it today, derived from `toolsetsForLane`.
 *  This is the CURRENT grant topology only (no epoch history). */
export function buildToolsetLaneGrants(
  lanes: readonly AgentRoleLane[] = KNOWN_LANES,
): Map<string, Set<AgentRoleLane>> {
  const grants = new Map<string, Set<AgentRoleLane>>();
  for (const lane of lanes) {
    const list = toolsetsForLane(lane)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const toolset of list) {
      const set = grants.get(toolset) ?? new Set<AgentRoleLane>();
      set.add(lane);
      grants.set(toolset, set);
    }
  }
  return grants;
}

/** The single lane a toolset is exclusively granted to today, or null when the
 *  toolset is granted to zero or MORE THAN ONE lane. A multi-lane toolset MUST
 *  return null — inferring a lane from a shared grant would be a false claim. */
export function exclusiveLaneForToolset(
  toolset: string | null,
  grants: Map<string, Set<AgentRoleLane>>,
): AgentRoleLane | null {
  if (!toolset) return null;
  const lanes = grants.get(toolset);
  if (!lanes || lanes.size !== 1) return null;
  return [...lanes][0];
}

/** The raw per-call signals the classifier keys on. */
export interface AttributionSignals {
  /** True when session_id resolved to a dashboard agent (agent_sessions join hit). */
  hasAgent: boolean;
  /** stream_lane_stats.lane, or null/'unknown' when absent. */
  explicitLane: string | null;
  /** The tool's resolved toolset (behavior_events.mcp_toolset), or null. */
  toolset: string | null;
}

export interface AttributionOutcome {
  tier: AttributionTier;
  /** The resolved lane, or '(unattributed)' for tier 4. For agent-attributed calls
   *  the lane is the best available lane signal (explicit, else exclusive-grant),
   *  else '(unattributed)' — the TIER, not the lane, is what carries the agent claim. */
  lane: string;
  /** Machine-stable basis string for the inference tier (empty otherwise). */
  basis: string;
  /** Human reason, present for the inference tier only. */
  reason?: string;
}

function laneIsExplicit(lane: string | null): lane is string {
  return !!lane && lane !== 'unknown';
}

/** Classify ONE call into its four-tier attribution outcome. Precedence is strict:
 *  agent > explicit-lane > exclusive-grant inference > unattributed. */
export function classifyAttribution(
  sig: AttributionSignals,
  grants: Map<string, Set<AgentRoleLane>>,
): AttributionOutcome {
  const exclusiveLane = exclusiveLaneForToolset(sig.toolset, grants);

  // Tier 1 — agent-attributed. Strongest. The lane is a best-effort secondary
  // signal for the cross-tab; the agent claim rides on the tier, not the lane.
  if (sig.hasAgent) {
    const lane = laneIsExplicit(sig.explicitLane)
      ? sig.explicitLane
      : exclusiveLane ?? UNATTRIBUTED_LANE;
    return { tier: 'agent-attributed', lane, basis: '' };
  }

  // Tier 2 — explicit lane metadata on the stream.
  if (laneIsExplicit(sig.explicitLane)) {
    return { tier: 'lane-attributed-explicit', lane: sig.explicitLane, basis: '' };
  }

  // Tier 3 — the toolset is exclusive to exactly one lane today. Lower confidence.
  if (exclusiveLane) {
    return {
      tier: 'lane-inferred-from-current-grant',
      lane: exclusiveLane,
      basis: `current-toolsetsForLane exclusive to ${exclusiveLane}`,
      reason:
        `toolset '${sig.toolset}' is granted to exactly one lane (${exclusiveLane}) today; ` +
        `inferred from the current grant topology, not from session/agent metadata`,
    };
  }

  // Tier 4 — honestly unattributed. Kept first-class.
  return { tier: 'unattributed', lane: UNATTRIBUTED_LANE, basis: '' };
}
