// agent-dto-build.ts — WP7 page builders (PURE, no IO).
//
// The load-bearing filter/sort/paginate/redact/degrade logic behind the WP7 GET routes
// for the CONTEXT-OPTIMIZER lane: `get_context_optimizer_proposals` (list + detail) and
// `get_file_heat`. api-server.ts routes are thin wrappers that (1) run the live analyze,
// (2) resolve caller scope, (3) call one of these builders, (4) serialize. Keeping the
// logic here (owned, pure) makes it unit-testable against fixtures rather than only via
// a live HTTP round-trip. READ-ONLY: nothing here writes.
//
// Test: node dist/main/main/context-optimizer/agent-dto-build.test.js

import { createHash } from 'node:crypto';
import type {
  AgentRoleLane,
  AnalyzabilityDiagnostic,
  BehaviorEvidenceTier,
  ContextOptimizerLever,
  ContextOptimizerProposal,
  ContextOptimizerProposalKind,
  ContextOptimizerResult,
  FileHeatScoreComponents,
  OccurrenceEvidenceDTO,
  PathRole,
} from '../../shared/types';
import { canonicalHeatScore } from './file-coverage';
import {
  CONTEXT_OPTIMIZER_POLICY_VERSION,
  isDefaultVisibleProposal,
  isProposalDefaultSurfaced,
  proposalHasActionableContent,
} from '../../shared/context-optimizer-policy';
import { OPTIMIZER_CONFIG, PREDICTED_ACTION_COMPILER_VERSION } from './optimizer-config';
import type { BehaviorStore, ClusterExemplar, Lane } from './behavior-store';
import { leverFor } from './capstone-map';
import {
  AGENT_DTO_CAPS,
  AGENT_DTO_PARSER_VERSION,
  clampLimit,
  computeFiltersHash,
  computeGenerationId,
  degradePayload,
  encodeCursor,
  errResponse,
  okResponse,
  redactFileHeatPath,
  redactRollupEntry,
  toProposalSummary,
  validateCursor,
  type AgentDtoMeta,
  type AgentDtoParityStatus,
  type AgentDtoResponse,
  type AgentDtoScopeMeta,
  type AgentWarning,
  type AnalysisHealth,
  type AnalyzabilityRowDTO,
  type FileHeatPath,
  type GrantMismatchEvaluationSummary,
  type PageInfo,
  type ProposalSummaryDTO,
  type RedactionRoots,
} from './agent-dto';

// ── tiers ────────────────────────────────────────────────────────────────────────
const TIER_ORDINAL: Record<BehaviorEvidenceTier, number> = {
  'observed-safe': 3, observed: 2, inferred: 1, heuristic: 0,
};

const PROPOSALS_ROUTE = 'get_context_optimizer_proposals';
// WP-B1: agent-actionable proposals rank ahead of hash-only / no-target noise, so the
// 4 material supervisor subtracts land on page 1. Changing this string also invalidates
// any in-flight cursor issued under the prior 2-tuple sort (→ CURSOR_INVALID) — intended.
const PROPOSALS_SORT = 'hasActionableContent DESC, tokenTurnsWeight DESC, id ASC';
const FILE_HEAT_ROUTE = 'get_file_heat';
const FILE_HEAT_SORT = 'heat DESC, pathHash ASC';
// R2 WP-4C — the capped section-level analyzability detail route.
const ANALYZABILITY_ROUTE = 'get_context_optimizer_analyzability';
const ANALYZABILITY_SORT = 'trappedCost DESC, sectionId ASC';

/** Task 1b (supervisor-endorsed): `get_improvement_proposals` is the SAME live
 *  analyze output filtered to the "improve" levers (ADD / TUNE / RELOCATE), while
 *  `get_context_optimizer_proposals` stays ALL levers. Both project to
 *  `ProposalSummaryDTO`. The lever set is derived via `leverFor(kind)` — never a
 *  hand-coded kind list — so it tracks the one capstone map (capstone-map.ts). */
export const IMPROVEMENT_ROUTE = 'get_improvement_proposals';
export const IMPROVEMENT_LEVERS: readonly ContextOptimizerLever[] = ['add', 'tune', 'relocate'];

/** Optional analysis-state + tool-identity inputs for buildProposalsPage. `route`
 *  distinguishes the improvement tool's cursor space from the all-levers one; `levers`
 *  scopes the population; `indexing` threads a real first-run backfill signal (test 28)
 *  so an empty-while-indexing page reports `dataState:'indexing'`, not `'empty'`. */
export interface ProposalsPageOpts {
  route?: string;
  levers?: readonly ContextOptimizerLever[];
  indexing?: { ready: boolean; progress?: { filesDone: number; filesTotal: number } };
}

export interface ProposalsPageParams {
  lane?: AgentRoleLane;
  kind?: ContextOptimizerProposalKind;
  minTier?: BehaviorEvidenceTier;
  limit?: number;
  cursor?: string;
  /** §4.6/§5.5: materialize gate-governed unverified proposals (default hidden). */
  includeUnverified?: boolean;
}

function laneOf(p: ContextOptimizerProposal): AgentRoleLane | undefined {
  return p.target.lane ?? p.attribution.lane;
}

/** Worst (least-verified) parity across a proposal set (§5.1 parityStatus). */
function deriveParityStatus(proposals: ContextOptimizerProposal[]): AgentDtoParityStatus {
  const order: AgentDtoParityStatus['state'][] =
    ['mismatch', 'stale', 'unverified', 'unverified-no-reference', 'verified'];
  let worstIdx = order.length - 1; // default 'verified' when empty
  const staleReasons = new Set<string>();
  for (const p of proposals) {
    const idx = order.indexOf(p.verification.state);
    if (idx >= 0 && idx < worstIdx) worstIdx = idx;
    for (const r of p.verification.staleReasons ?? []) staleReasons.add(r);
  }
  const state = order[worstIdx];
  return {
    verified: state === 'verified',
    state,
    staleReasons: staleReasons.size ? [...staleReasons] : undefined,
  };
}

/** WP-D fix leg — per-reason histogram of the already-computed `notAnalyzable`
 *  sections (`UnobservableReason` label → count), promoted onto the improve DTO so an
 *  agent sees WHY sections are not analyzable (dominant `unmatchable` prose vs
 *  `insufficient-exposure`), not just the total. Returns undefined when there are none
 *  so the field is omitted from lean metas. */
function notAnalyzableByReason(
  result: ContextOptimizerResult,
): Record<string, number> | undefined {
  const hist: Record<string, number> = {};
  for (const n of result.modelStats.notAnalyzable) hist[n.label] = (hist[n.label] ?? 0) + 1;
  return Object.keys(hist).length ? hist : undefined;
}

/** R2 WP-4C — the ACTIONABLE reason-code projection of the section-level `analyzability`
 *  diagnostic: a histogram over the six STABLE `AnalyzabilityReasonCode`s plus the section
 *  and action counts (BOTH — a section carries many rejected actions, so the section count
 *  is not the action count). Spread into DTO meta beside the coarse `notAnalyzableByReason`,
 *  which is retained for back-compat. Returns `{}` (honest omit) when there is no
 *  analyzability data. */
function analyzabilityCodeMeta(result: ContextOptimizerResult): {
  notAnalyzableByReasonCode?: Record<string, number>;
  notAnalyzableSectionCount?: number;
  notAnalyzableActionCount?: number;
} {
  const diags = result.modelStats.analyzability;
  if (!diags || diags.length === 0) return {};
  const hist: Record<string, number> = {};
  let actionCount = 0;
  for (const d of diags) {
    actionCount += d.actionCount;
    for (const r of d.reasons) hist[r.code] = (hist[r.code] ?? 0) + r.count;
  }
  return {
    notAnalyzableByReasonCode: hist,
    notAnalyzableSectionCount: diags.length,
    notAnalyzableActionCount: actionCount,
  };
}

/** WP-1C — engine-derived insufficient-exposure count. Insufficient-exposure actions are
 *  emitted into `modelStats.notAnalyzable` with the `insufficient-exposure` label (the
 *  occurrence classifier's watch-item bucket, context-optimizer.ts). Replaces the old
 *  hard-coded `0` that lied while such actions were present in `notAnalyzable`. */
function insufficientExposureCountOf(result: ContextOptimizerResult): number {
  return result.modelStats.notAnalyzable
    .filter((n) => n.label === 'insufficient-exposure').length;
}

/**
 * WP-1C — build the compact `analysisHealth` block. Every component that cannot be
 * measured honestly from `ContextOptimizerResult` is emitted as `null` with a
 * `<name>Unmeasured:1` reason flag in `diagnostics` (never a fabricated number), so an
 * agent can tell "we measured 0%" from "we cannot measure this yet". The measurable
 * counts (proposals, notAnalyzable, insufficient-exposure, suppressed, behavior events,
 * file-heat coverage split) ride in `diagnostics` as honest raw numbers.
 */
function buildAnalysisHealth(result: ContextOptimizerResult): AnalysisHealth {
  const heat = result.fileHeat;
  const uncovered = heat.filter((f) => f.uncovered).length;
  const diagnostics: Record<string, number> = {
    proposals: result.proposals.length,
    notAnalyzable: result.modelStats.notAnalyzable.length,
    insufficientExposure: insufficientExposureCountOf(result),
    unverifiedSuppressed: result.meta.unverifiedSuppressedCount,
    behaviorEvents: result.modelStats.behaviorEvents,
    fileHeatRows: heat.length,
    fileHeatUncovered: uncovered,
  };
  // captureCoveragePct: fraction of hot files that ARE covered by guidance. Only honest
  // when there is heat to divide by; else null + reason.
  let captureCoveragePct: number | null = null;
  if (heat.length > 0) captureCoveragePct = Math.round(((heat.length - uncovered) / heat.length) * 100);
  else diagnostics.captureCoverageUnmeasured = 1;
  // workspaceCoveragePct: no per-workspace denominator until Phase-2 lineage — honest null.
  diagnostics.workspaceCoverageUnmeasured = 1;
  // analyzableResidentTokenPct: notAnalyzable is action-counted, not token-weighted —
  // no honest token-weighted split exists on the result today. Honest null.
  diagnostics.analyzableResidentTokenUnmeasured = 1;
  return {
    captureCoveragePct,
    workspaceCoveragePct: null,
    analyzableResidentTokenPct: null,
    diagnostics,
    policyVersion: CONTEXT_OPTIMIZER_POLICY_VERSION,
    matcherVersion: String(PREDICTED_ACTION_COMPILER_VERSION),
  };
}

/** WP-2A — cap on the number of grant-mismatch-evaluation summaries carried in meta. The
 *  histogram (`diagnosticCounts`) always counts ALL of them, so a truncated summary list
 *  never hides the true suppressed/emitted totals. */
const GRANT_MISMATCH_EVAL_CAP = 20;

/**
 * WP-2A — project the engine's `grant-mismatch-evaluation` (and sibling) diagnostics onto
 * DTO meta: a `diagnosticCounts` histogram (keyed by raw diagnostic `kind`, plus one
 * `evaluation:<verdict>` key per grant-mismatch-evaluation) and the capped, redaction-safe
 * `grantMismatchEvaluations` summaries (identifiers + verdicts + counts only — never raw
 * section text). `relatedProposalId` scopes both to a single proposal's diagnostics (detail
 * view); omit it for the whole-generation view (list page 1). Returns `{}` when there are no
 * diagnostics in scope, so meta stays lean. This is the "0 rows because N candidates were
 * suppressed" vs "0 candidates detected" distinguisher a defaults-only call needs.
 */
function buildDiagnosticProjection(
  result: ContextOptimizerResult,
  opts: { relatedProposalId?: string } = {},
): Pick<AgentDtoMeta, 'diagnosticCounts' | 'grantMismatchEvaluations'> {
  const all = result.diagnostics ?? [];
  const scoped = opts.relatedProposalId != null
    ? all.filter((d) => d.relatedProposalId === opts.relatedProposalId)
    : all;
  if (scoped.length === 0) return {};

  const diagnosticCounts: Record<string, number> = {};
  for (const d of scoped) {
    diagnosticCounts[d.kind] = (diagnosticCounts[d.kind] ?? 0) + 1;
    if (d.kind === 'grant-mismatch-evaluation' && d.grantMismatchVerdict) {
      const k = `evaluation:${d.grantMismatchVerdict}`;
      diagnosticCounts[k] = (diagnosticCounts[k] ?? 0) + 1;
    }
  }

  const evaluations = scoped
    .filter((d) => d.kind === 'grant-mismatch-evaluation' && d.grantMismatchVerdict)
    .slice(0, GRANT_MISMATCH_EVAL_CAP)
    .map((d): GrantMismatchEvaluationSummary => ({
      verdict: d.grantMismatchVerdict!,
      lane: d.lane,
      detail: d.detail,
      ...(d.relatedProposalId ? { relatedProposalId: d.relatedProposalId } : {}),
      ...(d.toolset ? { toolset: d.toolset } : {}),
      ...(d.resolvedToolset ? { resolvedToolset: d.resolvedToolset } : {}),
      ...(d.mentionedToolName ? { mentionedToolName: d.mentionedToolName } : {}),
      ...(d.resolutionConfidence ? { resolutionConfidence: d.resolutionConfidence } : {}),
      ...(d.candidateToolsets ? { candidateToolsets: d.candidateToolsets } : {}),
      ...(d.tokenEstimate != null ? { tokenEstimate: d.tokenEstimate } : {}),
    }));

  return {
    diagnosticCounts,
    ...(evaluations.length > 0 ? { grantMismatchEvaluations: evaluations } : {}),
  };
}

function deriveDataState(
  parity: AgentDtoParityStatus,
  visibleCount: number,
  unverifiedSuppressedCount: number,
  indexing?: ProposalsPageOpts['indexing'],
): AgentDtoMeta['dataState'] {
  // §5.1 test 28: an empty page WHILE the parse backfill is still running is
  // 'indexing' (the agent retries), never 'empty' (which would read as "nothing to
  // optimize"). A non-empty page is real data regardless of indexing progress.
  if (visibleCount === 0 && unverifiedSuppressedCount === 0) {
    return indexing && !indexing.ready ? 'indexing' : 'empty';
  }
  if (visibleCount === 0 && unverifiedSuppressedCount > 0) return 'unverified';
  if (!parity.verified) return 'unverified';
  return 'ready';
}

/**
 * Build the lean `ProposalSummaryDTO` page for `get_context_optimizer_proposals`.
 * Filters (lane/kind/minTier) → default-surface policy (gate-suppressed hidden unless
 * `includeUnverified` OR `isDefaultVisibleProposal`) → stable sort (hasActionableContent
 * DESC, tokenTurnsWeight DESC, id ASC) → opaque-cursor page.
 * `meta.unverifiedSuppressedCount` ALWAYS discloses the proposals that are STILL hidden
 * (gate-suppressed and not default-visible) even when the list omits them (§5.5).
 */
export function buildProposalsPage(
  result: ContextOptimizerResult,
  params: ProposalsPageParams,
  opts: ProposalsPageOpts = {},
): AgentDtoResponse<ProposalSummaryDTO[]> {
  const route = opts.route ?? PROPOSALS_ROUTE;
  const leverSet = opts.levers ? new Set(opts.levers) : null;
  // Belt (BUG-43): dedupe on ingestion before generationId / filter / sort. The engine
  // already de-dups by id, but keep the last defensive layer here so a duplicate id can
  // never reach the id-keyed cursor (two summaries with the same id on one page would
  // corrupt pagination). Disclose via a warning when duplicates were dropped.
  const uniqueProposals = [...new Map(result.proposals.map((p) => [p.id, p])).values()];
  const dedupeWarnings: AgentWarning[] = uniqueProposals.length !== result.proposals.length
    ? [{
        code: 'DUPLICATE_PROPOSAL_IDS',
        message: 'Duplicate proposal ids were dropped before paging.',
        details: { dropped: result.proposals.length - uniqueProposals.length },
      }]
    : [];
  const generationId = computeGenerationId({
    proposalIds: uniqueProposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  const filtersHash = computeFiltersHash({
    lane: params.lane ?? null,
    kind: params.kind ?? null,
    minTier: params.minTier ?? null,
    includeUnverified: Boolean(params.includeUnverified),
    // Fold the lever scope into the hash so an improvement cursor can never be
    // replayed against the all-levers surface (→ CURSOR_INVALID).
    levers: leverSet ? [...leverSet].sort() : null,
  });

  // Cursor gate (before any work — invalid/stale short-circuits with disclosure).
  if (params.cursor) {
    const v = validateCursor(params.cursor, {
      route, filtersHash, sort: PROPOSALS_SORT, generationId,
    });
    if (!v.ok) return errResponse(v.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }

  // Filter (lane/kind/minTier/lever) — this is the query-scoped population.
  const minOrd = params.minTier ? TIER_ORDINAL[params.minTier] : -1;
  const scoped = uniqueProposals.filter((p) => {
    if (leverSet && !leverSet.has(leverFor(p.kind))) return false;
    if (params.lane && laneOf(p) !== params.lane) return false;
    if (params.kind && p.kind !== params.kind) return false;
    if (minOrd >= 0 && TIER_ORDINAL[p.confidence] < minOrd) return false;
    return true;
  });

  // Disclosure (WP-B1): only proposals that are STILL hidden are counted — a material
  // subtract now surfaced via `isDefaultVisibleProposal` is no longer "suppressed".
  const unverifiedSuppressedCount = scoped.filter(
    (p) => p.suppressedFromAgentSurface && !isDefaultVisibleProposal(p)).length;
  // Default surface (WP-B1): a proposal is visible when it is not gate-suppressed OR the
  // shared per-kind policy makes it default-visible (material subtract, etc.).
  // `includeUnverified:true` still returns everything.
  const visible = params.includeUnverified
    ? scoped
    : scoped.filter((p) => isProposalDefaultSurfaced(p));

  // Stable sort: hasActionableContent DESC, tokenTurnsWeight DESC, id ASC.
  const sorted = [...visible].sort((a, b) => {
    const aa = proposalHasActionableContent(a) ? 1 : 0;
    const ba = proposalHasActionableContent(b) ? 1 : 0;
    return ba - aa
      || b.tokenTurnsWeight - a.tokenTurnsWeight
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  // Cursor offset — keep only items strictly after lastSortKey [hasActionable, weight, id]
  // in the sort order (hasActionable DESC, weight DESC, id ASC).
  let afterIdx = 0;
  if (params.cursor) {
    const decoded = validateCursor(params.cursor, {
      route, filtersHash, sort: PROPOSALS_SORT, generationId,
    });
    if (decoded.ok) {
      const [lastActionable, lastWeight, lastId] =
        decoded.cursor.lastSortKey as [number, number, string];
      afterIdx = sorted.findIndex((p) => {
        const a = proposalHasActionableContent(p) ? 1 : 0;
        return a < lastActionable
          || (a === lastActionable && p.tokenTurnsWeight < lastWeight)
          || (a === lastActionable && p.tokenTurnsWeight === lastWeight && p.id > lastId);
      });
      if (afterIdx < 0) afterIdx = sorted.length;
    }
  }

  const limit = clampLimit(params.limit, AGENT_DTO_CAPS.context_optimizer_proposals.listDefault,
    AGENT_DTO_CAPS.context_optimizer_proposals.listMax);
  const slice = sorted.slice(afterIdx, afterIdx + limit);
  const hasMore = afterIdx + limit < sorted.length;
  const summaries = slice.map(toProposalSummary);

  // Byte-cap degradation (summaries are lean; guard anyway — never a silent mid-list drop).
  const degraded = degradePayload({ items: summaries as unknown as Record<string, unknown>[] });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  const finalSummaries = degraded.items as unknown as ProposalSummaryDTO[];
  const warnings: AgentWarning[] = [...dedupeWarnings, ...degraded.warnings];

  const last = finalSummaries[finalSummaries.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({
        v: 1, route, filtersHash, sort: PROPOSALS_SORT,
        lastSortKey: [last.hasActionableContent ? 1 : 0, last.tokenTurnsWeight, last.id],
        generationId, issuedAtMs: 0,
      })
    : undefined;

  const parityStatus = deriveParityStatus(scoped);
  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: deriveDataState(parityStatus, visible.length, unverifiedSuppressedCount, opts.indexing),
    parityStatus,
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount,
    ...(opts.indexing ? { indexing: opts.indexing } : {}),
    // WP-1C: population before/after the query filter (uniqueProposals is post-dedupe,
    // pre-filter; scoped is post lane/kind/tier/lever).
    scopeMeta: {
      appliedLane: params.lane ?? null,
      populationBeforeScope: uniqueProposals.length,
      populationAfterScope: scoped.length,
    } satisfies AgentDtoScopeMeta,
    // WP-1C: full analysisHealth only on page 1 (no cursor) — identical within a
    // generation, so later pages omit it to stay lean.
    ...(params.cursor ? {} : { analysisHealth: buildAnalysisHealth(result) }),
    // WP-2A: diagnostic histogram + capped grant-mismatch evaluations on page 1 only
    // (whole-generation scope), same lean-later-pages rationale as analysisHealth.
    ...(params.cursor ? {} : buildDiagnosticProjection(result)),
  };
  const page: PageInfo = { limit, returned: finalSummaries.length, hasMore, nextCursor };
  return okResponse(finalSummaries, { meta, page, warnings });
}

/**
 * Full detail for one proposal (`get_context_optimizer_proposal?id=`). Caps citations
 * (max 5) and phrase-gap terms (max 10) per §5.3; the patch rides only when
 * `includePatch` (default omitted). NEVER carries raw snippets — those are UI/IPC-only
 * (§5.6); the phrase-gap `terms` are post-redaction aggregates and safe.
 */
export function buildProposalDetail(
  result: ContextOptimizerResult,
  id: string,
  opts: { includePatch?: boolean } = {},
): AgentDtoResponse<ContextOptimizerProposal> {
  // Dedupe on ingestion (BUG-43 belt) so the generation digest matches the list path.
  const uniqueProposals = [...new Map(result.proposals.map((p) => [p.id, p])).values()];
  const found = uniqueProposals.find((p) => p.id === id);
  const generationId = computeGenerationId({
    proposalIds: uniqueProposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  if (!found) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No proposal with id '${id}' in this generation.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const caps = AGENT_DTO_CAPS.context_optimizer_proposals;
  const detail: ContextOptimizerProposal = {
    ...found,
    citations: found.citations.slice(0, caps.citationsMax),
    phraseGap: found.phraseGap
      ? { terms: found.phraseGap.terms.slice(0, caps.phraseTermsMax) }
      : found.phraseGap,
    proposedEdit: found.proposedEdit
      ? (opts.includePatch
          ? found.proposedEdit
          : { summary: found.proposedEdit.summary })
      : undefined,
    // WP-1A: defensively cap the behavior-evidence samples (identifiers-only by
    // construction — no raw text — so this is a size bound, not a redaction).
    behaviorEvidence: found.behaviorEvidence ? capEvidence(found.behaviorEvidence) : undefined,
  };
  const parityStatus = deriveParityStatus([found]);
  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: found.suppressedFromAgentSurface ? 'unverified' : 'ready',
    parityStatus,
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount: found.suppressedFromAgentSurface ? 1 : 0,
    // WP-1C: detail responses always carry the full analysisHealth block.
    analysisHealth: buildAnalysisHealth(result),
    // WP-2A: the read-only per-proposal diagnostic drill — scope the histogram +
    // evaluation summaries to just this proposal's `relatedProposalId` diagnostics.
    ...buildDiagnosticProjection(result, { relatedProposalId: id }),
  };
  return okResponse(detail, { meta });
}

/** WP-1A (Priority 0) — defensively cap the evidence sample arrays for a payload.
 *  Evidence carries only identifiers + counts (redaction-safe by construction), so this
 *  is a SIZE bound, never a redaction. */
function capEvidence(ev: OccurrenceEvidenceDTO): OccurrenceEvidenceDTO {
  const cap = AGENT_DTO_CAPS.context_optimizer_proposals.evidenceSamplesMax;
  return {
    ...ev,
    denominator: { ...ev.denominator, sampledStreams: ev.denominator.sampledStreams.slice(0, cap) },
    numerator: { ...ev.numerator, sampledEvents: ev.numerator.sampledEvents.slice(0, cap) },
  };
}

/**
 * WP-1A (Priority 0) — the read-only evidence drill for ONE `never`/subtract proposal
 * (`GET /api/context-optimizer/proposals/:id/evidence`). Returns the SAME-GENERATION
 * `OccurrenceEvidenceDTO` (capped) that rode the proposal, or INVALID_ARGUMENT when the
 * id is unknown OR the proposal carries no behavior evidence (legacy / static-config —
 * `evidenceState` ∈ {unavailable}). No raw text: identifiers + counts only.
 */
export function buildProposalEvidence(
  result: ContextOptimizerResult,
  id: string,
): AgentDtoResponse<OccurrenceEvidenceDTO> {
  // Same dedupe belt (BUG-43) as list/detail so the generation digest matches.
  const uniqueProposals = [...new Map(result.proposals.map((p) => [p.id, p])).values()];
  const found = uniqueProposals.find((p) => p.id === id);
  const generationId = computeGenerationId({
    proposalIds: uniqueProposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  if (!found) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No proposal with id '${id}' in this generation.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  if (!found.behaviorEvidence) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No behavior evidence for this proposal (evidenceState=${found.evidenceState}).`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const parityStatus = deriveParityStatus([found]);
  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: 'ready',
    parityStatus,
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount: 0,
    analysisHealth: buildAnalysisHealth(result),
  };
  return okResponse(capEvidence(found.behaviorEvidence), { meta });
}

/**
 * R2 WP-4B (Step 3) — the read-only REDACTED exemplar drill behind a hash-only cluster
 * ROLLUP proposal (`GET /api/context-optimizer/proposals/:id/cluster-exemplars`). Given
 * the rollup proposal id, resolves its `target.rollup` {dimension} + lane and runs the
 * live `BehaviorStore.clusterExemplars` off the SAME unscoped store the rollup folded, so
 * the drill matches the folded members. Returns structural exemplars ONLY (tool short
 * name + input-key NAMES, or normalized search terms) — NEVER a raw prompt/value.
 *   - unknown id                         → INVALID_ARGUMENT
 *   - non-rollup / no drillable members  → INVALID_ARGUMENT (it is a diagnostic, not a
 *                                          drillable action — hasActionableContent:false)
 * Additive — AGENT_DTO_PARSER_VERSION stays 2.
 */
export interface ClusterExemplarsDTO {
  proposalId: string;
  lane?: AgentRoleLane;
  dimension: 'input_shape_hash' | 'search_signature_hash';
  rollup: { count: number; totalOccurrences?: number; distinctStreams?: number };
  exemplars: ClusterExemplar[];
}

export function buildClusterExemplars(
  result: ContextOptimizerResult,
  store: Pick<BehaviorStore, 'clusterExemplars'>,
  id: string,
  params: { cursor?: string; limit?: number },
): AgentDtoResponse<ClusterExemplarsDTO> {
  // Same dedupe belt (BUG-43) as list/detail/evidence so the generation digest matches.
  const uniqueProposals = [...new Map(result.proposals.map((p) => [p.id, p])).values()];
  const found = uniqueProposals.find((p) => p.id === id);
  const generationId = computeGenerationId({
    proposalIds: uniqueProposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  if (!found) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No proposal with id '${id}' in this generation.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const rollup = found.target.rollup;
  if (!rollup || rollup.hasDrillableMembers !== true) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `Proposal '${id}' is not a drillable cluster rollup.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const lane = found.target.lane ?? found.attribution.lane;
  const limit = clampLimit(
    params.limit,
    OPTIMIZER_CONFIG.CLUSTER_EXEMPLARS_DEFAULT_LIMIT,
    OPTIMIZER_CONFIG.CLUSTER_EXEMPLARS_MAX_LIMIT);
  const pageRes = store.clusterExemplars((lane ?? 'unknown') as Lane, rollup.dimension, {
    cursor: params.cursor, limit,
  });
  const payload: ClusterExemplarsDTO = {
    proposalId: id,
    ...(lane ? { lane } : {}),
    dimension: rollup.dimension,
    rollup: {
      count: rollup.count,
      ...(rollup.totalOccurrences != null ? { totalOccurrences: rollup.totalOccurrences } : {}),
      ...(rollup.distinctStreams != null ? { distinctStreams: rollup.distinctStreams } : {}),
    },
    exemplars: pageRes.exemplars,
  };
  const parityStatus = deriveParityStatus([found]);
  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: 'ready',
    parityStatus,
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount: 0,
    analysisHealth: buildAnalysisHealth(result),
  };
  const page: PageInfo = {
    limit,
    returned: pageRes.exemplars.length,
    hasMore: Boolean(pageRes.nextCursor),
    nextCursor: pageRes.nextCursor,
  };
  return okResponse(payload, { meta, page });
}

// ── file heat ──────────────────────────────────────────────────────────────────

export interface FileHeatRowDTO extends FileHeatPath {
  lane: AgentRoleLane;
  coverage: string;
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
  uncovered: boolean;
  // ── WP-4A (Phase 4) additive projections (absent ⇒ pre-Phase-4 rollup). ──
  role?: PathRole;
  roleReason?: string;
  operationalNoise?: boolean;
  score?: number;
  scoreComponents?: FileHeatScoreComponents;
  guidanceGapCandidate?: boolean;
  // ── WP6 (G6): hot-uncovered candidate flag (WP3 engine bar) projected onto the
  //    DTO row so the snapshot exporter's `hot_uncovered` column is populated from
  //    the same rows the live surface serves. Additive; absent ⇒ pre-WP3 rollup. ──
  hotUncoveredCandidate?: boolean;
}

export interface FileHeatPageParams {
  lane?: AgentRoleLane;
  limit?: number;
  cursor?: string;
  /** WP-4A — which view to serve. `hot` (default) is the full activity ranking; the
   *  default hot view EXCLUDES operational-noise rows (build/vendor/test) unless
   *  `includeOperationalNoise`. `guidance-gaps` returns only guidance-gap candidates
   *  (uncovered ∧ workflow-level artifact ∧ repeated cross-stream — spec 273). */
  view?: 'hot' | 'guidance-gaps';
  /** WP-4A — filter to one path role (spec 260-271). */
  role?: PathRole;
  /** WP-4A — filter to one coverage bucket (e.g. `uncovered`). */
  coverage?: string;
  /** WP-4A — keep only rows with the given access mode present (reads/writes/executes > 0). */
  accessMode?: 'read' | 'write' | 'executed';
  /** WP-4A — include operational-noise rows in the default hot view (spec 271). Never
   *  deletes rows from diagnostics — only widens the default view. */
  includeOperationalNoise?: boolean;
  /** §5.6 legacy opt-in to widen past the caller's workspace. WP-4A: file-heat is now
   *  workspace-scoped at the query layer (`queryFileTouchesScoped`); this flag no longer
   *  changes the corpus and is retained only for back-compat (ignored). */
  allWorkspaces?: boolean;
}

/** The ONE canonical heat score for a DTO row (spec 273) — reuses the row's engine-stamped
 *  `score` when present so engine + DTO can never disagree; falls back to the canonical
 *  scorer for a pre-Phase-4 row that carries only raw counts. */
function scoreOf(r: Pick<FileHeatRowDTO, 'reads' | 'writes' | 'executes' | 'distinctStreams' | 'score'>): number {
  return r.score ?? canonicalHeatScore({ reads: r.reads, writes: r.writes, executes: r.executes, distinctStreams: r.distinctStreams });
}

/**
 * Build the `get_file_heat` page: redact each rollup path (§5.6 — scope prefix, no
 * username/drive, sensitive-dir collapse), classify/filter by role + coverage + access,
 * split the hot view from the guidance-gap view, and page it. WP-4A: the heat corpus is
 * now WORKSPACE-SCOPED at the query layer, so `scopeMeta.workspaceScoped` reflects
 * `result.meta.fileHeatScope` (the honest dropped/proxy disclosure), no longer a hardcoded
 * `false`. Rows are ranked by the ONE canonical score shared with the engine (spec 273).
 */
export function buildFileHeatPage(
  result: ContextOptimizerResult,
  roots: RedactionRoots,
  params: FileHeatPageParams,
): AgentDtoResponse<FileHeatRowDTO[]> {
  const generationId = computeGenerationId({
    proposalIds: result.proposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  const view = params.view ?? 'hot';
  const filtersHash = computeFiltersHash({
    lane: params.lane ?? null,
    view,
    role: params.role ?? null,
    coverage: params.coverage ?? null,
    accessMode: params.accessMode ?? null,
    includeOperationalNoise: params.includeOperationalNoise ?? false,
  });

  if (params.cursor) {
    const v = validateCursor(params.cursor, {
      route: FILE_HEAT_ROUTE, filtersHash, sort: FILE_HEAT_SORT, generationId });
    if (!v.ok) return errResponse(v.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }

  const allRows: FileHeatRowDTO[] = result.fileHeat.map((f) => {
    const redacted = redactRollupEntry(f, roots);
    return {
      ...redacted,
      lane: f.lane,
      coverage: f.coverage,
      reads: f.reads, writes: f.writes, executes: f.executes,
      distinctStreams: f.distinctStreams,
      uncovered: f.uncovered,
      ...(f.role ? { role: f.role } : {}),
      ...(f.roleReason ? { roleReason: f.roleReason } : {}),
      ...(f.operationalNoise !== undefined ? { operationalNoise: f.operationalNoise } : {}),
      ...(f.score !== undefined ? { score: f.score } : {}),
      ...(f.scoreComponents ? { scoreComponents: f.scoreComponents } : {}),
      ...(f.guidanceGapCandidate !== undefined ? { guidanceGapCandidate: f.guidanceGapCandidate } : {}),
      // WP6 (G6): pass the WP3 hot-uncovered flag through (never the full
      // coverageChecks predicate sweep — that stays engine-side, bounded).
      ...(f.hotUncoveredCandidate !== undefined ? { hotUncoveredCandidate: f.hotUncoveredCandidate } : {}),
    };
  });

  // Guidance-gap candidates + operational-noise counts are disclosed regardless of the
  // active view (spec 271: never hide, always count).
  const guidanceGapCandidates = allRows.filter((r) => r.guidanceGapCandidate).length;

  const accessOk = (r: FileHeatRowDTO): boolean => {
    if (!params.accessMode) return true;
    if (params.accessMode === 'read') return r.reads > 0;
    if (params.accessMode === 'write') return r.writes > 0;
    return r.executes > 0;   // 'executed'
  };

  // Apply the shared filters (lane / role / coverage / access) first.
  const filtered = allRows.filter((r) =>
    (!params.lane || r.lane === params.lane) &&
    (!params.role || r.role === params.role) &&
    (!params.coverage || r.coverage === params.coverage) &&
    accessOk(r));

  // View split. `guidance-gaps` ⇒ only candidates. `hot` ⇒ everything, minus operational
  // noise unless the caller opts in. Disclose how many noise rows the hot view hid.
  let operationalNoiseExcluded = 0;
  const rows = filtered.filter((r) => {
    if (view === 'guidance-gaps') return !!r.guidanceGapCandidate;
    if (r.operationalNoise && !params.includeOperationalNoise) { operationalNoiseExcluded++; return false; }
    return true;
  });

  // Stable sort: canonical score DESC, pathHash ASC.
  rows.sort((a, b) =>
    scoreOf(b) - scoreOf(a)
    || (a.pathHash < b.pathHash ? -1 : a.pathHash > b.pathHash ? 1 : 0));

  let afterIdx = 0;
  if (params.cursor) {
    const decoded = validateCursor(params.cursor, {
      route: FILE_HEAT_ROUTE, filtersHash, sort: FILE_HEAT_SORT, generationId });
    if (decoded.ok) {
      const [lastHeat, lastHash] = decoded.cursor.lastSortKey as [number, string];
      afterIdx = rows.findIndex((r) => {
        const h = scoreOf(r);
        return h < lastHeat || (h === lastHeat && r.pathHash > lastHash);
      });
      if (afterIdx < 0) afterIdx = rows.length;
    }
  }

  const limit = clampLimit(params.limit, AGENT_DTO_CAPS.file_heat.listDefault, AGENT_DTO_CAPS.file_heat.listMax);
  const slice = rows.slice(afterIdx, afterIdx + limit);
  const hasMore = afterIdx + limit < rows.length;

  const degraded = degradePayload({ items: slice as unknown as Record<string, unknown>[] });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  const finalRows = degraded.items as unknown as FileHeatRowDTO[];
  const warnings: AgentWarning[] = [...degraded.warnings];
  if (operationalNoiseExcluded > 0) {
    warnings.push({
      code: 'OPERATIONAL_NOISE_EXCLUDED',
      message: `${operationalNoiseExcluded} operational-noise row(s) (build-generated / dependency-or-vendor / `
        + 'test-or-fixture) are hidden from the default hot view. Pass includeOperationalNoise=true to see them; '
        + 'they remain counted in diagnostics.',
      details: { excluded: operationalNoiseExcluded },
    });
  }

  const last = finalRows[finalRows.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({
        v: 1, route: FILE_HEAT_ROUTE, filtersHash, sort: FILE_HEAT_SORT,
        lastSortKey: [scoreOf(last), last.pathHash],
        generationId, issuedAtMs: 0,
      })
    : undefined;

  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: rows.length === 0 ? 'empty' : 'ready',
    parityStatus: { verified: false, state: 'unverified-no-reference' },
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount: result.meta.unverifiedSuppressedCount,
    // WP-4A: population before/after ALL filters, and the honest workspace-scope flag —
    // now sourced from the scoped query's disclosure (result.meta.fileHeatScope), not a lie.
    scopeMeta: {
      appliedLane: params.lane ?? null,
      populationBeforeScope: result.fileHeat.length,
      populationAfterScope: rows.length,
      workspaceScoped: result.meta.fileHeatScope?.workspaceScoped ?? false,
    } satisfies AgentDtoScopeMeta,
    ...(result.meta.fileHeatScope ? { fileHeatScope: result.meta.fileHeatScope } : {}),
    fileHeatView: { view, operationalNoiseExcluded, guidanceGapCandidates },
  };
  const page: PageInfo = { limit, returned: finalRows.length, hasMore, nextCursor };
  return okResponse(finalRows, { meta, page, warnings });
}

export interface AnalyzabilityPageParams {
  lane?: AgentRoleLane;
  limit?: number;
  cursor?: string;
}

/**
 * R2 WP-4C — build the `get_context_optimizer_analyzability` page: the section-level,
 * deduped-by-section+laneSet analyzability diagnostic, redacted (never a raw path or
 * sectionKey), sorted by `trappedCostWeight` (= residentTokens × exposureTurns) DESC so an
 * agent invests detector effort where the most resident cost is trapped behind the blind
 * spot. GET-only + opaque-cursor paged, mirroring `buildFileHeatPage`.
 */
export function buildAnalyzabilityPage(
  result: ContextOptimizerResult,
  roots: RedactionRoots,
  params: AnalyzabilityPageParams,
): AgentDtoResponse<AnalyzabilityRowDTO[]> {
  const generationId = computeGenerationId({
    proposalIds: result.proposals.map((p) => p.id),
    fileHeatHashes: result.fileHeat.map((f) => f.pathHash),
  });
  const filtersHash = computeFiltersHash({ lane: params.lane ?? null });

  if (params.cursor) {
    const v = validateCursor(params.cursor, {
      route: ANALYZABILITY_ROUTE, filtersHash, sort: ANALYZABILITY_SORT, generationId });
    if (!v.ok) return errResponse(v.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }

  const diags = result.modelStats.analyzability ?? [];
  const trappedCostOf = (d: AnalyzabilityDiagnostic): number => d.residentTokens * d.exposureTurns;

  const rows: AnalyzabilityRowDTO[] = diags
    .filter((d) => !params.lane || d.lanes.includes(params.lane as AgentRoleLane))
    .map((d) => ({
      sectionId: createHash('sha256').update(d.sectionKey).digest('hex').slice(0, 16),
      source: redactFileHeatPath(d.source.absPath, roots),
      lanes: d.lanes,
      residentTokens: d.residentTokens,
      exposureTurns: d.exposureTurns,
      actionCount: d.actionCount,
      trappedCostWeight: trappedCostOf(d),
      reasons: d.reasons.map((r) => ({
        code: r.code, count: r.count,
        ...(r.suggestedDetector ? { suggestedDetector: r.suggestedDetector } : {}),
      })),
    }));

  // Stable sort: trappedCostWeight DESC, sectionId ASC (the §-273-style canonical order).
  rows.sort((a, b) =>
    b.trappedCostWeight - a.trappedCostWeight
    || (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0));

  let afterIdx = 0;
  if (params.cursor) {
    const decoded = validateCursor(params.cursor, {
      route: ANALYZABILITY_ROUTE, filtersHash, sort: ANALYZABILITY_SORT, generationId });
    if (decoded.ok) {
      const [lastWeight, lastId] = decoded.cursor.lastSortKey as [number, string];
      afterIdx = rows.findIndex((r) =>
        r.trappedCostWeight < lastWeight
        || (r.trappedCostWeight === lastWeight && r.sectionId > lastId));
      if (afterIdx < 0) afterIdx = rows.length;
    }
  }

  const limit = clampLimit(params.limit, AGENT_DTO_CAPS.context_optimizer_analyzability.listDefault,
    AGENT_DTO_CAPS.context_optimizer_analyzability.listMax);
  const slice = rows.slice(afterIdx, afterIdx + limit);
  const hasMore = afterIdx + limit < rows.length;

  const degraded = degradePayload({ items: slice as unknown as Record<string, unknown>[] });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  const finalRows = degraded.items as unknown as AnalyzabilityRowDTO[];
  const warnings: AgentWarning[] = [...degraded.warnings];

  const last = finalRows[finalRows.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({
        v: 1, route: ANALYZABILITY_ROUTE, filtersHash, sort: ANALYZABILITY_SORT,
        lastSortKey: [last.trappedCostWeight, last.sectionId],
        generationId, issuedAtMs: 0,
      })
    : undefined;

  const meta: Omit<AgentDtoMeta, 'approxTokens'> = {
    generatedAtIso: result.generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState: rows.length === 0 ? 'empty' : 'ready',
    parityStatus: { verified: false, state: 'unverified-no-reference' },
    insufficientExposureCount: insufficientExposureCountOf(result),
    notAnalyzableCount: result.modelStats.notAnalyzable.length,
    ...(notAnalyzableByReason(result) ? { notAnalyzableByReason: notAnalyzableByReason(result) } : {}),
    ...analyzabilityCodeMeta(result),
    unverifiedSuppressedCount: result.meta.unverifiedSuppressedCount,
    scopeMeta: {
      appliedLane: params.lane ?? null,
      populationBeforeScope: diags.length,
      populationAfterScope: rows.length,
    } satisfies AgentDtoScopeMeta,
  };
  const page: PageInfo = { limit, returned: finalRows.length, hasMore, nextCursor };
  return okResponse(finalRows, { meta, page, warnings });
}
