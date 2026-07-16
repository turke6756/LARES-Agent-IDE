// attribution.ts — attribution as a confidence-bearing PRODUCT OUTPUT (WP-C / P2).
//
// PURE + IO-free. Rolls the per-call tiers emitted by `lane-attribution.ts` up into
// the aggregate the surfaces consume: a four-tier breakdown, an honest lane-coverage
// %, and a confidence BAND for that coverage. It is deliberately separate from the
// per-call classifier so the "how confident is the lane claim" policy lives in one
// place.
//
// FIREWALL (non-negotiable). Coverage bands describe LANE-tier claims only. A
// per-agent claim (tier 1) is never promoted to 'direct' on coverage strength — the
// cwd-uniqueness invariant caps per-agent confidence regardless of coverage. Nothing
// in this module maps a per-agent count to a band; `coverageBand` takes only the lane
// coverage %.

import type {
  AttributionCoverageBand,
  AttributionTier,
  AttributionTierBreakdown,
  BehaviorEvidenceTier,
} from '../../shared/types';
import type { PredictedAction } from './guidance-action-model';
import type { OccurrenceVerdict } from './occurrence-classifier';
import { liftConfidenceTier } from './occurrence-classifier';
import { laneForWorkingDir, type LaneVerdict } from './lane-attribution';

// ─────────────────────────────────────────────────────────────────────────────
// Confidence tiers + shared-cwd honesty (design §6). FINAL tier =
// min(evidenceTier, attributionTier) on the ladder observed-safe → observed →
// inferred → heuristic. This per-proposal scoring is a DIFFERENT concern from the
// aggregate coverage product below; both are co-located here.
// ─────────────────────────────────────────────────────────────────────────────

/** The granularity of the thing being attributed — a whole lane, or something
 *  narrower than a lane (which cannot be honestly attributed to a single agent). */
export type TargetGranularity = 'lane-level' | 'narrower-than-lane';

/** What kind of target a proposal edits: a tool grant (strongest clean-dead signal)
 *  or a guidance/prose section (one tier lower). */
export type TargetKind = 'tool-grant' | 'guidance-section';

/** The confidence-scored attribution of a single proposal (design §6). `tier` is the
 *  FINAL min(evidence, attribution) tier consumers read; the components are kept for
 *  transparency. */
export interface AttributionScore {
  tier: BehaviorEvidenceTier;
  sharedCwdRisk: 'none' | 'possible' | 'high';
  lane: LaneVerdict;
  evidenceTier: BehaviorEvidenceTier;
  attributionTier: BehaviorEvidenceTier;
  caveat?: string;
}

/** The thing being scored: an occurrence verdict + how narrow the edit target is,
 *  with optional lane/cwd/kind overrides and a shared-agent count for the caveat. */
export interface AttributionTarget {
  verdict: OccurrenceVerdict;
  granularity: TargetGranularity;
  lane?: LaneVerdict;
  workingDir?: string | null;
  targetKind?: TargetKind;
  sharedAgentCount?: number;
}

const LADDER: BehaviorEvidenceTier[] = ['observed-safe', 'observed', 'inferred', 'heuristic'];
/** min() on the confidence ladder: the LESS confident (higher index) tier wins. */
function minTier(a: BehaviorEvidenceTier, b: BehaviorEvidenceTier): BehaviorEvidenceTier {
  return LADDER.indexOf(a) >= LADDER.indexOf(b) ? a : b;
}

/** Evidence tier for a resolved verdict. A clean dead signal (`never` observed
 *  directly) is promoted to `observed-safe`; otherwise lift the classifier's tier. */
export function evidenceTierOf(verdict: OccurrenceVerdict): BehaviorEvidenceTier {
  if (verdict.status === 'never' && verdict.confidence === 'observed') return 'observed-safe';
  return liftConfidenceTier(verdict.confidence);
}

const REAL_LANES = new Set<LaneVerdict>(['supervisor', 'worker', 'researcher']);

function resolveLane(action: PredictedAction, target: AttributionTarget): LaneVerdict {
  if (target.lane) return target.lane;
  if (target.workingDir != null) return laneForWorkingDir(target.workingDir);
  if (action.lanes.length === 1 && REAL_LANES.has(action.lanes[0])) return action.lanes[0];
  return 'unknown';
}

function resolveTargetKind(action: PredictedAction, target: AttributionTarget): TargetKind {
  if (target.targetKind) return target.targetKind;
  const toolPredicate = action.kind === 'tool-invocation' || action.kind === 'toolset-usage';
  return toolPredicate && action.sourceKind === 'tool' ? 'tool-grant' : 'guidance-section';
}

function attributionTierOf(
  lane: LaneVerdict,
  granularity: TargetGranularity,
  kind: TargetKind,
): { tier: BehaviorEvidenceTier; risk: AttributionScore['sharedCwdRisk'] } {
  if (lane === 'legacy') return { tier: 'heuristic', risk: 'possible' };
  if (!REAL_LANES.has(lane)) return { tier: 'heuristic', risk: 'high' };
  if (granularity === 'narrower-than-lane') return { tier: 'inferred', risk: 'high' };
  return { tier: kind === 'tool-grant' ? 'observed-safe' : 'observed', risk: 'none' };
}

function sharedCwdCaveat(agentCount: number): string {
  return `shared-cwd: behavior pooled across ${agentCount} agents in this slug; cannot attribute to a single agent`;
}

/** Score attribution for one proposal: FINAL tier = min(evidence, attribution),
 *  plus the shared-cwd risk/caveat when the target is narrower than a lane. */
export function scoreAttribution(action: PredictedAction, target: AttributionTarget): AttributionScore {
  const lane = resolveLane(action, target);
  const kind = resolveTargetKind(action, target);
  const evidenceTier = evidenceTierOf(target.verdict);
  const { tier: attributionTier, risk } = attributionTierOf(lane, target.granularity, kind);
  const tier = minTier(evidenceTier, attributionTier);
  const score: AttributionScore = { tier, sharedCwdRisk: risk, lane, evidenceTier, attributionTier };
  if (target.granularity === 'narrower-than-lane') {
    const agentCount = target.sharedAgentCount ?? target.verdict.distinctStreams;
    score.caveat = sharedCwdCaveat(agentCount);
  }
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribution as a confidence-bearing PRODUCT OUTPUT (WP-C / P2).
// ─────────────────────────────────────────────────────────────────────────────

/** The empty four-tier breakdown (all zero). */
export function emptyTierBreakdown(): AttributionTierBreakdown {
  return {
    'agent-attributed': 0,
    'lane-attributed-explicit': 0,
    'lane-inferred-from-current-grant': 0,
    unattributed: 0,
  };
}

/** Lane-coverage confidence band (LANE claims only — see the firewall note above).
 *   > 80%       → 'direct'      (strong lane-specific claim OK)
 *   50–80%      → 'cautioned'   (claim, but flag the gap)
 *   10–<50%     → 'provisional' (diagnostics first; no strong claim)
 *   < 10%       → 'diagnostic'  (≈ the current session-only floor — emit a coverage
 *                                diagnostic instead of any lane-specific claim) */
export function coverageBand(pct: number): AttributionCoverageBand {
  if (pct > 80) return 'direct';
  if (pct >= 50) return 'cautioned';
  if (pct >= 10) return 'provisional';
  return 'diagnostic';
}

export interface AttributionRollup {
  tierBreakdown: AttributionTierBreakdown;
  /** tiers 1–3 — a per-agent OR per-lane signal resolved. */
  attributedCount: number;
  /** tier 4 — honestly unattributed. */
  unattributedCount: number;
  /** attributedCount / total × 100, rounded to one decimal. 0 when total is 0. */
  attributionCoveragePct: number;
  /** Confidence band for `attributionCoveragePct` (a LANE-level figure). */
  laneCoverageBand: AttributionCoverageBand;
}

/** Roll a completed four-tier breakdown up into the confidence-bearing product.
 *  `attributedCount` is tiers 1–3 (everything that is not tier-4 unattributed), so
 *  the unattributed bucket stays first-class and coverage is honest. */
export function rollUpAttribution(tierBreakdown: AttributionTierBreakdown): AttributionRollup {
  const unattributedCount = tierBreakdown.unattributed;
  const attributedCount =
    tierBreakdown['agent-attributed'] +
    tierBreakdown['lane-attributed-explicit'] +
    tierBreakdown['lane-inferred-from-current-grant'];
  const total = attributedCount + unattributedCount;
  const attributionCoveragePct = total > 0 ? Math.round((attributedCount / total) * 1000) / 10 : 0;
  return {
    tierBreakdown,
    attributedCount,
    unattributedCount,
    attributionCoveragePct,
    laneCoverageBand: coverageBand(attributionCoveragePct),
  };
}

/** A one-line honest drill hint keyed off the coverage band. Never claims a
 *  lane-specific story the coverage can't support. */
export function nextDrillHint(rollup: AttributionRollup): string {
  const pct = rollup.attributionCoveragePct;
  switch (rollup.laneCoverageBand) {
    case 'direct':
      return `Lane coverage ${pct}% — filter by lane for a lane-specific breakdown.`;
    case 'cautioned':
      return `Lane coverage ${pct}% — lane breakdown usable but ${rollup.unattributedCount} calls are still unattributed; treat lane totals as a floor.`;
    case 'provisional':
      return `Lane coverage ${pct}% — provisional; ${rollup.unattributedCount} unattributed calls dominate. Read the tierBreakdown before any lane-specific claim.`;
    case 'diagnostic':
    default:
      return `Lane coverage ${pct}% — too low for a lane-specific claim. ${rollup.unattributedCount} of ${pct === 0 ? 'all' : 'the'} calls are unattributed (cwd is many-to-one per agent); this is a coverage diagnostic, not a lane verdict.`;
  }
}

/** True when `tier` is a per-agent claim. The firewall consumer uses this to assert a
 *  per-agent claim is never relabeled with a lane-coverage band. */
export function isPerAgentTier(tier: AttributionTier): boolean {
  return tier === 'agent-attributed';
}
