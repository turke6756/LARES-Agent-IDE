// context-optimizer.ts — the PURE unified proposal engine (design §7–§9; master WP6b).
//
// `generateContextOptimizerProposals(input)` combines the WP0–WP5 signals — resident
// inventory, compiled predicted actions, occurrence verdicts, attribution scores,
// improvisation clusters, config-drift findings, and file-coverage/skill-bypass
// results — into a single RANKED, tier-grouped list of `ContextOptimizerProposal`s
// across the four levers (subtract / add / tune-trigger / relocate-to-progressive-
// disclosure), plus a "Not analyzable" section and a file-heat rollup.
//
// PURE over injected deps (like every WP5 module): the engine never reads the DB,
// the corpus, or a clock. The production wiring (a later WP6 leg) resolves the real
// per-lane inputs and stamps `generatedAtIso`. Everything here is deterministic —
// same inputs in, byte-identical proposal ordering out.
//
// Ranking (§7.3): `tokenTurnsWeight = residentTokens × exposureTurns` WITHIN a hard
// confidence-tier group (`BehaviorEvidenceTier`: observed-safe > observed > inferred
// > heuristic). Tiers NEVER blend — a high-token guess never outranks a low-token
// certainty. Within a tier, epochConfidence and a mutability penalty reorder only;
// they can never cross a tier boundary.

import type {
  AgentRoleLane,
  BehaviorEvidenceTier,
  ContextOptimizerLever,
  ContextOptimizerProposal,
  ContextOptimizerProposalKind,
  ContextOptimizerQuery,
  ContextOptimizerResult,
  ContextOptimizerDiagnostic,
  GrantMismatchVerdict,
  FileHeatRollupEntry,
  FileHeatScopeMeta,
  FileTouchScopeCounts,
  WorkspaceAttributionBreakdown,
  GuidanceOccurrence,
  ProposalActionability,
  ProposalPhraseGap,
  ProposalCostEvidence,
  ResidentAsset,
  ResidentAssetUsage,
  AnalyzabilityDiagnostic,
  AnalyzabilityReasonCode,
  GuidanceSource,
  RecommendationDraft,
} from '../../shared/types';
import { leverFor } from './capstone-map';
import { OPTIMIZER_CONFIG } from './optimizer-config';
import type { PredictedAction } from './guidance-action-model';
import type { BehaviorPredicate } from './behavior-store';
import type { OccurrenceVerdict } from './occurrence-classifier';
import type { AttributionScore } from './attribution';
import { evidenceTierOf } from './attribution';
import type { ImprovisationCandidate } from './improvisation-clusters';
import { isHashOnlyDimension } from './improvisation-clusters';
import type { DriftFinding } from './config-drift';
import type { BypassProposal, BypassResult, FileCoverageResult, FileHeatEntry } from './file-coverage';
import {
  proposalRequiresDerivationGate,
  resolveProposalVerification,
  isSuppressedFromAgentSurface,
  type DerivationVerifiedResult,
} from './compiler-parity-gate';
import { sha256Hex } from './resident-inventory';
import { joinSectionBehavior } from './section-liveness';
import {
  buildRecommendationDraft,
  commandFamilyClaimTemplate,
  hotUncoveredClaimTemplate,
  hotUncoveredSuggestedBullet,
  selectRecommendationTarget,
  targetIsFile,
  RECOMMENDATION_EVIDENCE_SURFACE,
} from './recommendation-draft';

// ─────────────────────────────────────────────────────────────────────────────
// Injected input contract — one bundle per lane. The engine is pure over these;
// the production wiring builds them from the real WP0–WP5 module outputs.
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneResidentSummary {
  residentTokens: number;
  claude: number;
  mcp: number;
  skillHeaders: number;
  exposureTurns: number;
  exposureStreams: number;
  exposureSlugs: number;
}

/** Optional A8 cost evidence, keyed by the same scriptPath the bypass proposal
 *  carries. Absent ⇒ no cost line is fabricated. */
export interface LaneCostEvidence {
  bypassCostByScript?: Record<string, { improvisedTokensPerSession: number;
                                        skillTokensPerInvocation: number;
                                        sessionsSampled?: number }>;
}

export interface LaneOptimizerInput {
  lane: AgentRoleLane;
  resident: LaneResidentSummary;
  /** Compiled predicted actions for the lane's resident config (§5.1). */
  actions: PredictedAction[];
  /** Occurrence verdicts, one per action (matched by `actionId`). */
  verdicts: OccurrenceVerdict[];
  /** Final attribution score per action id (§6). Absent entries fall back to the
   *  verdict's own evidence tier. */
  attributionByActionId?: Record<string, AttributionScore>;
  /** Uncovered improvisation clusters — ADD candidates (§5.3). */
  clusters: ImprovisationCandidate[];
  /** Skill-bypass proposals + watch items (§2.4) → tune-skill-trigger cards. */
  bypass: BypassResult;
  /** Config-drift findings (§5.2) — static-config facts (observed-safe). */
  drift: DriftFinding[];
  /** File-coverage / file-heat rollup (§2.3). */
  coverage?: FileCoverageResult;
  /** WP-4A — workspace-scope counts from the file-touch query feeding `coverage`.
   *  Summed across lanes into `result.meta.fileHeatScope` (honest scope disclosure). */
  coverageScope?: FileTouchScopeCounts;
  /** Per-lane compiler-parity derivation state (§4) — governs `verification`. */
  derivation: DerivationVerifiedResult;
  /** GRANT residency per toolset key (schema token size for the lane). Used for
   *  `subtract-unused-toolset` deltas — the largest single wins (flagship:
   *  orchestration). Falls back to the action's own `residentTokens` when absent. */
  toolsetResidentTokens?: Record<string, number>;
  /** R2 WP-3 (Priority 1): first-class resident assets (skill advertisements + toolset
   *  schemas) and their usage join. `residentAssetUsage` backs the
   *  `subtract-unused-skill-advertisement` proposals; absent ⇒ none emitted. */
  residentAssets?: ResidentAsset[];
  residentAssetUsage?: ResidentAssetUsage[];
  /** Optional A8 cost evidence for tune cards. */
  cost?: LaneCostEvidence;
  /** Optional A9 phrase-gap evidence, keyed by scriptPath (later leg fills it). */
  phraseGapByScript?: Record<string, ProposalPhraseGap>;

  // ── WP-E (P4) grant-mismatch sizing + guardrail seams. All optional; when absent the
  //    grant-mismatch detector degrades HONESTLY to the legacy zero-weight
  //    `subtract-dead-guidance` drift path (nothing fabricated). Sourced where the
  //    optimizer is assembled (TokenEstimator + residentTargets + occurrence verdicts).
  /** Resolve a drift source anchor (`absPath`+`line`) → its containing RESIDENT section
   *  text (spans only, via resident-inventory parsing). Keeps the engine file-text-free
   *  and the tokenizer out of resident-inventory.ts. */
  residentSectionTextAt?: (absPath: string, line: number) => string | null;
  /** Token estimator seam (matches `CompileDeps.estimateTokens` /
   *  `optimizer-assemble`'s `ctx.estimator.estimate(t).tokens`). */
  estimateTokens?: (text: string) => number;
  /** Contradiction guardrail (suppress-only): observed usage of tools in the SAME
   *  capability family as a drift finding's guidance. `>0` calls ⇒ suppress the subtract
   *  and emit a contradiction diagnostic — never delete guidance that is still working. */
  capabilityFamilyUsageFor?: (finding: DriftFinding) => { family: string; calls: number } | null;

  // ── R2 WP-4B (Phase 4) improve-lever consolidation (Step 1). All optional; when absent
  //    a `granted-but-undocumented` finding carries NO behavioral-need signal, so it
  //    demotes to the aggregated config-completeness lane card (never a proposal that
  //    adds resident tokens merely for grant↔doc symmetry).
  /** Behavioral-need signal for a `granted-but-undocumented` finding: is the granted-but-
   *  undocumented toolset actually causing observed friction (repeated discoverability
   *  failures, equivalent shell improvisation, failed/unknown calls, or a measured
   *  navigation cost)? Any one signal crossing its floor (`behavioralNeedTriggers`)
   *  justifies a real `add-missing-guidance` proposal; no signal ⇒ demote. */
  behavioralNeedFor?: (finding: DriftFinding) => BehavioralNeedSignal | null | undefined;

  // ── WP3 (G3) recommendation-draft target policy (both optional; absent ⇒ every
  //    draft target is HONESTLY `{ unresolved, reason }` — never a CLAUDE.md default).
  /** WP2 provider-aware guidance-source inventory for this lane's cohort. */
  guidanceSources?: GuidanceSource[];
  /** Provider identifiers ('claude', 'codex', …) of the OBSERVING cohort behind this
   *  lane's captured rows. Drives the audience→target mapping. */
  observedProviders?: string[];
}

/** R2 WP-4B (Step 1) — the explicit, testable behavioral-need signals behind keeping a
 *  `granted-but-undocumented` finding as a real `add-missing-guidance` proposal (rather
 *  than demoting it to a config-completeness note). Every field is an observed count;
 *  each is compared INDEPENDENTLY against its floor in `behavioralNeedTriggers`. */
export interface BehavioralNeedSignal {
  /** Repeated tool use where the agent could not discover the granted tool. */
  discoverabilityFailures?: number;
  /** Repeated equivalent shell improvisation that the granted tool would replace. */
  shellImprovisations?: number;
  /** Failed / unknown tool calls attributable to the missing documentation. */
  failedOrUnknownCalls?: number;
  /** Measured navigation cost (tokens) an agent burned reaching what the tool grants. */
  navigationCostTokens?: number;
}

/** R2 WP-4B (Step 1) — does any behavioral-need signal cross its floor? PURE + explicit:
 *  each predicate is independent (any one crossing ⇒ triggered), and the crossing reasons
 *  are returned so the ADD proposal can cite WHY it survived demotion. A null/empty signal
 *  never triggers (→ config-completeness demotion). */
export function behavioralNeedTriggers(
  sig: BehavioralNeedSignal | null | undefined,
  cfg: typeof OPTIMIZER_CONFIG = OPTIMIZER_CONFIG,
): { triggered: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!sig) return { triggered: false, reasons };
  if ((sig.discoverabilityFailures ?? 0) >= cfg.BEHAVIORAL_NEED_MIN_DISCOVERABILITY_FAILURES) {
    reasons.push(`${sig.discoverabilityFailures} discoverability failure(s)`);
  }
  if ((sig.shellImprovisations ?? 0) >= cfg.BEHAVIORAL_NEED_MIN_SHELL_IMPROVISATIONS) {
    reasons.push(`${sig.shellImprovisations} equivalent shell improvisation(s)`);
  }
  if ((sig.failedOrUnknownCalls ?? 0) >= cfg.BEHAVIORAL_NEED_MIN_FAILED_OR_UNKNOWN_CALLS) {
    reasons.push(`${sig.failedOrUnknownCalls} failed/unknown tool call(s)`);
  }
  if ((sig.navigationCostTokens ?? 0) >= cfg.BEHAVIORAL_NEED_MIN_NAVIGATION_COST_TOKENS) {
    reasons.push(`~${sig.navigationCostTokens} tokens of measured navigation cost`);
  }
  return { triggered: reasons.length > 0, reasons };
}

/** R2 WP-4B (Step 4) — total behavioral-need magnitude for the benefit model (failure-
 *  rate-reduced ordering key). Sum of the friction counts (navigation cost excluded — it
 *  is a token measure, not an event count). */
function behavioralNeedMagnitude(sig: BehavioralNeedSignal | null | undefined): number {
  if (!sig) return 0;
  return (sig.discoverabilityFailures ?? 0) + (sig.shellImprovisations ?? 0) + (sig.failedOrUnknownCalls ?? 0);
}

export interface ContextOptimizerEngineInput {
  generatedAtIso: string;
  lanes: LaneOptimizerInput[];
  query?: ContextOptimizerQuery;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capstone mapping — ONE source registry (master D4). The proposal logic lives
// here; improvement-engine.ts imports this table and NEVER re-derives the lever /
// safety routing. `safetyRouteFor` applies P4.2 wholesale via the mutability class.
// ─────────────────────────────────────────────────────────────────────────────

// The capstone registry moved to the dependency-free `./capstone-map` so the renderer
// CapstonePanel can import it WITHOUT pulling this engine's node:crypto chain. Re-exported
// here verbatim so every existing consumer + test keeps importing it from this module.
export {
  CAPSTONE_KIND_MAP,
  safetyRouteFor,
  leverFor,
} from './capstone-map';
export type { CapstoneSafetyRoute, CapstoneMapping } from './capstone-map';

// ─────────────────────────────────────────────────────────────────────────────
// Tier ladder + ranking
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: BehaviorEvidenceTier[] = ['observed-safe', 'observed', 'inferred', 'heuristic'];
const tierRank = (t: BehaviorEvidenceTier): number => TIER_ORDER.indexOf(t);

/** min on the ladder = the LESS-confident (worse) of two tiers. */
function minTier(a: BehaviorEvidenceTier, b: BehaviorEvidenceTier): BehaviorEvidenceTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** Kind priority within a lever's tie-break (lower = ranked first). Whole-toolset
 *  subtracts rank above individual-tool subtracts (§7.3). */
const KIND_PRIORITY: Record<ContextOptimizerProposalKind, number> = {
  'subtract-unused-toolset': 0,
  // Grant-mismatch is a verified-by-construction subtract with a positive saving — it
  // ranks just under a whole-toolset cut and above the (behavioral) dead-guidance one.
  'subtract-grant-mismatch': 1,
  // R2 WP-3: an unused skill advertisement is a behavioral subtract like dead-guidance;
  // rank it alongside, just under the schema-grant cuts.
  'subtract-unused-skill-advertisement': 2,
  'subtract-dead-guidance': 3,
  // R2 WP-3 (stretch): a toolset split is a tune with a positive saving — above the
  // other tunes but below the outright subtracts.
  'tune-split-toolset': 4,
  'relocate-to-progressive-disclosure': 5,
  'tune-split-section': 6,
  'add-missing-guidance': 7,
  'add-improvisation-support': 8,
  'tune-skill-trigger': 9,
};

interface RankRow {
  proposal: ContextOptimizerProposal;
  tier: number;
  adjustedWeight: number;   // tokenTurnsWeight × epoch factor (intra-tier only)
  benefitScore: number;     // R2 WP-4B: benefit magnitude (improve levers) — intra-tier only
  mutPenalty: number;
  kindPriority: number;
  recurrence: number;       // execCount / cluster count — intra-tier tie-break for header-only cards
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

/** R2 WP-4C — map a coarse notAnalyzable `label` into a STABLE actionable reason code
 *  + an ADVISORY `suggestedDetector`. The detector name is a HINT for authoring/investment
 *  targeting; it is NOT a detector that emits a verdict — WP-4C adds no classification-
 *  changing detector, so no parity fixture / false-positive budget is owed (spec Risk:
 *  heuristics inform authoring, never actionable subtraction). Codes are STABLE; extend by
 *  addition only. `exposure-low` / `capture-incomplete` carry NO detector (one needs more
 *  exposure, the other is a fail-closed audit withhold — neither is a missing detector). */
function analyzabilityReasonFor(
  label: string,
): { code: AnalyzabilityReasonCode; suggestedDetector?: string } {
  switch (label) {
    case 'coarse-server-grant':   return { code: 'matcher-ambiguous', suggestedDetector: 'named-tool-resolver' };
    case 'sequence-deferred':     return { code: 'sequence-deferred', suggestedDetector: 'workflow-sequence-detector' };
    case 'branch-deferred':       return { code: 'branch-deferred', suggestedDetector: 'policy-constraint-detector' };
    case 'unresolved-path':       return { code: 'capture-missing', suggestedDetector: 'relative-path-resolver' };
    case 'capture-incomplete':    return { code: 'capture-missing' };
    case 'insufficient-exposure': return { code: 'exposure-low' };
    // 'unmatchable', the bare 'unobservable' fallback, and any unknown label → pure prose
    // (the derivability==='unmatchable' default from unobservableReasonFor).
    default:                      return { code: 'pure-prose', suggestedDetector: 'imperative-prose-detector' };
  }
}

/** R2 WP-4C — transient per-section accumulator for the deduped-by-section+laneSet
 *  analyzability diagnostic (materialized into `AnalyzabilityDiagnostic` after the loop). */
interface SectionAnalyzabilityAgg {
  sectionKey: string;
  absPath: string;
  line: number;
  lanes: Set<AgentRoleLane>;
  residentTokens: number;
  exposureTurns: number;
  seenActionIds: Set<string>;
  reasonByCode: Map<AnalyzabilityReasonCode, { count: number; suggestedDetector?: string }>;
}

/** WP-4A — an all-zero workspace-tier breakdown (parity with the MCP-usage helper). */
function emptyWorkspaceBreakdown(): WorkspaceAttributionBreakdown {
  return {
    'workspace-explicit': 0,
    'workspace-from-launch-session': 0,
    'workspace-from-root': 0,
    'workspace-slug-proxy': 0,
    'workspace-unattributed': 0,
  };
}

export function generateContextOptimizerProposals(
  input: ContextOptimizerEngineInput,
): ContextOptimizerResult {
  const cfg = OPTIMIZER_CONFIG;
  const rows: RankRow[] = [];
  const fileHeat: FileHeatRollupEntry[] = [];
  const notAnalyzable: ContextOptimizerResult['modelStats']['notAnalyzable'] = [];
  const notAnalyzableSeen = new Set<string>();
  // R2 WP-4C — section-level analyzability aggregation, deduped by section identity +
  // LANE SET (the fix for the notAnalyzable dedupe bug: a cross-lane section is counted
  // ONCE carrying BOTH lanes, never mislabeled to the first lane seen).
  const analyzabilityBySection = new Map<string, SectionAnalyzabilityAgg>();
  const residentTokensByLane: ContextOptimizerResult['modelStats']['residentTokensByLane'] = [];
  // WP-E (P4): suppress-only guardrail + sample-gate diagnostics (a subtract the engine
  // chose NOT to surface as actionable, with the reason). Never a proposal.
  const diagnostics: ContextOptimizerDiagnostic[] = [];
  let behaviorEvents = 0;
  // WP-4A — accumulate the per-lane workspace-scope counts into one run-level disclosure.
  const scopeAcc: FileTouchScopeCounts = {
    droppedUnattributed: 0, proxyIncluded: 0, breakdown: emptyWorkspaceBreakdown(), realIdCount: 0,
  };
  let sawCoverageScope = false;
  // ── WP3 (G3): ONE analysis-generation id for every recommendation-draft evidence
  // entry in this result — the join key that makes evidence rows same-surface
  // joinable. Deterministic over the engine input (purity preserved: derived from
  // the injected clock stamp, never a wall clock read here). ──
  const draftGenerationId = sha256Hex(`recommendation-drafts:${input.generatedAtIso}`);

  for (const lane of input.lanes) {
    const verdictById = new Map<string, OccurrenceVerdict>();
    for (const v of lane.verdicts) verdictById.set(v.actionId, v);
    for (const v of lane.verdicts) behaviorEvents += v.occurrences;

    residentTokensByLane.push({
      lane: lane.lane,
      total: lane.resident.residentTokens,
      claude: lane.resident.claude,
      mcp: lane.resident.mcp,
      skillHeaders: lane.resident.skillHeaders,
      exposureTurns: lane.resident.exposureTurns,
    });

    // Partition: toolset/tool-grant actions → the dedicated toolset lever; everything
    // else groups into markdown sections for the dead-guidance / split / relocate levers.
    const toolsetActions: PredictedAction[] = [];
    const sectionActions: PredictedAction[] = [];
    for (const a of lane.actions) {
      if (a.kind === 'toolset-usage' || a.kind === 'tool-invocation') toolsetActions.push(a);
      else sectionActions.push(a);
    }

    // ── Not analyzable (§9): unobservable / insufficient-exposure / capture-incomplete. ──
    // WP-1A: a provisional-`never` that failed a fail-closed audit gate is
    // `capture-incomplete` — it is NEVER a subtract (the toolset/section builders only
    // act on `never`), so it buckets here with its own label + an auditable diagnostic.
    for (const a of lane.actions) {
      const v = verdictById.get(a.id);
      if (!v) continue;
      if (v.status === 'unobservable' || v.status === 'insufficient-exposure' || v.status === 'capture-incomplete') {
        const label = v.status === 'unobservable'
          ? (v.unobservableReason ?? 'unobservable')
          : v.status === 'capture-incomplete'
            ? 'capture-incomplete'
            : 'insufficient-exposure';
        // ── R2 WP-4C: section+laneSet aggregation (the dedupe-bug fix). Runs for EVERY
        // qualifying action, independent of the legacy per-row dedupe below — a section
        // shared across lanes accumulates BOTH lanes and its distinct action count. ──
        const sectionKey = a.sourceSectionKey || `${a.source.absPath}:${a.source.line}`;
        let agg = analyzabilityBySection.get(sectionKey);
        if (!agg) {
          agg = {
            sectionKey, absPath: a.source.absPath, line: a.source.line,
            lanes: new Set<AgentRoleLane>(), residentTokens: a.residentTokens, exposureTurns: 0,
            seenActionIds: new Set<string>(), reasonByCode: new Map(),
          };
          analyzabilityBySection.set(sectionKey, agg);
        }
        agg.lanes.add(lane.lane);
        agg.residentTokens = Math.max(agg.residentTokens, a.residentTokens);
        agg.exposureTurns = Math.max(agg.exposureTurns, lane.resident.exposureTurns);
        // Count each distinct action ONCE even when it recurs across lanes (a shared
        // action carries the same id) — but still union its lanes above.
        if (!agg.seenActionIds.has(a.id)) {
          agg.seenActionIds.add(a.id);
          const { code, suggestedDetector } = analyzabilityReasonFor(label);
          const r = agg.reasonByCode.get(code);
          if (r) r.count += 1;
          else agg.reasonByCode.set(code, { count: 1, suggestedDetector });
        }

        const key = `${a.source.absPath}:${a.source.line}:${label}`;
        if (!notAnalyzableSeen.has(key)) {
          notAnalyzableSeen.add(key);
          notAnalyzable.push({ absPath: a.source.absPath, line: a.source.line, label, lane: lane.lane });
          if (v.status === 'capture-incomplete') {
            const ev = v.evidence;
            const rate = ev ? ev.captureCoverage.unresolvedPathEvents / Math.max(1, ev.denominator.turns) : 0;
            const canonical = matcherCanonicalOf(v.predicate);
            diagnostics.push({
              kind: 'capture-incomplete',
              lane: lane.lane,
              detail: `Provisional-'never' at ${a.source.absPath}:${a.source.line} withheld — a fail-closed audit gate failed (matcher canonical=${canonical}, unresolved-path rate=${rate.toFixed(3)}). Downgraded to capture-incomplete rather than asserted as a subtract.`,
              unresolvedPathRate: rate,
              matcherCanonical: canonical,
            });
          }
        }
      }
    }

    buildToolsetProposals(lane, verdictById, rows, diagnostics);
    // R2 WP-3 step 4: unused skill-ADVERTISEMENT subtracts, from the resident-asset
    // usage join (candidate-unverified by construction — advertisement epochs are not
    // derivable). Reads lane.residentAssetUsage; a no-op when absent.
    buildSkillAdvertisementProposals(lane, rows, diagnostics);
    buildSectionProposals(lane, verdictById, rows, diagnostics);
    buildDriftProposals(lane, rows, diagnostics);
    buildClusterProposals(lane, rows, draftGenerationId);
    buildBypassProposals(lane, rows);
    // WP3 (G3): hot uncovered allowlisted files → ADD proposals carrying a
    // template-constrained recommendationDraft with joinable same-surface evidence.
    buildHotUncoveredProposals(lane, rows, draftGenerationId);

    // ── File-heat rollup passthrough (A1, §5.6-redacted). ──
    if (lane.coverage) {
      const uncovered = new Set(lane.coverage.uncoveredHot.map((h) => h.pathHash));
      for (const h of lane.coverage.fileHeat) {
        fileHeat.push({
          lane: lane.lane,
          pathDisplay: h.pathDisplay,
          pathHash: h.pathHash,
          coverage: h.coverage,
          reads: h.reads,
          writes: h.writes,
          executes: h.executes,
          distinctStreams: h.distinctStreams,
          matchConfidence: h.matchConfidence,
          uncovered: uncovered.has(h.pathHash),
          // ── WP-4A (Phase 4): role/score/gap projections (additive, honest-degrade). ──
          ...(h.role ? { role: h.role } : {}),
          ...(h.roleReason ? { roleReason: h.roleReason } : {}),
          ...(h.operationalNoise !== undefined ? { operationalNoise: h.operationalNoise } : {}),
          ...(h.score !== undefined ? { score: h.score } : {}),
          ...(h.scoreComponents ? { scoreComponents: h.scoreComponents } : {}),
          ...(h.guidanceGapCandidate !== undefined ? { guidanceGapCandidate: h.guidanceGapCandidate } : {}),
          // ── WP3 (G3): hot-uncovered candidate flag + BOUNDED coverage-check
          //    disclosure (truncation metadata included, never the full list). ──
          ...(h.hotUncoveredCandidate !== undefined ? { hotUncoveredCandidate: h.hotUncoveredCandidate } : {}),
          ...(h.coverageChecks ? { coverageChecks: h.coverageChecks } : {}),
        });
      }
    }

    // ── WP-4A: fold this lane's workspace-scope counts into the run-level disclosure. ──
    if (lane.coverageScope) {
      sawCoverageScope = true;
      scopeAcc.droppedUnattributed += lane.coverageScope.droppedUnattributed;
      scopeAcc.proxyIncluded += lane.coverageScope.proxyIncluded;
      scopeAcc.realIdCount += lane.coverageScope.realIdCount;
      for (const k of Object.keys(scopeAcc.breakdown) as (keyof WorkspaceAttributionBreakdown)[]) {
        scopeAcc.breakdown[k] += lane.coverageScope.breakdown[k] ?? 0;
      }
    }
  }

  // ── Rank: hard tier groups, then tokenTurnsWeight (epoch-adjusted) within tier. ──
  rows.sort(compareRows);
  // Belt (BUG-43): stable de-dup by id so no future emitter can reintroduce a duplicate
  // id at a page boundary — the cursor tie-break sort key is `id`. First occurrence wins
  // (rows are already ranked, so the retained row is the highest-ranked for that id).
  const seenIds = new Set<string>();
  const proposals = rows
    .map((r) => r.proposal)
    .filter((p) => (seenIds.has(p.id) ? false : (seenIds.add(p.id), true)));

  const attributionWarnings = proposals.filter((p) => p.attribution.sharedCwdRisk !== 'none').length;
  const unverifiedSuppressedCount = proposals.filter((p) => p.suppressedFromAgentSurface).length;

  // ── WP-4A: run-level workspace-scope disclosure (spec risk 3 — never silence). ──
  // Emitted only when at least one lane carried scope counts (a scoped file-touch query
  // ran); a pre-Phase-4 / lane-global run omits it (honest absence).
  const scopeMode = input.query?.scopeMode ?? 'strict';
  const workspaceScoped = !!input.query?.workspaceId && scopeMode !== 'global-diagnostic';
  const fileHeatScope: FileHeatScopeMeta | undefined = sawCoverageScope
    ? {
        workspaceScoped,
        appliedScopeMode: scopeMode,
        workspaceKeyIsSlugProxy: scopeAcc.realIdCount === 0,
        droppedUnattributedTouches: scopeAcc.droppedUnattributed,
        proxyIncludedTouches: scopeAcc.proxyIncluded,
        workspaceAttribution: scopeAcc.breakdown,
      }
    : undefined;

  // ── R2 WP-4C: materialize the section-level analyzability diagnostic (deduped by
  // section + lane SET). Emitted only when non-empty (honest absence otherwise). ──
  const analyzability: AnalyzabilityDiagnostic[] = [...analyzabilityBySection.values()].map((agg) => ({
    sectionKey: agg.sectionKey,
    source: { absPath: agg.absPath, lineStart: agg.line, lineEnd: agg.line },
    lanes: [...agg.lanes],
    residentTokens: agg.residentTokens,
    exposureTurns: agg.exposureTurns,
    actionCount: agg.seenActionIds.size,
    reasons: [...agg.reasonByCode.entries()].map(([code, v]) => ({
      code, count: v.count,
      ...(v.suggestedDetector ? { suggestedDetector: v.suggestedDetector } : {}),
    })),
  }));

  // ── WP5 (G5): occurrence verdicts joined per section identity — the input to
  // the config-weight behavior-axis annotation. Per-lane pairing (the same
  // action id recurs across lanes with different verdicts); pure + deterministic.
  const sectionBehavior = joinSectionBehavior(input.lanes);

  return {
    generatedAtIso: input.generatedAtIso,
    proposals,
    fileHeat,
    ...(sectionBehavior.length > 0 ? { sectionBehavior } : {}),
    modelStats: {
      residentTokensByLane, behaviorEvents, attributionWarnings, notAnalyzable,
      ...(analyzability.length ? { analyzability } : {}),
    },
    meta: {
      tierGroups: TIER_ORDER,
      unverifiedSuppressedCount,
      ...(fileHeatScope ? { fileHeatScope } : {}),
      // WP3 (G3): the join key for recommendation-draft evidence — present only when
      // ≥1 proposal actually carries a draft (honest absence otherwise).
      ...(proposals.some((p) => p.recommendationDraft)
        ? { recommendationGenerationId: draftGenerationId } : {}),
    },
    diagnostics,
  };
}

/** Total, deterministic ordering: tier (hard group) → epoch-adjusted weight desc →
 *  benefit magnitude desc (improve levers, WP-4B) → mutability penalty asc → kind
 *  priority asc → recurrence desc → id. */
function compareRows(a: RankRow, b: RankRow): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.adjustedWeight !== b.adjustedWeight) return b.adjustedWeight - a.adjustedWeight;
  // R2 WP-4B (Step 4): benefit magnitude WITHIN a tier — never blended across tiers (tier
  // is the hard first key above). Only nonzero for improve-lever proposals; subtracts
  // (benefitScore 0) are already ordered by adjustedWeight, so this never reorders them.
  if (a.benefitScore !== b.benefitScore) return b.benefitScore - a.benefitScore;
  if (a.mutPenalty !== b.mutPenalty) return a.mutPenalty - b.mutPenalty;
  if (a.kindPriority !== b.kindPriority) return a.kindPriority - b.kindPriority;
  if (a.recurrence !== b.recurrence) return b.recurrence - a.recurrence;
  return a.proposal.id < b.proposal.id ? -1 : a.proposal.id > b.proposal.id ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row construction — one place stamps verification/actionability/rank fields.
// ─────────────────────────────────────────────────────────────────────────────

/** WP7 — a human-facing `proposedEdit.summary` for every proposal kind. The engine is
 *  pure + file-text-free, so a byte-accurate unified-diff `patch` is NOT derivable
 *  here; per the honesty guard we omit the patch rather than fabricate one (the panel
 *  renders the summary + an "Open in CLAUDE.md" jump to the exact span for the human to
 *  apply). "Mark applied" stays intent-only and never edits a file. */
function proposedEditFor(kind: ContextOptimizerProposalKind): { summary: string } {
  switch (kind) {
    case 'subtract-dead-guidance':
      return { summary: 'Remove the dead guidance line range from the CLAUDE.md section after human review.' };
    case 'subtract-unused-toolset':
      return { summary: 'Remove or narrow the stale MCP grant after human review.' };
    case 'subtract-grant-mismatch':
      return { summary: 'Remove the resident guidance section for a tool the lane no longer holds (grant-mismatch) after human review — reclaims its full resident cost.' };
    case 'subtract-unused-skill-advertisement':
      return { summary: "Remove this skill from this lane's advertised discovery surface (or shorten its description) after human review — never delete a globally useful skill." };
    case 'tune-split-toolset':
      return { summary: 'Split the toolset grant along a workflow boundary so the lane keeps the used members and drops the unused schema — after human review.' };
    case 'add-missing-guidance':
      return { summary: 'Add one concise CLAUDE.md line documenting the granted toolset under an existing tool-guidance section.' };
    case 'relocate-to-progressive-disclosure':
      return { summary: 'Move the section body into a skill (loads on invoke), leaving a short resident header — net token win.' };
    case 'tune-split-section':
      return { summary: 'Split the section so the load-bearing part stays resident and the dead remainder can be trimmed.' };
    case 'add-improvisation-support':
      return { summary: 'Add a lane CLAUDE.md line or a collapsing tool covering the repeated improvisation.' };
    case 'tune-skill-trigger':
      return { summary: 'Clarify the skill trigger/description so agents stop improvising past it (do NOT trim the body).' };
    default:
      return { summary: 'Review this change and apply it manually.' };
  }
}

function pushRow(
  lane: LaneOptimizerInput,
  rows: RankRow[],
  proposal: ContextOptimizerProposal,
  recurrence: number,
): void {
  // Guarantee a human-facing edit summary on every proposal (WP7). Idempotent: a
  // builder that already set a richer proposedEdit keeps it.
  if (!proposal.proposedEdit) proposal.proposedEdit = proposedEditFor(proposal.kind);
  const factor = proposal.epochConfidence === 'low' ? OPTIMIZER_CONFIG.EPOCH_LOW_CONFIDENCE_WEIGHT_FACTOR : 1;
  const mutPenalty = OPTIMIZER_CONFIG.MUTABILITY_RANK_PENALTY[proposal.target.mutable];
  rows.push({
    proposal,
    tier: tierRank(proposal.confidence),
    adjustedWeight: proposal.tokenTurnsWeight * factor,
    // R2 WP-4B (Step 4): benefit magnitude orders improve-lever proposals WITHIN a tier.
    // Subtracts carry no benefitModel ⇒ 0 ⇒ their order is unchanged (they differ on
    // adjustedWeight; equal-weight subtracts still fall through to mutPenalty).
    benefitScore: proposal.benefitModel?.magnitude ?? 0,
    mutPenalty,
    kindPriority: KIND_PRIORITY[proposal.kind],
    recurrence,
  });
}

/** Resolve the `verification` + `actionability` + gate fields for a proposal. */
function verificationFields(
  requiresGate: boolean,
  derivation: DerivationVerifiedResult,
): Pick<ContextOptimizerProposal, 'verification' | 'derivationVerified' | 'actionability' | 'suppressedFromAgentSurface'> {
  const verification = resolveProposalVerification(requiresGate, derivation);
  const suppressed = isSuppressedFromAgentSurface(requiresGate, verification.verified);
  // A gate-governed proposal not yet derivation-verified is a §4.6 candidate (shown,
  // badged), never silently dropped from the panel. Gate-exempt proposals are actionable.
  const actionability: ProposalActionability =
    requiresGate && !verification.verified ? 'candidate-unverified' : 'actionable';
  return {
    verification,
    derivationVerified: verification.verified,
    actionability,
    suppressedFromAgentSurface: suppressed,
  };
}

// ── WP-1A (Priority 0) evidence helpers ──
/** The capped DENOMINATOR (exposure) sample stream ids from a `never` verdict's
 *  evidence — proof the guidance WAS exposed. These are exposure streams, NOT matching
 *  streams (a true `never` has zero matches). `[]` when no evidence is attached. */
function denomSampleStreamIds(ev: OccurrenceVerdict['evidence']): string[] {
  return (ev?.denominator.sampledStreams ?? [])
    .map((s) => s.streamId)
    .slice(0, OPTIMIZER_CONFIG.EVIDENCE_SAMPLE_STREAMS_CAP);
}

/** Display-only: was the predicate that ran exact/canonical (not a legacy glob)? Used
 *  in the `capture-incomplete` diagnostic. NOT the gate itself (the classifier owns
 *  that, folding in `derivability`); this reports the matcher's own canonicality. */
function matcherCanonicalOf(pred: BehaviorPredicate | null): boolean {
  if (!pred) return false;
  if (pred.kind === 'file-access') return !!(pred.path.canonicalAbs || pred.path.workspaceRelative != null);
  return pred.kind !== 'path-touch';
}

function attributionBlock(
  lane: AgentRoleLane,
  score: AttributionScore | undefined,
  streamIds: string[],
  slug?: string,
): ContextOptimizerProposal['attribution'] {
  return {
    lane: score && score.lane !== 'unknown' ? (score.lane as AgentRoleLane) : lane,
    slug,
    streamIds,
    sharedCwdRisk: score?.sharedCwdRisk ?? 'none',
    caveat: score?.caveat,
  };
}

// ── SUBTRACT / individual-tool: toolset-usage & tool-invocation `never`. ──
function buildToolsetProposals(
  lane: LaneOptimizerInput,
  verdictById: Map<string, OccurrenceVerdict>,
  rows: RankRow[],
  diagnostics: ContextOptimizerDiagnostic[],
): void {
  for (const a of lane.actions) {
    if (a.kind !== 'toolset-usage' && a.kind !== 'tool-invocation') continue;
    // WP-2A: a `fromProse` tool-invocation is a DOCUMENTED mention (resolved to a
    // toolset by config-drift), not a grant. It must NEVER become a subtract — a
    // `never` verdict on a documented mention would false-subtract a real grant that
    // the prose merely names. Config-drift owns its drift semantics.
    if (a.params.fromProse === '1') continue;
    const v = verdictById.get(a.id);
    if (!v || v.status !== 'never') continue; // only cleanly-dead grants (never encodes adequate exposure)

    const score = lane.attributionByActionId?.[a.id];
    const tier = score?.tier ?? evidenceTierOf(v);
    const toolset = a.params.toolset ?? a.params.server;
    const toolName = a.params.toolName;
    const isWholeToolset = a.kind === 'toolset-usage';
    const delta = isWholeToolset && toolset
      ? (lane.toolsetResidentTokens?.[toolset] ?? a.residentTokens)
      : a.residentTokens;
    const weight = delta * v.exposureTurns;
    const kind: ContextOptimizerProposalKind = 'subtract-unused-toolset';
    const requiresGate = proposalRequiresDerivationGate([a]);
    // WP-1A: the SAME-GENERATION non-occurrence audit for this `never` verdict.
    const ev = v.evidence;

    const proposal: ContextOptimizerProposal = {
      id: `subtract-toolset:${lane.lane}:${toolset ?? toolName ?? a.id}`,
      kind,
      lever: leverFor(kind),
      title: isWholeToolset
        ? `Remove unused toolset grant '${toolset}' from ${lane.lane}`
        : `Remove unused tool '${toolName}' from ${lane.lane}`,
      rationale: `${lane.lane} grants ${isWholeToolset ? `the '${toolset}' toolset` : `tool '${toolName}'`} but no member invocation was observed across ${v.exposureTurns} exposure turns / ${v.exposureStreams} streams. Removing it reclaims ${delta} resident tokens every turn.`,
      target: {
        mcpToolset: toolset,
        mcpToolName: toolName,
        lane: lane.lane,
        mutable: 'scaffold-managed', // toolset grants live in mcp-config-builder (source constant)
      },
      residentTokenDelta: { estimate: delta, basis: 'remove-resident' },
      tokenTurnsWeight: weight,
      occurrence: 'never',
      confidence: tier,
      epochConfidence: v.epochConfidence,
      // streamIds are the DENOMINATOR (exposure) samples — proof the grant WAS exposed,
      // never invoked. Numerator is 0 for a `never`, so there are no matching streams.
      attribution: attributionBlock(lane.lane, score, denomSampleStreamIds(ev)),
      exposure: { turns: v.exposureTurns, streams: v.exposureStreams, slugs: v.exposureSlugs },
      // `citations` prove residency (where the grant lives); `behaviorEvidence` is the
      // separate non-occurrence audit trail (see shared/types.ts split note).
      citations: [{ source: 'staticOverheadModel', absPath: a.source.absPath, line: a.source.line }],
      costEvidence: { residentTokensTimesExposure: weight },
      laneInsight: 'unused-toolset-grant',
      // V1 (main-side, `BehaviorPredicate` union) → DTO (predicate loosened so shared/
      // stays dependency-free); structurally identical apart from the predicate's
      // index-signature nominal gap, hence the boundary cast.
      behaviorEvidence: ev as ContextOptimizerProposal['behaviorEvidence'],
      evidenceState: v.evidenceState,
      ...verificationFields(requiresGate, lane.derivation),
    };
    if (ev) proposal.evidenceRef = proposal.id;
    if (sampleGateBlocks(lane, proposal, diagnostics)) continue;
    pushRow(lane, rows, proposal, v.occurrences);
  }
}

// ── SUBTRACT: unused skill ADVERTISEMENT (R2 WP-3 / Priority 1). ──
//
// A resident-asset-derived subtract, sized by the skill HEADER cost the join measured
// (NOT the occurrence engine — advertisement invocation isn't a compiled predicted
// action). Candidate-unverified BY CONSTRUCTION: advertisement epochs aren't cheaply
// derivable, so exposure is a conservative full-lane approximation, `epochConfidence`
// is `low`, and the gate is required (`requiresGate:true`) → the row lands
// `candidate-unverified` / suppressed-from-agent-surface (never auto-actionable).
//
// Scope discipline (spec risk): the action removes the skill from THIS lane's advertised
// discovery surface (or shortens its description) — NEVER "delete the skill" ("never used
// HERE" ≠ "globally useless"). Below the coverage floor the row is WITHHELD with a
// `coverage-insufficient` diagnostic: absent invocations are as likely capture/provider-
// specific as genuine disuse, so we disclose rather than fabricate a subtract.
function buildSkillAdvertisementProposals(
  lane: LaneOptimizerInput,
  rows: RankRow[],
  diagnostics: ContextOptimizerDiagnostic[],
): void {
  if (!lane.residentAssetUsage) return;
  for (const u of lane.residentAssetUsage) {
    if (u.asset.kind !== 'skill-advertisement') continue;
    // Used ⇒ not a subtract candidate.
    if (u.observedUses > 0) continue;
    // A trivially-small header's reclaim is noise vs. the human review cost.
    if (u.asset.headerTokens < OPTIMIZER_CONFIG.SKILL_ADVERTISEMENT_MIN_HEADER_TOKENS) continue;

    const { skillName, sourcePath } = u.asset;
    const id = `subtract-skill-adv:${lane.lane}:${skillName}`;

    // Coverage floor: a lane that essentially never surfaces skill usage cannot support
    // "skill X is dead" — WITHHOLD + disclose, never fabricate the subtract.
    if (u.usageCoveragePct < OPTIMIZER_CONFIG.SKILL_ADVERTISEMENT_MIN_COVERAGE_PCT) {
      diagnostics.push({
        kind: 'coverage-insufficient',
        lane: lane.lane,
        detail: `Skill-advertisement subtract '${id}' withheld: lane skill-capture coverage ${u.usageCoveragePct}% (< ${OPTIMIZER_CONFIG.SKILL_ADVERTISEMENT_MIN_COVERAGE_PCT}%) — the absence of '${skillName}' invocations is as likely capture/provider-specific as genuine disuse.`,
        relatedProposalId: id,
        evidence: 'insufficient-sample',
      });
      continue;
    }

    const kind: ContextOptimizerProposalKind = 'subtract-unused-skill-advertisement';
    const weight = u.asset.headerTokens * u.eligibleExposureTurns;
    const proposal: ContextOptimizerProposal = {
      id,
      kind,
      lever: leverFor(kind),
      title: `Remove unused skill advertisement '${skillName}' from ${lane.lane}`,
      rationale: `${lane.lane} advertises skill '${skillName}' (a resident ${u.asset.headerTokens}-token header) but no invocation was observed across ~${u.eligibleExposureTurns} exposure turns. Remove this skill from this lane's advertised discovery surface (or shorten its description) to reclaim the header cost — never delete the skill (never used HERE ≠ globally useless).`,
      target: { skillName, lane: lane.lane, absPath: sourcePath, mutable: 'user-owned' },
      residentTokenDelta: { estimate: u.asset.headerTokens, basis: 'header-only' },
      tokenTurnsWeight: weight,
      occurrence: 'never',
      confidence: 'inferred',
      // Advertisement epochs aren't derivable ⇒ down-rank within tier + surface unverified.
      epochConfidence: 'low',
      // No per-stream numerator (this is not an occurrence verdict) — attribution carries
      // the lane only, with no matching-stream ids.
      attribution: attributionBlock(lane.lane, undefined, []),
      exposure: { turns: u.eligibleExposureTurns, streams: 0, slugs: 0 },
      citations: [{ source: 'staticOverheadModel', absPath: sourcePath }],
      costEvidence: {
        residentTokensTimesExposure: weight,
        note: 'approximate exposure — advertisement epoch not derivable',
      },
      assetEvidence: {
        usageCoveragePct: u.usageCoveragePct,
        lastUsedAt: u.lastUsedAt,
        zeroUseWindow: u.zeroUseWindow,
        exposureApproximate: u.exposureApproximate,
        scopeMeta: u.scopeMeta,
      },
      laneInsight: 'unused-skill-advertisement',
      // No fail-closed OccurrenceEvidence trail (not an occurrence verdict).
      evidenceState: 'unavailable',
      ...verificationFields(true, lane.derivation),
    };
    pushRow(lane, rows, proposal, u.observedUses);
  }
}

// ── SUBTRACT dead-guidance / TUNE split / RELOCATE: markdown-section grouping. ──
interface SectionGroup {
  sectionKey: string;
  members: PredictedAction[];
}

function buildSectionProposals(
  lane: LaneOptimizerInput,
  verdictById: Map<string, OccurrenceVerdict>,
  rows: RankRow[],
  diagnostics: ContextOptimizerDiagnostic[],
): void {
  const groups = new Map<string, SectionGroup>();
  for (const a of lane.actions) {
    if (a.kind === 'toolset-usage' || a.kind === 'tool-invocation') continue; // handled by toolset lever
    if (!a.sourceSectionKey) continue;
    let g = groups.get(a.sourceSectionKey);
    if (!g) { g = { sectionKey: a.sourceSectionKey, members: [] }; groups.set(a.sourceSectionKey, g); }
    g.members.push(a);
  }

  // Deterministic iteration order.
  const sorted = [...groups.values()].sort((x, y) => (x.sectionKey < y.sectionKey ? -1 : 1));
  for (const g of sorted) {
    const exact = g.members.filter((m) => m.derivability === 'exact');
    if (exact.length === 0) continue; // nothing observable → its members already in notAnalyzable

    const verdicts = exact.map((m) => verdictById.get(m.id)).filter((v): v is OccurrenceVerdict => !!v);
    if (verdicts.length !== exact.length) continue; // missing verdict — cannot judge cleanly

    if (verdicts.some((v) => v.status === 'insufficient-exposure')) continue; // not adequate exposure
    const anyUnobservable = g.members.some((m) => verdictById.get(m.id)?.status === 'unobservable');
    const neverCount = verdicts.filter((v) => v.status === 'never').length;
    const occursCount = verdicts.filter((v) => v.status === 'occurs').length;

    // Representative action/verdict: the smallest-confidence member (drives the tier),
    // exposure from the max-exposure member (the section's best-measured denominator).
    const rep = exact.reduce((best, m) => {
      const bv = verdictById.get(best.id)!; const mv = verdictById.get(m.id)!;
      return mv.exposureTurns > bv.exposureTurns ? m : best;
    }, exact[0]);
    const repVerdict = verdictById.get(rep.id)!;
    const repTokens = Math.max(...exact.map((m) => m.residentTokens));
    const epochConfidence: ContextOptimizerProposal['epochConfidence'] =
      verdicts.some((v) => v.epochConfidence === 'low') ? 'low'
        : verdicts.every((v) => v.epochConfidence === 'high') ? 'high' : 'unknown';

    // Tier = min over member final tiers (least confident wins).
    let tier: BehaviorEvidenceTier = 'observed-safe';
    for (const m of exact) {
      const score = lane.attributionByActionId?.[m.id];
      const t = score?.tier ?? evidenceTierOf(verdictById.get(m.id)!);
      tier = minTier(tier, t);
    }
    const repScore = lane.attributionByActionId?.[rep.id];
    const weight = repTokens * repVerdict.exposureTurns;
    const requiresGate = proposalRequiresDerivationGate(exact);
    const exposure = { turns: repVerdict.exposureTurns, streams: repVerdict.exposureStreams, slugs: repVerdict.exposureSlugs };
    const citations = exact.slice(0, 8).map((m) => ({
      source: 'staticOverheadModel' as const, absPath: m.source.absPath, line: m.source.line,
    }));

    let kind: ContextOptimizerProposalKind;
    let occurrence: GuidanceOccurrence;
    let basis: ContextOptimizerProposal['residentTokenDelta']['basis'];
    let estimate: number;
    let title: string;
    let rationale: string;

    if (neverCount === exact.length && !anyUnobservable) {
      // Clean dead-guidance: ALL exact actions `never`, none unobservable.
      kind = 'subtract-dead-guidance';
      occurrence = 'never';
      basis = 'remove-resident';
      estimate = repTokens;
      title = `Remove dead guidance section in ${lane.lane}`;
      rationale = `Every derivable action in this section classified 'never' across ${repVerdict.exposureTurns} exposure turns — the guidance shaped no observed behavior. Removing it reclaims ~${repTokens} resident tokens.`;
    } else if (occursCount >= 1 && repTokens >= OPTIMIZER_CONFIG.RELOCATE_MIN_SECTION_TOKENS && neverCount >= 1) {
      // Long, occasionally-useful section → relocate to a skill body (loads on demand).
      kind = 'relocate-to-progressive-disclosure';
      occurrence = 'occurs';
      basis = 'relocate-to-disclosure';
      estimate = repTokens; // net win = estimate(section) − estimate(new-header); header size unknown → full, noted
      tier = minTier(tier, 'inferred');
      title = `Relocate an occasionally-used section in ${lane.lane} to progressive disclosure`;
      rationale = `This ${repTokens}-token section is used only occasionally (${occursCount}/${exact.length} derivable actions observed). Moving the body into a skill (loads on invoke) leaves a short resident header — net token win, minus the retained header.`;
    } else if (occursCount >= 1 && neverCount >= 1) {
      // Mixed case: one small observable part pays rent, the rest is dead → split.
      kind = 'tune-split-section';
      occurrence = 'occurs';
      basis = 'remove-resident';
      estimate = repTokens;
      tier = minTier(tier, 'inferred');
      title = `Split a mixed-use section in ${lane.lane}`;
      rationale = `${occursCount}/${exact.length} derivable actions in this section were observed; the remaining ${neverCount} classified 'never'. Splitting lets the dead remainder be trimmed while the load-bearing part stays.`;
    } else {
      continue; // no clean lever
    }

    // WP-1A: only the pure-`never` dead-guidance lever carries behavior evidence.
    // relocate/split are `occurs`-driven mixed sections → honest `unavailable`. Use the
    // representative verdict's evidence; the `neverCount === exact.length` guard above
    // means a dead-guidance section is pure-`never`, so the rep verdict is representative.
    const isDeadGuidance = kind === 'subtract-dead-guidance';
    const sectionEv = isDeadGuidance ? repVerdict.evidence : undefined;
    const streamIds = isDeadGuidance ? denomSampleStreamIds(repVerdict.evidence) : [];

    const proposal: ContextOptimizerProposal = {
      id: `${kind}:${lane.lane}:${g.sectionKey}`,
      kind,
      lever: leverFor(kind),
      title,
      rationale,
      target: {
        absPath: rep.source.absPath,
        lineStart: rep.source.line,
        lane: lane.lane,
        mutable: 'scaffold-managed', // resident CLAUDE.md sections are scaffold-managed by default
      },
      residentTokenDelta: { estimate, basis },
      tokenTurnsWeight: weight,
      occurrence,
      confidence: tier,
      epochConfidence,
      // DENOMINATOR (exposure) sample streams for a dead-guidance `never`; `[]` for
      // relocate/split (they are `occurs`, no non-occurrence audit).
      attribution: attributionBlock(lane.lane, repScore, streamIds),
      exposure,
      citations,
      costEvidence: basis === 'remove-resident' ? { residentTokensTimesExposure: weight } : undefined,
      laneInsight: kind === 'subtract-dead-guidance' ? 'dead-guidance'
        : kind === 'relocate-to-progressive-disclosure' ? 'occasional-use-relocate'
          : 'mixed-use-split',
      behaviorEvidence: sectionEv as ContextOptimizerProposal['behaviorEvidence'],
      evidenceState: isDeadGuidance ? repVerdict.evidenceState : 'unavailable',
      ...verificationFields(requiresGate, lane.derivation),
    };
    if (sectionEv) proposal.evidenceRef = proposal.id;
    // Sample gate fires only for lever==='subtract' (dead-guidance); relocate/split are
    // ADD/TUNE-adjacent and exempt inside the helper.
    if (sampleGateBlocks(lane, proposal, diagnostics)) continue;
    pushRow(lane, rows, proposal, repVerdict.occurrences);
  }
}

/** WP-E drift proposal id — unchanged format (BUG-43 ids stay stable; id uses the DRIFT
 *  kind, NOT the proposal kind, so it survives the grant-mismatch reclassification). */
function driftId(f: DriftFinding, lane: AgentRoleLane): string {
  return `drift:${f.kind}:${lane}:${f.toolset}${f.toolName ? `:${f.toolName}` : ''}`;
}

/** WP-E sample gate (pre-C conservative form): a behavioral SUBTRACT whose attributed
 *  sample (exposure.streams) is below the floor is withheld → coverage-insufficient
 *  diagnostic, never an actionable proposal. Returns true when it blocked the subtract. */
function sampleGateBlocks(
  lane: LaneOptimizerInput,
  proposal: ContextOptimizerProposal,
  diagnostics: ContextOptimizerDiagnostic[],
): boolean {
  if (proposal.lever !== 'subtract') return false;
  if (proposal.exposure.streams >= OPTIMIZER_CONFIG.SUBTRACT_MIN_SAMPLE_STREAMS) return false;
  diagnostics.push({
    kind: 'coverage-insufficient',
    lane: lane.lane,
    detail: `Subtract '${proposal.id}' withheld: only ${proposal.exposure.streams} attributed stream(s) (< ${OPTIMIZER_CONFIG.SUBTRACT_MIN_SAMPLE_STREAMS}) — insufficient sample for ${lane.lane}.`,
    relatedProposalId: proposal.id,
    evidence: 'insufficient-sample',
    sampleStreams: proposal.exposure.streams,
  });
  return true;
}

/** WP-2A: emit exactly ONE `grant-mismatch-evaluation` diagnostic per grant-mismatch
 *  candidate — the auditable record of why a documented↔grant mismatch did (verdict
 *  `emitted`) or did NOT (`suppressed-counterevidence` / `section-not-resident` /
 *  `zero-token-estimate` / `ambiguous-toolset` / `unresolved-documentation`) become a
 *  subtract. This is the "0 rows, N suppressed" vs "0 candidates" distinguisher the DTO
 *  histogram reads. `grantEpoch` is left undefined for now (current-grant topology is not
 *  historical truth — a spec risk note, not yet threaded). */
function pushEval(
  diagnostics: ContextOptimizerDiagnostic[],
  lane: AgentRoleLane,
  f: DriftFinding,
  verdict: GrantMismatchVerdict,
  detail: string,
  extra?: Partial<ContextOptimizerDiagnostic>,
): void {
  diagnostics.push({
    kind: 'grant-mismatch-evaluation',
    lane,
    grantMismatchVerdict: verdict,
    toolset: f.toolset,
    relatedProposalId: driftId(f, lane),
    detail,
    ...(f.mentionedToolName ? { mentionedToolName: f.mentionedToolName } : {}),
    ...(f.resolutionConfidence ? { resolutionConfidence: f.resolutionConfidence } : {}),
    ...(f.candidateToolsets ? { candidateToolsets: f.candidateToolsets } : {}),
    ...extra,
  });
}

// ── SUBTRACT / ADD from config-drift (static-config facts, observed-safe). ──
function buildDriftProposals(
  lane: LaneOptimizerInput,
  rows: RankRow[],
  diagnostics: ContextOptimizerDiagnostic[],
): void {
  let i = 0;
  // R2 WP-4B (Step 1): symmetry-only `granted-but-undocumented` findings (no behavioral
  // need) are collected here and folded into ONE config-completeness lane card after the
  // loop — never individual zero-weight `add-missing-guidance` proposals.
  const noSignalUndocumented: Array<{ toolset: string; detail: string }> = [];
  for (const f of lane.drift) {
    i += 1;
    const src = f.sources[0];
    const isAdd = f.kind === 'granted-but-undocumented';
    const isSubtract = !isAdd;
    const isGrantMismatchKind =
      f.kind === 'documented-but-not-granted' || f.kind === 'documented-but-decommissioned';

    // WP-2A: an unresolved/ambiguous documented tool mention is NEVER a proposal. It is a
    // typed suppression: emit the evaluation diagnostic and skip. `ambiguous-toolset` when
    // the name mapped to >1 toolset; `unresolved-documentation` when it mapped to none.
    if (f.kind === 'documented-unresolved-toolset') {
      const ambiguous = (f.candidateToolsets?.length ?? 0) > 1;
      pushEval(diagnostics, lane.lane, f,
        ambiguous ? 'ambiguous-toolset' : 'unresolved-documentation', f.detail);
      continue;
    }

    // R2 WP-4B (Step 1): DEMOTE a `granted-but-undocumented` finding unless it carries a
    // real behavioral-need signal (repeated discoverability failures, equivalent shell
    // improvisation, failed/unknown calls, or a measured navigation cost). No signal ⇒
    // collect for the aggregated config-completeness card; NEVER add resident tokens
    // merely for grant↔doc symmetry. A signal ⇒ fall through to a real ADD proposal,
    // enriched below with the crossing reasons + a failure-rate-reduced benefit model.
    let addNeed: BehavioralNeedSignal | null | undefined;
    let addNeedReasons: string[] = [];
    if (isAdd) {
      addNeed = lane.behavioralNeedFor?.(f);
      const need = behavioralNeedTriggers(addNeed);
      if (!need.triggered) {
        noSignalUndocumented.push({ toolset: f.toolset, detail: f.detail });
        continue;
      }
      addNeedReasons = need.reasons;
    }

    // Contradiction guardrail (suppress-only): never delete guidance whose capability
    // family shows live usage. Applies to ANY drift subtract (worst failure mode = ship a
    // subtract that deletes working guidance).
    if (isSubtract) {
      const contra = lane.capabilityFamilyUsageFor?.(f);
      if (contra && contra.calls > 0) {
        diagnostics.push({
          kind: 'grant-mismatch-contradiction',
          lane: lane.lane,
          detail: `Suppressed a '${f.toolset}' subtract in ${lane.lane}: ${contra.calls} call(s) to the '${contra.family}' capability family contradict deadness (${f.detail}).`,
          relatedProposalId: driftId(f, lane.lane),
          capabilityFamily: contra.family,
          counterEvidenceCalls: contra.calls,
        });
        // WP-2A: also file the typed evaluation so EVERY grant-mismatch candidate has
        // exactly one grant-mismatch-evaluation (the contradiction diagnostic stays too).
        if (isGrantMismatchKind) {
          pushEval(diagnostics, lane.lane, f, 'suppressed-counterevidence',
            `Suppressed '${f.toolset}' subtract in ${lane.lane}: ${contra.calls} live '${contra.family}' call(s) contradict deadness.`,
            { capabilityFamily: contra.family, counterEvidenceCalls: contra.calls });
        }
        continue; // do NOT emit the subtract
      }
    }

    // WP-2A honest gating: a `subtract-grant-mismatch` REQUIRES a positive resident-section
    // token estimate. The legacy zero-weight `subtract-dead-guidance` fallback is REMOVED —
    // a grant-mismatch candidate that cannot be sized is SUPPRESSED with a typed verdict
    // (`section-not-resident` when the section text is not resident; `zero-token-estimate`
    // when it is resident but prices at 0), never a fabricated dead-guidance subtract.
    let sectionTokens = 0;
    if (isGrantMismatchKind) {
      let text: string | null = null;
      if (src && lane.residentSectionTextAt && lane.estimateTokens) {
        text = lane.residentSectionTextAt(src.absPath, src.line);
        if (text != null) sectionTokens = lane.estimateTokens(text);
      }
      if (sectionTokens <= 0) {
        const verdict: GrantMismatchVerdict = text == null ? 'section-not-resident' : 'zero-token-estimate';
        pushEval(diagnostics, lane.lane, f, verdict,
          text == null
            ? `Suppressed grant-mismatch subtract for '${f.toolset}' in ${lane.lane}: the documented section is not resident (no text to price). (${f.detail})`
            : `Suppressed grant-mismatch subtract for '${f.toolset}' in ${lane.lane}: the resident section priced at 0 tokens. (${f.detail})`,
          { tokenEstimate: sectionTokens });
        continue; // no proposal
      }
    }
    const isGrantMismatch = isGrantMismatchKind; // reaching here ⇒ sized > 0 (suppressed ones continued)

    const kind: ContextOptimizerProposalKind = isAdd
      ? 'add-missing-guidance'
      : 'subtract-grant-mismatch';
    // Drift is a static-config fact, NOT a compiler-derived behavior predicate → the
    // parity gate does not govern it (never suppressed). Grant-mismatch is
    // verified-by-construction (requiresGate:false) too.
    const requiresGate = false;
    const exposureTurns = lane.resident.exposureTurns;
    const estimate = isGrantMismatch ? sectionTokens : 0;
    const tokenTurnsWeight = isGrantMismatch ? sectionTokens * exposureTurns : 0;

    const proposal: ContextOptimizerProposal = {
      id: driftId(f, lane.lane),
      kind,
      lever: leverFor(kind),
      title: isAdd
        ? `Document granted toolset '${f.toolset}' in ${lane.lane}`
        : isGrantMismatch
          ? `Remove grant-mismatched guidance for '${f.toolset}' in ${lane.lane}`
          : `Remove dead reference to '${f.toolset}' in ${lane.lane}`,
      rationale: isGrantMismatch
        ? `${f.detail}. The documented section is still resident (~${sectionTokens} tokens) but the lane no longer holds the tool — behavior-only detectors cannot see this deadness (the tool is absent, so never observed either way). Removing it reclaims ~${sectionTokens} resident tokens every turn.`
        : isAdd
          ? `${f.detail}. Documenting this granted toolset is justified by observed friction: ${addNeedReasons.join('; ')}. (Symmetry alone would NOT justify an add — this survives demotion because of the behavioral-need signal.)`
          : f.detail,
      target: {
        absPath: src?.absPath,
        lineStart: src?.line,
        mcpToolset: f.toolset,
        mcpToolName: f.toolName,
        lane: lane.lane,
        mutable: 'scaffold-managed',
      },
      residentTokenDelta: { estimate, basis: isAdd ? 'add-resident' : 'remove-resident' },
      tokenTurnsWeight,
      occurrence: isAdd ? 'occurs' : 'never',
      confidence: f.evidenceTier,
      epochConfidence: 'unknown',
      attribution: { lane: lane.lane, streamIds: [], sharedCwdRisk: 'none' },
      exposure: { turns: lane.resident.exposureTurns, streams: lane.resident.exposureStreams, slugs: lane.resident.exposureSlugs },
      citations: f.sources.map((s) => ({ source: 'staticOverheadModel' as const, absPath: s.absPath, line: s.line })),
      costEvidence: isGrantMismatch
        ? { residentTokensTimesExposure: tokenTurnsWeight }
        : isAdd ? { note: `Behavioral need: ${addNeedReasons.join('; ')}.` } : undefined,
      // R2 WP-4B (Step 4): a surviving `add-missing-guidance` is ordered WITHIN its tier by
      // the friction it relieves (failure-rate-reduced), not by `tokenTurnsWeight` (0 here).
      ...(isAdd ? { benefitModel: {
        kind: 'failure-rate-reduced' as const,
        magnitude: behavioralNeedMagnitude(addNeed),
        basis: addNeedReasons.join('; '),
      } } : {}),
      laneInsight: isAdd ? 'config-drift-undocumented' : isGrantMismatch ? 'grant-mismatch' : 'config-drift-dead',
      // WP-1A: config-drift is a STATIC-CONFIG fact (grant-mismatch / dead-ref), not a
      // behavior-derived `never` — there is no occurrence audit trail to attach, so its
      // evidence state is honestly `unavailable` (verified-by-construction elsewhere).
      evidenceState: 'unavailable',
      ...verificationFields(requiresGate, lane.derivation),
    };
    // WP-2A: a sized grant-mismatch subtract IS emitted — file its `emitted` evaluation so
    // every candidate has exactly one grant-mismatch-evaluation (add rows carry no such
    // evaluation; they are not grant-mismatch candidates).
    if (isGrantMismatch) {
      pushEval(diagnostics, lane.lane, f, 'emitted',
        `Emitted grant-mismatch subtract for '${f.toolset}' in ${lane.lane} (~${estimate} resident tokens reclaimed each turn).`,
        { tokenEstimate: estimate, resolvedToolset: f.toolset });
    }
    // Drift subtracts are NOT sample-gated (observed-safe static facts) — no sampleGateBlocks here.
    pushRow(lane, rows, proposal, lane.drift.length - i);
  }

  // R2 WP-4B (Step 1): fold the symmetry-only undocumented grants into ONE lane card. A
  // config-completeness note (counts + detail list), NOT a recommendation to add tokens.
  if (noSignalUndocumented.length > 0) {
    diagnostics.push({
      kind: 'config-completeness',
      lane: lane.lane,
      detail: `${noSignalUndocumented.length} granted toolset(s) in ${lane.lane} are undocumented but show no behavioral need — surfaced as a config-completeness note, not an add-guidance proposal (documenting for symmetry alone would cost resident tokens without an observed benefit).`,
      undocumentedCount: noSignalUndocumented.length,
      undocumentedToolsets: noSignalUndocumented,
    });
  }
}

// ── ADD: uncovered improvisation clusters (§5.3). ──
function buildClusterProposals(lane: LaneOptimizerInput, rows: RankRow[], draftGenerationId: string): void {
  for (const c of lane.clusters) {
    if (c.count < OPTIMIZER_CONFIG.REPEAT_MIN || c.distinctStreams < OPTIMIZER_CONFIG.REPEAT_MIN_STREAMS) continue;

    // WP-B2: a rollup candidate → ONE proposal standing in for `rollupCount` hash-only
    // clusters along this dimension. It carries `target.rollup`, which the shared policy
    // (`proposalIsHashOnly`) reads to treat the row as NOT hash-only noise — so the rollup
    // is default-surfaced instead of buried behind the hidden-rows toggle.
    if (c.isRollup) {
      pushRow(lane, rows, buildClusterRollupProposal(lane, c), c.count);
      continue;
    }

    // Individual hash-only rows carry a bare hash key with no exemplar. Suppress them
    // until an exemplar seam exists — the same "estimator returns 0 / unwired" honesty
    // used elsewhere in this file. (Upstream folding means these do not currently occur;
    // this is the defensive seam for when a per-cluster exemplar is wired.) command_family
    // rows carry a readable key and always pass through.
    if (isHashOnlyDimension(c.dimension) && !c.exemplar) continue;

    const kind: ContextOptimizerProposalKind = 'add-improvisation-support';
    const requiresGate = false; // cluster-derived → never gate-governed (§4.5)
    const perHundred = normalizePer100(c.expectedSaving, lane.resident.exposureTurns);
    const cost: ProposalCostEvidence | undefined = c.expectedSaving > 0
      ? { improvisedPathTokensPer100Turns: perHundred,
          note: `${c.count} improvised '${c.key}' runs across ${c.distinctStreams} streams; ~${c.expectedSaving} tokens re-derived (net-negative over time if covered).` }
      : { note: `${c.count} improvised '${c.key}' runs across ${c.distinctStreams} streams with no guidance/tool.` };
    const proposal: ContextOptimizerProposal = {
      id: `add-cluster:${lane.lane}:${c.dimension}:${c.key}`,
      kind,
      lever: leverFor(kind),
      title: `Support an uncovered '${c.key}' improvisation in ${lane.lane}`,
      rationale: `${c.distinctStreams} agents ran '${c.key}' (${c.dimension}) ${c.count} times with no guidance or tool. Adding a lane CLAUDE.md line or a collapsing tool is net-negative tokens over time.`,
      target: { lane: lane.lane, mutable: 'scaffold-managed' },
      residentTokenDelta: { estimate: 0, basis: 'add-resident' },
      tokenTurnsWeight: 0, // ADD proposals are not token-removal-motivated
      occurrence: 'occurs',
      confidence: 'inferred', // observed behavior, but the "missing guidance" benefit is inferred
      epochConfidence: 'unknown',
      attribution: { lane: lane.lane, streamIds: [], sharedCwdRisk: 'none' },
      exposure: { turns: lane.resident.exposureTurns, streams: c.distinctStreams, slugs: lane.resident.exposureSlugs },
      citations: [],
      costEvidence: cost,
      // R2 WP-4B (Step 4): improvisations order WITHIN their tier by repeated cost avoided
      // — the re-derived tokens when wired, else the raw recurrence count (honest proxy).
      benefitModel: {
        kind: 'repeated-cost-avoided',
        magnitude: c.expectedSaving > 0 ? c.expectedSaving : c.count,
        basis: c.expectedSaving > 0
          ? `~${c.expectedSaving} tokens re-derived across ${c.count} runs`
          : `${c.count} improvised runs across ${c.distinctStreams} streams`,
      },
      evidenceState: 'unavailable', // ADD lever — not a `never`, no non-occurrence audit
      ...verificationFields(requiresGate, lane.derivation),
    };
    // ── WP3 (G3): a command_family cluster is a WORKSPACE-LEVEL candidate ONLY.
    // Its draft target is FORCED unresolved (never a file — the code-level bar in
    // buildRecommendationDraft would throw on one), liftable only by WP9's
    // associatedCommandFamilies join. Evidence cites this proposal's own surface row.
    if (c.dimension === 'command_family') {
      proposal.recommendationDraft = buildRecommendationDraft({
        target: {
          unresolved: true,
          reason: 'command_family evidence supports only workspace-level candidates — '
            + "a file target requires WP9's associatedCommandFamilies join (generationId-gated, prospective)",
        },
        claimTemplate: commandFamilyClaimTemplate({
          family: c.key, count: c.count, distinctStreams: c.distinctStreams, rowId: proposal.id,
        }),
        evidence: [{
          kind: 'command_family', rowIds: [proposal.id],
          generationId: draftGenerationId, surface: RECOMMENDATION_EVIDENCE_SURFACE,
        }],
        generationId: draftGenerationId,
      });
    }
    pushRow(lane, rows, proposal, c.count);
  }
}

// ── WP3 (G3) ADD: hot uncovered allowlisted files → recommendation drafts. ──
//
// Every `hotUncoveredCandidate` file-heat row (uncovered ∧ role allowlist ∧ score ≥
// disclosed threshold ∧ zero guidance-prediction matches — file-coverage.ts) yields
// one ADD proposal whose `recommendationDraft` cites ONLY its own joinable
// same-surface evidence: the file-heat row + the bounded coverage-check summary,
// keyed by this analysis's draftGenerationId. The draft target comes from the WP2
// audience policy (`selectRecommendationTarget`) — exactly one applicable
// GuidanceSource for the observing cohort, else `{ unresolved, reason }`, never a
// CLAUDE.md default.
function buildHotUncoveredProposals(
  lane: LaneOptimizerInput,
  rows: RankRow[],
  draftGenerationId: string,
): void {
  if (!lane.coverage) return;
  for (const h of lane.coverage.fileHeat) {
    if (h.hotUncoveredCandidate !== true || !h.coverageChecks) continue;
    const draft = buildHotUncoveredDraft(lane, h, draftGenerationId);
    const kind: ContextOptimizerProposalKind = 'add-missing-guidance';
    const proposal: ContextOptimizerProposal = {
      id: `add-hot-uncovered:${lane.lane}:${h.pathHash}`,
      kind,
      lever: leverFor(kind),
      title: `Cover the hot uncovered file '${h.pathDisplay}' with guidance in ${lane.lane}`,
      rationale: `Agents in ${lane.lane} touched '${h.pathDisplay}' across ${h.distinctStreams} stream(s) `
        + `(${h.reads} reads, ${h.writes} writes, ${h.executes} executes); `
        + `${h.coverageChecks.totalPredicatesTested} guidance path prediction(s) were tested against it and `
        + `${h.coverageChecks.matched} matched. See the attached recommendation draft (human review required).`,
      target: {
        // The GUIDANCE file the draft would edit (only when the audience policy
        // resolved one); the hot file itself lives in the evidence rows.
        ...(targetIsFile(draft.target) ? { absPath: draft.target.file } : {}),
        lane: lane.lane,
        mutable: 'scaffold-managed',
      },
      residentTokenDelta: { estimate: 0, basis: 'add-resident' },
      tokenTurnsWeight: 0, // ADD proposals are not token-removal-motivated
      occurrence: 'occurs',
      confidence: 'inferred', // observed touches; the "missing guidance" benefit is inferred
      epochConfidence: 'unknown',
      attribution: { lane: lane.lane, streamIds: [], sharedCwdRisk: 'none' },
      exposure: { turns: lane.resident.exposureTurns, streams: h.distinctStreams, slugs: lane.resident.exposureSlugs },
      citations: [],
      costEvidence: {
        note: `${h.distinctStreams} stream(s) touched '${h.pathDisplay}' with no covering guidance prediction `
          + `(${h.coverageChecks.totalPredicatesTested} tested, ${h.coverageChecks.matched} matched).`,
      },
      // Orders WITHIN its tier by observed heat (repeated activity a covering line
      // would support) — same benefit family as the improvisation ADDs.
      benefitModel: {
        kind: 'repeated-cost-avoided',
        magnitude: h.score ?? 0,
        basis: `canonical heat score ${h.score ?? 0} across ${h.distinctStreams} stream(s)`,
      },
      evidenceState: 'unavailable', // ADD lever — not a `never`, no non-occurrence audit
      recommendationDraft: draft,
      ...verificationFields(false, lane.derivation), // direct behavior → gate-exempt (§4.5)
    };
    pushRow(lane, rows, proposal, h.distinctStreams);
  }
}

/** Build the draft for one hot-uncovered row: WP2 audience target policy + the
 *  template-constrained claim citing the row's own evidence ids. */
function buildHotUncoveredDraft(
  lane: LaneOptimizerInput,
  h: FileHeatEntry,
  draftGenerationId: string,
): RecommendationDraft {
  const target = selectRecommendationTarget({
    guidanceSources: lane.guidanceSources,
    observingProviders: lane.observedProviders,
  });
  const checks = h.coverageChecks!;
  return buildRecommendationDraft({
    target,
    claimTemplate: hotUncoveredClaimTemplate({
      pathDisplay: h.pathDisplay,
      pathHash: h.pathHash,
      reads: h.reads,
      writes: h.writes,
      executes: h.executes,
      distinctStreams: h.distinctStreams,
      coverageChecks: checks,
    }),
    evidence: [
      { kind: 'file-heat', rowIds: [h.pathHash], generationId: draftGenerationId, surface: RECOMMENDATION_EVIDENCE_SURFACE },
      { kind: 'coverage-check', rowIds: [h.pathHash], generationId: draftGenerationId, surface: RECOMMENDATION_EVIDENCE_SURFACE },
    ],
    generationId: draftGenerationId,
    suggestedBulletText: hotUncoveredSuggestedBullet({ pathDisplay: h.pathDisplay, distinctStreams: h.distinctStreams }),
  });
}

// WP-B2: the single rollup proposal that stands in for `rollupCount` folded hash-only
// clusters along one dimension. Its `target.rollup` is the signal the shared policy reads
// to keep the row default-surfaced (not hash-only noise). No exemplar is fabricated — the
// title invites a drill-in, which is the documented downstream seam.
function buildClusterRollupProposal(lane: LaneOptimizerInput, c: ImprovisationCandidate): ContextOptimizerProposal {
  const kind: ContextOptimizerProposalKind = 'add-improvisation-support';
  const count = c.rollupCount ?? 0;
  const dimension = (c.clusterDimension ?? c.dimension) as 'input_shape_hash' | 'search_signature_hash';
  const id = `add-cluster-rollup:${lane.lane}:${dimension}`;
  // R2 WP-4B (Step 2/3): the rollup carries capped opaque member refs + top-K summaries.
  // `hasDrillableMembers` gates the exemplar drill: a rollup with no member refs has
  // nothing to reveal, so it stays a completeness note (hasActionableContent:false), NOT
  // an actionable improvement inviting a drill that would return nothing.
  const memberRefs = c.memberRefs ?? [];
  const topMembers = c.topMembers ?? [];
  const totalOccurrences = c.totalOccurrences ?? c.count;
  const hasDrillableMembers = memberRefs.length > 0;
  const magnitude = c.expectedSaving > 0 ? c.expectedSaving : totalOccurrences;
  return {
    id,
    kind,
    lever: leverFor(kind),
    title: hasDrillableMembers
      ? `${count} improvisation clusters, hash-only — drill for exemplars`
      : `${count} improvisation clusters, hash-only — no drillable exemplars yet`,
    rationale: hasDrillableMembers
      ? `${count} uncovered ${dimension} clusters in ${lane.lane} recur with no guidance or tool. Drill in (get_context_optimizer_cluster_exemplars) to surface a redacted structural exemplar — tool short name + input-key set, or normalized search terms — before minting guidance.`
      : `${count} uncovered ${dimension} clusters in ${lane.lane} recur with no guidance or tool, but no drillable member exemplars are available yet — surfaced as a diagnostic, not an actionable improvement, until an exemplar seam yields a representative.`,
    target: { lane: lane.lane, mutable: 'scaffold-managed',
      rollup: { count, dimension, memberRefs, topMembers, totalOccurrences,
                distinctStreams: c.distinctStreams, hasDrillableMembers } },
    residentTokenDelta: { estimate: 0, basis: 'add-resident' },
    tokenTurnsWeight: 0, // ADD proposals are not token-removal-motivated
    occurrence: 'occurs',
    confidence: 'inferred',
    epochConfidence: 'unknown',
    attribution: { lane: lane.lane, streamIds: [], sharedCwdRisk: 'none' },
    exposure: { turns: lane.resident.exposureTurns, streams: c.distinctStreams, slugs: lane.resident.exposureSlugs },
    citations: [],
    costEvidence: { note: `${count} hash-only clusters folded into one rollup${hasDrillableMembers ? ` (${memberRefs.length} drillable member ref(s))` : ' (no drillable exemplars yet)'}.` },
    // R2 WP-4B (Step 3): the exemplar-drill key (only when there is something to drill).
    ...(hasDrillableMembers ? { clusterExemplarRef: id } : {}),
    // R2 WP-4B (Step 4): rollups order WITHIN tier by repeated cost avoided (re-derived
    // tokens when wired, else folded occurrences).
    benefitModel: {
      kind: 'repeated-cost-avoided',
      magnitude,
      basis: c.expectedSaving > 0
        ? `~${c.expectedSaving} tokens re-derived across ${count} folded clusters`
        : `${totalOccurrences} occurrences across ${count} folded clusters`,
    },
    evidenceState: 'unavailable', // ADD lever — not a `never`, no non-occurrence audit
    ...verificationFields(false, lane.derivation),
  };
}

// ── TUNE: skill-bypass proposals → tune-skill-trigger cards (§2.4). ──
function buildBypassProposals(lane: LaneOptimizerInput, rows: RankRow[]): void {
  for (const bp of lane.bypass.proposals) {
    const proposal = bypassToProposal(lane, bp);
    pushRow(lane, rows, proposal, bp.execCount);
  }
}

function bypassToProposal(lane: LaneOptimizerInput, bp: BypassProposal): ContextOptimizerProposal {
  const kind: ContextOptimizerProposalKind = 'tune-skill-trigger';
  const requiresGate = bp.requiresDerivationGate; // false — direct behavior, gate-exempt (§4.5)
  const tier: BehaviorEvidenceTier = bp.matchConfidence === 'exact' ? 'observed' : 'inferred';
  const costRaw = lane.cost?.bypassCostByScript?.[bp.scriptPath];
  const cost: ProposalCostEvidence = {
    note: bp.disclosedSubagentExecs > 0
      ? `${bp.disclosedSubagentExecs} subagent execs excluded from the count.`
      : undefined,
  };
  if (costRaw) {
    cost.improvisedPathTokensPer100Turns = normalizePer100(
      costRaw.improvisedTokensPerSession * (costRaw.sessionsSampled ?? bp.execStreams),
      lane.resident.exposureTurns,
    );
    cost.skillPathTokensPerInvocation = costRaw.skillTokensPerInvocation;
  }
  return {
    id: `tune-skill:${lane.lane}:${bp.skillName}:${bp.scriptPath}`,
    kind,
    lever: leverFor(kind),
    title: `Tune the '${bp.skillName}' skill trigger in ${lane.lane}`,
    rationale: `The '${bp.skillName}' skill's script was executed directly in ${bp.execStreams} streams (${bp.execCount} execs) versus ${bp.skillStreams} legitimate skill invocations — agents are improvising past the trigger. Clarify the trigger/description; do NOT trim the body (skill bodies are non-resident).`,
    target: {
      skillName: bp.skillName,
      absPath: bp.scriptPath,
      lane: lane.lane,
      mutable: bp.triggerMutability,
    },
    residentTokenDelta: { estimate: 0, basis: 'header-only' }, // skills are never token-motivated
    tokenTurnsWeight: 0,
    occurrence: 'occurs',
    confidence: tier,
    epochConfidence: 'unknown',
    attribution: { lane: lane.lane, streamIds: bp.citedStreams, sharedCwdRisk: 'none' },
    exposure: { turns: lane.resident.exposureTurns, streams: bp.execStreams, slugs: lane.resident.exposureSlugs },
    citations: bp.citedStreams.slice(0, 20).map((s) => ({ source: 'historicalChatLogAnalytics' as const, streamId: s, absPath: bp.scriptPath })),
    costEvidence: cost.improvisedPathTokensPer100Turns != null || cost.note ? cost : undefined,
    phraseGap: lane.phraseGapByScript?.[bp.scriptPath],
    evidenceState: 'unavailable', // TUNE lever — bypass already cites its own streamIds
    ...verificationFields(requiresGate, lane.derivation),
  };
}

/** Normalize a raw token count to a per-100-turns rate (A4/A8 rule — never raw
 *  counts). Returns integer bps-style rate; 0 when exposure is unknown/zero. */
function normalizePer100(rawTokens: number, exposureTurns: number): number {
  if (exposureTurns <= 0) return 0;
  return Math.round((rawTokens / exposureTurns) * OPTIMIZER_CONFIG.RATE_NORMALIZATION_TURNS);
}
