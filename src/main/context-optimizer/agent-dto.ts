// agent-dto.ts — WP7 agent-facing read-only surface. PURE, no IO.
//
// SPEC OF RECORD: plans/hardening-classifier-agent-surface.md §5 (envelope, cursor,
// caps, read-only guarantee) + §5.6 (privacy/redaction). This module holds only the
// deterministic projections + envelope/cursor/redaction mechanics; the four GET routes
// (api-server.ts) and the four observability MCP tools compose these. NOTHING here
// writes a DB row, mutates a file, marks-applied, or signs a derivation — the read-only
// guarantee (§5.4) is structural: there is no writer in this file.
//
// Test idiom: pure node:assert suite run under system node against dist —
//   npm run build:main
//   node dist/main/main/context-optimizer/agent-dto.test.js

import { createHash } from 'node:crypto';
import type {
  AgentRoleLane,
  AnalyzabilityReasonCode,
  BehaviorEvidenceTier,
  ContextOptimizerProposal,
  FileHeatRollupEntry,
  FileHeatScopeMeta,
  GrantMismatchVerdict,
  GuidanceOccurrence,
  ProposalActionability,
  ProposalAssetEvidence,
  ProposalBenefitModel,
  ProposalVerificationDTO,
  RecommendationDraft,
} from '../../shared/types';
import { proposalHasActionableContent } from '../../shared/context-optimizer-policy';

// ── §5.1 Response envelope + errors ─────────────────────────────────────────────

export type AgentDtoErrorCode =
  | 'INDEXING'
  | 'INVALID_ARGUMENT'
  | 'CURSOR_INVALID'
  | 'CURSOR_STALE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNVERIFIED'
  | 'DB_UNAVAILABLE'
  | 'LOG_IO_ERROR'
  | 'INTERNAL';

export interface AgentDtoError {
  code: AgentDtoErrorCode;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

export type AgentDtoDataState =
  | 'ready'
  | 'indexing'
  | 'empty'
  | 'insufficient-exposure'
  | 'unverified'
  // WP-D fix leg — honest empty reasons so a bare `[]` never reads as "unused".
  // The plan's three states plus `empty_out_of_scope` for the dominant skill-usage
  // cause (a workspace-scope artifact; data exists elsewhere). `empty_not_instrumented`
  // is reserved for a truly empty source table — NOT a scope/window artifact (WB-01).
  | 'empty_no_events'
  | 'empty_not_instrumented'
  | 'empty_outside_window'
  | 'empty_out_of_scope';

/** WP-D fix leg — typed warning codes emitted by `buildSkillUsagePage` for the honest
 *  empty states. `AgentWarning.code` stays a `string` (no pre-existing enum); this union
 *  is the compiler-checked source of truth at the emit sites. */
export type SkillUsageWarningCode =
  | 'SKILL_USAGE_NOT_INSTRUMENTED'
  | 'SKILL_USAGE_OUTSIDE_WINDOW'
  | 'SKILL_USAGE_NO_EVENTS'
  | 'SKILL_USAGE_SCOPED_OUT';

export interface AgentDtoParityStatus {
  verified: boolean;
  state: 'verified' | 'unverified' | 'stale' | 'mismatch' | 'unverified-no-reference';
  verifiedAsOf?: string;
  staleReasons?: string[];
}

/**
 * WP-1C — compact, cross-page analysis-health block. Prevents an honest LOCAL field
 * (e.g. `unverifiedSuppressedCount`) from being misread as whole-SYSTEM confidence: it
 * carries the coverage the analysis actually has, the policy/matcher versions that
 * produced the page, and a numeric `diagnostics` bag. HONESTY RULE: a component that is
 * not yet measurable is emitted as `null` with a `<name>Unmeasured` reason key in
 * `diagnostics` — NEVER a fabricated number. Returned only on page 1 of a list and on
 * detail responses (identical within one generation) to keep per-page tokens low.
 */
export interface AnalysisHealth {
  /** Fraction of hot files (file-heat rows) covered by guidance, ×100. `null` when there
   *  is no heat to measure (reason: `captureCoverageUnmeasured`). */
  captureCoveragePct: number | null;
  /** Per-workspace coverage. `null` today: the behavior corpus is lane-global, so there
   *  is no honest per-workspace denominator until Phase-2 lineage lands
   *  (reason: `workspaceCoverageUnmeasured`). */
  workspaceCoveragePct: number | null;
  /** Share of resident tokens the model could analyze. `null` today: `notAnalyzable` is
   *  action-counted, not token-weighted, so no honest token-weighted split exists
   *  (reason: `analyzableResidentTokenUnmeasured`). */
  analyzableResidentTokenPct: number | null;
  /** Numeric diagnostics + `<name>Unmeasured:1` reason flags for each null component. */
  diagnostics: Record<string, number>;
  policyVersion: string;
  matcherVersion: string;
}

/**
 * WP-1C — compact scope disclosure for the proposals and file-heat surfaces, mirroring
 * the shape the skill/tool-usage surfaces already return (`scopeMeta`): the population
 * before/after the query filter, the applied lane, and — for file-heat — an honest
 * `workspaceScoped` flag (the heat corpus is lane-global today).
 */
export interface AgentDtoScopeMeta {
  appliedLane: AgentRoleLane | null;
  /** Rows in the generation before the lane/kind/tier (or lever) filter. */
  populationBeforeScope: number;
  /** Rows remaining after the filter — the query-scoped population. */
  populationAfterScope: number;
  /** File-heat only: `false` because the behavior corpus feeding heat is lane-global,
   *  not workspace-scoped (see buildFileHeatPage). Omitted on the proposal surface. */
  workspaceScoped?: boolean;
}

export interface AgentDtoMeta {
  generatedAtIso: string;
  generationId: string;
  parserVersion: number;
  /** chars/4 over the serialized `data`, so an agent can budget its own context. */
  approxTokens: number;
  dataState: AgentDtoDataState;
  /** WP-D fix leg — one-line human reason accompanying a non-`ready` dataState (e.g.
   *  "5 rows exist but attribute to another workspace"). Optional; set for the honest
   *  empty states so an agent reads WHY a surface is empty, not just that it is. */
  dataStateReason?: string;
  parityStatus: AgentDtoParityStatus;
  indexing?: { ready: boolean; progress?: { filesDone: number; filesTotal: number } };
  insufficientExposureCount: number;
  notAnalyzableCount: number;
  /** WP-D fix leg — per-reason histogram of the `notAnalyzable` sections (the
   *  `UnobservableReason` enum label → count), promoted from the optimizer's already-
   *  computed `notAnalyzable[].label`. Lets an agent see WHY sections are not analyzable
   *  (dominant `unmatchable` prose vs `insufficient-exposure`), not just the total.
   *  Optional/omitted when there are none. */
  notAnalyzableByReason?: Record<string, number>;
  /** R2 WP-4C — histogram over the STABLE actionable reason `code`s
   *  (`AnalyzabilityReasonCode`), aggregated from the section-level `analyzability`
   *  diagnostic. Supersedes the coarse `notAnalyzableByReason` label histogram (retained
   *  above for back-compat) with the actionable taxonomy. Omitted when there are none. */
  notAnalyzableByReasonCode?: Record<string, number>;
  /** R2 WP-4C — distinct sections (deduped by section+laneSet) that are not analyzable,
   *  and the total rejected actions across them. Report BOTH counts (the section count is
   *  NOT the action count — a section can carry many rejected actions). Omitted when 0. */
  notAnalyzableSectionCount?: number;
  notAnalyzableActionCount?: number;
  /** §4.6 / §5.5: gate-governed + unverified proposals hidden from the actionable list
   *  but ALWAYS disclosed here — an agent must never conclude "nothing to optimize"
   *  while unverified candidates exist. */
  unverifiedSuppressedCount: number;
  /** WP-1C — compact scope disclosure (population before/after the query filter, applied
   *  lane, workspace-scope honesty). Present on list + file-heat metas; optional so the
   *  many literal-meta test builders need not all be updated at once. */
  scopeMeta?: AgentDtoScopeMeta;
  /** WP-1C — cross-page analysis-health block. Present on list PAGE 1 and detail
   *  responses only (identical within a generation) to keep later pages lean. */
  analysisHealth?: AnalysisHealth;
  /** WP-2A — per-diagnostic-kind + per-grant-mismatch-verdict histogram. Lets a
   *  defaults-only proposals call distinguish "0 rows because N candidates were
   *  suppressed" from "0 candidates detected". Present on list page 1 + detail; on
   *  detail it is scoped to the proposal's related diagnostics. Omitted when empty. */
  diagnosticCounts?: Record<string, number>;
  /** WP-2A — capped, redaction-safe grant-mismatch evaluation summaries (identifiers +
   *  verdicts + counts only — never raw section text). On list page 1 (all candidates,
   *  capped) and on detail (only the diagnostics whose `relatedProposalId` matches). */
  grantMismatchEvaluations?: GrantMismatchEvaluationSummary[];
  /** WP-4A (Phase 4) — the run-level workspace-scope disclosure for the file-heat corpus
   *  (dropped/proxy counts + tier breakdown), promoted verbatim from
   *  `result.meta.fileHeatScope`. Present on the file-heat surface once a scoped analyze
   *  ran; absent on a lane-global / pre-Phase-4 run (honest degrade). */
  fileHeatScope?: FileHeatScopeMeta;
  /** WP-4A — file-heat view disclosure: which view was served, how many operational-noise
   *  rows the default view excluded (never deleted — spec 271), and the guidance-gap count. */
  fileHeatView?: {
    view: 'hot' | 'guidance-gaps';
    operationalNoiseExcluded: number;
    guidanceGapCandidates: number;
  };
}

/** WP-2A — one capped grant-mismatch evaluation record for the DTO surface. Mirrors the
 *  engine's `ContextOptimizerDiagnostic` grant-mismatch-evaluation fields, redaction-safe
 *  by construction (identifiers, verdicts, counts — never resident section text). */
export interface GrantMismatchEvaluationSummary {
  verdict: GrantMismatchVerdict;
  lane: AgentRoleLane;
  relatedProposalId?: string;
  toolset?: string;
  resolvedToolset?: string;
  mentionedToolName?: string;
  resolutionConfidence?: 'code-name' | 'heading';
  candidateToolsets?: string[];
  tokenEstimate?: number;
  detail: string;
}

export interface AgentWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PageInfo {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export type AgentDtoResponse<T> =
  | { ok: true; data: T; page?: PageInfo; meta: AgentDtoMeta; warnings: AgentWarning[] }
  | { ok: false; error: AgentDtoError; meta?: Partial<AgentDtoMeta> };

/** chars/4 (§5.1/§5.3). Deterministic; measured over the serialized JSON of `data`. */
export function computeApproxTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data ?? null).length / 4);
}

export function okResponse<T>(
  data: T,
  opts: { meta: Omit<AgentDtoMeta, 'approxTokens'>; page?: PageInfo; warnings?: AgentWarning[] },
): AgentDtoResponse<T> {
  return {
    ok: true,
    data,
    page: opts.page,
    meta: { ...opts.meta, approxTokens: computeApproxTokens(data) },
    warnings: opts.warnings ?? [],
  };
}

export function errResponse(
  error: AgentDtoError,
  meta?: Partial<AgentDtoMeta>,
): AgentDtoResponse<never> {
  return { ok: false, error, meta };
}

// ── §5.2 Pagination (opaque cursor) ─────────────────────────────────────────────

export interface CursorV1 {
  v: 1;
  route: string;
  filtersHash: string;
  sort: string;
  lastSortKey: unknown[];
  generationId: string;
  issuedAtMs: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Stable hash of the filter params (NOT limit/cursor — those are pagination, not a
 *  filter). A cursor replayed against a different filter set → CURSOR_INVALID. */
export function computeFiltersHash(filters: Record<string, unknown>): string {
  const keys = Object.keys(filters).sort();
  const stable = keys.map((k) => [k, filters[k] ?? null]);
  return sha256(JSON.stringify(stable));
}

/** WP7 DTO projection version. Bumped when a summary/detail shape changes; folded into
 *  `generationId` so a shape change also invalidates in-flight cursors.
 *  v2 (WP-1A): `ProposalSummaryDTO` gained `evidenceState` + `evidenceRef`. */
export const AGENT_DTO_PARSER_VERSION = 2;

/**
 * Content-derived analysis identity (§5.2). Deliberately NOT time-derived: two
 * back-to-back analyze runs over an UNCHANGED corpus must yield the SAME generationId
 * so a cursor stays valid across pages; a real regeneration (corpus/config changed →
 * different proposal set) yields a NEW id → CURSOR_STALE (no silent skips). Fold in the
 * ordered proposal ids + fileHeat path hashes + parserVersion; never `generatedAtIso`.
 */
export function computeGenerationId(input: {
  parserVersion?: number;
  proposalIds?: string[];
  fileHeatHashes?: string[];
  extra?: unknown;
}): string {
  return sha256(JSON.stringify({
    v: input.parserVersion ?? AGENT_DTO_PARSER_VERSION,
    p: input.proposalIds ?? [],
    f: input.fileHeatHashes ?? [],
    e: input.extra ?? null,
  }));
}

export function encodeCursor(cursor: CursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Opaque decode — returns null on any malformed/tampered token (caller maps to
 *  CURSOR_INVALID). Never throws. */
export function decodeCursor(raw: string): CursorV1 | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const c = JSON.parse(json) as CursorV1;
    if (!c || c.v !== 1 || typeof c.route !== 'string' || typeof c.filtersHash !== 'string'
        || typeof c.sort !== 'string' || !Array.isArray(c.lastSortKey)
        || typeof c.generationId !== 'string') {
      return null;
    }
    return c;
  } catch {
    return null;
  }
}

export type CursorValidation =
  | { ok: true; cursor: CursorV1 }
  | { ok: false; error: AgentDtoError };

/**
 * Validate a replayed cursor against the current request context.
 *  - malformed / route|filters|sort mismatch → CURSOR_INVALID (agent must restart w/ new filters)
 *  - newer generationId (analysis regenerated between pages) → CURSOR_STALE (restart at page 1,
 *    no silent skips)
 */
export function validateCursor(
  raw: string,
  ctx: { route: string; filtersHash: string; sort: string; generationId: string },
): CursorValidation {
  const cursor = decodeCursor(raw);
  if (!cursor
      || cursor.route !== ctx.route
      || cursor.filtersHash !== ctx.filtersHash
      || cursor.sort !== ctx.sort) {
    return {
      ok: false,
      error: {
        code: 'CURSOR_INVALID',
        message: 'Cursor does not match the current route/filters/sort. Restart at page 1.',
        retriable: true,
      },
    };
  }
  if (cursor.generationId !== ctx.generationId) {
    return {
      ok: false,
      error: {
        code: 'CURSOR_STALE',
        message: 'Analysis was regenerated since this cursor was issued. Restart at page 1 to avoid skips.',
        retriable: true,
        details: { issuedGenerationId: cursor.generationId, currentGenerationId: ctx.generationId },
      },
    };
  }
  return { ok: true, cursor };
}

/** Clamp a requested `limit` to [1, max], defaulting when absent/NaN. */
export function clampLimit(requested: number | undefined, def: number, max: number): number {
  if (requested === undefined || Number.isNaN(requested)) return def;
  return Math.max(1, Math.min(Math.floor(requested), max));
}

// ── §5.3 Per-tool caps + lean-list / detail split ───────────────────────────────

export const AGENT_DTO_CAPS = {
  skill_usage: { listDefault: 25, listMax: 100, timelineMax: 100 },
  agent_knowledge: { listDefault: 100, listMax: 300, citationsPerNodeMax: 2 },
  improvement_proposals: { listDefault: 20, listMax: 50, evidenceRefsMax: 3 },
  context_optimizer_proposals: { listDefault: 20, listMax: 50, citationsMax: 5, phraseTermsMax: 10, evidenceSamplesMax: 10 },
  file_heat: { listDefault: 20, listMax: 100 },
  // R2 WP-4C — the capped section-level analyzability detail route (sorted by
  // residentTokens × exposureTurns), directing detector investment at the largest
  // trapped-cost blind spots.
  context_optimizer_analyzability: { listDefault: 20, listMax: 100 },
  // WP-C / P2 — the lean MCP-tool-usage rollup. Top-N tools, a capped tool×lane
  // cross-tab, and a capped timeline keep the default payload ≤ ~15k chars (measured;
  // full per-session detail moves behind an explicit param).
  mcp_tool_usage: { topTools: 15, laneCells: 25, timelineMax: 60 },
} as const;

/**
 * Lean list projection of a ContextOptimizerProposal (§5.3). Deliberately carries NO
 * citations array, NO patch, NO snippets, NO fileHeat — those come from the detail
 * route (`get_context_optimizer_proposal?id=`). Serving the full panel DTO in a list
 * blows agent token budgets (finding K).
 */
export interface ProposalSummaryDTO {
  id: string;
  kind: ContextOptimizerProposal['kind'];
  title: string;
  lane?: AgentRoleLane;
  occurrence: GuidanceOccurrence;
  confidence: BehaviorEvidenceTier;
  actionability: ProposalActionability;
  /** WP-B1: concrete target that is not hash-only noise (shared policy helper). Primary
   *  default-sort key so agent-actionable proposals land on page 1. */
  hasActionableContent: boolean;
  residentTokenDelta: { estimate: number };
  tokenTurnsWeight: number;
  exposure: { turns: number; streams: number; slugs: number };
  verification: ProposalVerificationDTO;
  requiresDerivationGate: boolean;
  citationCount: number;
  hasPatch: boolean;
  hasPhraseGap: boolean;
  // WP-1A (Priority 0) — the fail-closed audit state for a `never` verdict, surfaced
  // on the LEAN row so an agent can tell an auditable subtract from a legacy/partial
  // one before drilling. `evidenceRef` (== id) is the key for the evidence drill route.
  evidenceState: ContextOptimizerProposal['evidenceState'];
  evidenceRef?: string;
  // R2 WP-3 (Priority 1) — asset-backed coverage/recency for a resident-asset subtract
  // (skill-advertisement). Additive + optional (present only on asset-derived rows), so
  // no `AGENT_DTO_PARSER_VERSION` bump. Lets an agent read coverage/recency + the
  // approximate-exposure disclosure on the LEAN row before drilling into the detail view.
  assetEvidence?: ProposalAssetEvidence;
  // R2 WP-4B (Phase 4) — improve-lever benefit magnitude (orders WITHIN a confidence
  // tier), the exemplar-drill key for a drillable hash-only cluster rollup, and the lean
  // rollup summary itself (capped OPAQUE member refs + top-K + counts — already
  // redaction-safe by construction, so copied straight from `target.rollup`, NOT routed
  // through `redactRollupEntry`, which is the unrelated file-heat path). All additive +
  // optional — present only on the rows that carry them; no parser-version bump.
  benefitModel?: ProposalBenefitModel;
  clusterExemplarRef?: string;
  rollup?: NonNullable<ContextOptimizerProposal['target']['rollup']>;
  // WP3 (G3) — template-constrained, human-review-required recommendation draft with
  // joinable same-surface evidence. Additive + optional (present only on ADD rows
  // that carry one); no parser-version bump. v2-OPTIONAL in the snapshot under
  // capability 'recommendation-drafts'.
  recommendationDraft?: RecommendationDraft;
}

export function toProposalSummary(p: ContextOptimizerProposal): ProposalSummaryDTO {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    lane: p.target.lane ?? p.attribution.lane,
    occurrence: p.occurrence,
    confidence: p.confidence,
    actionability: p.actionability,
    hasActionableContent: proposalHasActionableContent(p),
    residentTokenDelta: { estimate: p.residentTokenDelta.estimate },
    tokenTurnsWeight: p.tokenTurnsWeight,
    exposure: { turns: p.exposure.turns, streams: p.exposure.streams, slugs: p.exposure.slugs },
    verification: p.verification,
    requiresDerivationGate: p.verification.requiresDerivationGate,
    citationCount: p.citations.length,
    hasPatch: Boolean(p.proposedEdit?.patch),
    hasPhraseGap: Boolean(p.phraseGap && p.phraseGap.terms.length > 0),
    evidenceState: p.evidenceState,
    ...(p.evidenceRef ? { evidenceRef: p.evidenceRef } : {}),
    ...(p.assetEvidence ? { assetEvidence: p.assetEvidence } : {}),
    ...(p.benefitModel ? { benefitModel: p.benefitModel } : {}),
    ...(p.clusterExemplarRef ? { clusterExemplarRef: p.clusterExemplarRef } : {}),
    ...(p.target.rollup ? { rollup: p.target.rollup } : {}),
    ...(p.recommendationDraft ? { recommendationDraft: p.recommendationDraft } : {}),
  };
}

// ── §5.6 Privacy — sensitivity (derived, NOT stored) ────────────────────────────

/** §5.6: sensitivity is DERIVED from source_kind, never a stored column on
 *  `trigger_snippets`. Raw snippets from these sources are suppressed even under
 *  `includeSnippets=true`, and the MCP tool ignores any request to include them. */
export const SENSITIVE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'user_message',
  'supervisor_brief',
  'subagent_brief',
]);

export function isSensitive(sourceKind: string | undefined | null): boolean {
  return sourceKind != null && SENSITIVE_SOURCE_KINDS.has(sourceKind);
}

// ── §5.6 Privacy — fileHeat path redaction ──────────────────────────────────────

export type FileHeatPathScope = 'workspace' | 'dashboard' | 'skill' | 'home' | 'external';

export interface FileHeatPath {
  pathDisplay: string;
  pathHash: string; // sha256(canonical abs path)
  pathScope: FileHeatPathScope;
  /** UI/IPC-only. NEVER populated on the MCP/API path (would leak username/drive). */
  absPath?: string;
}

/** R2 WP-4C — lean, redaction-safe projection of an `AnalyzabilityDiagnostic` for the
 *  capped `get_context_optimizer_analyzability` detail route. NEVER carries the raw
 *  `sectionKey` or `absPath` (both can embed username/drive): `sectionId` is an opaque
 *  stable hash and `source` is the redacted `FileHeatPath`. Sorted by `trappedCostWeight`
 *  (= residentTokens × exposureTurns) DESC so detector investment targets the biggest
 *  blind spots. */
export interface AnalyzabilityRowDTO {
  sectionId: string;
  source: FileHeatPath;
  lanes: AgentRoleLane[];
  residentTokens: number;
  exposureTurns: number;
  actionCount: number;
  trappedCostWeight: number;
  reasons: Array<{ code: AnalyzabilityReasonCode; count: number; suggestedDetector?: string }>;
}

/** Roots used to scope + redact a path. All compared case-insensitively with forward
 *  slashes (matches file-coverage `normPath`: LOWER + '/'). `skillRoots` maps a skill
 *  root prefix → the skill name for the `$SKILL/<skillName>/<rel>` form. */
export interface RedactionRoots {
  workspaceRoot?: string;
  dashboardRoot?: string;
  homeDir?: string;
  skillRoots?: Array<{ root: string; skillName: string }>;
}

const SENSITIVE_HOME_DIRS = ['.ssh', '.aws', '.gnupg'];

function normSlash(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function basename(p: string): string {
  const parts = normSlash(p).split('/');
  return parts[parts.length - 1] || p;
}

/** rel of `abs` under `root` (forward-slash, no leading slash), or null if not under. */
function relUnder(absLower: string, root: string | undefined): string | null {
  if (!root) return null;
  const r = normSlash(root).toLowerCase();
  if (absLower === r) return '';
  if (absLower.startsWith(r + '/')) return absLower.slice(r.length + 1);
  return null;
}

/** The other spelling of the workspace state-dir root (`…/.lares` ↔
 *  `…/.dashboard`). File-heat paths come from HISTORICAL activity rows, which
 *  permanently carry whichever name was live when they were recorded — both
 *  must scope to `$DASHBOARD`, never leak into `$WORKSPACE`. */
function legacyStateRootSibling(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const n = normSlash(root).toLowerCase();
  if (n.endsWith('/.lares')) return n.slice(0, -'.lares'.length) + '.dashboard';
  if (n.endsWith('/.dashboard')) return n.slice(0, -'.dashboard'.length) + '.lares';
  return undefined;
}

/**
 * Redact a canonical absolute path into a scoped, username/drive-free display (§5.6).
 * Most-specific root wins: skill → dashboard → workspace → home → external. Sensitive
 * home dirs (`.ssh`/`.aws`/`.gnupg`) collapse to `~/<dir>/<basename>`; external paths
 * drop the drive/prefix entirely to `external/<basename>`.
 *
 * `pathHash` is reused from the rollup entry when supplied (already sha256 of the
 * canonical path); otherwise computed here. NEVER emits username or drive.
 */
export function redactFileHeatPath(
  absPath: string,
  roots: RedactionRoots,
  precomputedHash?: string,
): FileHeatPath {
  const abs = normSlash(absPath);
  const absLower = abs.toLowerCase();
  const pathHash = precomputedHash ?? sha256(abs);

  // Most-specific first.
  for (const { root, skillName } of roots.skillRoots ?? []) {
    const rel = relUnder(absLower, root);
    if (rel !== null) {
      return { pathDisplay: rel ? `$SKILL/${skillName}/${rel}` : `$SKILL/${skillName}`, pathHash, pathScope: 'skill' };
    }
  }
  const dashRel = relUnder(absLower, roots.dashboardRoot)
    ?? relUnder(absLower, legacyStateRootSibling(roots.dashboardRoot));
  if (dashRel !== null) {
    return { pathDisplay: dashRel ? `$DASHBOARD/${dashRel}` : '$DASHBOARD', pathHash, pathScope: 'dashboard' };
  }
  const wsRel = relUnder(absLower, roots.workspaceRoot);
  if (wsRel !== null) {
    return { pathDisplay: wsRel ? `$WORKSPACE/${wsRel}` : '$WORKSPACE', pathHash, pathScope: 'workspace' };
  }
  const homeRel = relUnder(absLower, roots.homeDir);
  if (homeRel !== null) {
    const firstSeg = homeRel.split('/')[0];
    if (SENSITIVE_HOME_DIRS.includes(firstSeg)) {
      return { pathDisplay: `~/${firstSeg}/${basename(absLower)}`, pathHash, pathScope: 'home' };
    }
    return { pathDisplay: homeRel ? `~/${homeRel}` : '~', pathHash, pathScope: 'home' };
  }
  // External: never expose username or drive — basename only.
  return { pathDisplay: `external/${basename(absLower)}`, pathHash, pathScope: 'external' };
}

/** Redact a FileHeatRollupEntry's path into a FileHeatPath, reusing its precomputed
 *  `pathHash`. The rollup's `pathDisplay` is the normalized canonical path (§2.3). */
export function redactRollupEntry(entry: FileHeatRollupEntry, roots: RedactionRoots): FileHeatPath {
  return redactFileHeatPath(entry.pathDisplay, roots, entry.pathHash);
}

// ── §5.3 Byte-cap degradation ───────────────────────────────────────────────────

/** MCP hard cap on a serialized response (§5.3). A page over this is degraded by
 *  trimming optional fields in a fixed order, then shrinking `limit`, then
 *  PAYLOAD_TOO_LARGE — NEVER a silent mid-list drop. */
export const MCP_RESPONSE_MAX_BYTES = 96 * 1024;

/** A degradable page item. Optional evidence fields are trimmed in the §5.3 order.
 *  Callers hand detail-shaped records here (list rows have no snippet/patch anyway). */
export interface DegradableItem {
  snippet?: unknown;
  snippets?: unknown;
  patch?: unknown;
  proposedEdit?: { summary?: string; patch?: unknown };
  citations?: unknown[];
  [k: string]: unknown;
}

export interface DegradeInput {
  items: DegradableItem[];
  fileHeatTail?: unknown[];
  maxBytes?: number;
  minLimit?: number;
  /** Serialized alongside items+fileHeatTail to measure the true response size. */
  envelopeOverhead?: unknown;
}

export type DegradeResult =
  | {
      ok: true;
      items: DegradableItem[];
      fileHeatTail: unknown[];
      warnings: AgentWarning[];
      appliedSteps: string[];
    }
  | { ok: false; error: AgentDtoError };

function measure(items: unknown[], fileHeatTail: unknown[], overhead: unknown): number {
  return Buffer.byteLength(JSON.stringify({ items, fileHeatTail, overhead: overhead ?? null }), 'utf8');
}

/**
 * Degrade a page to fit `maxBytes` (§5.3). Trim order:
 *   snippets → patches → extra citations → fileHeat tail → shrink limit → PAYLOAD_TOO_LARGE.
 * Each step applies uniformly across ALL items (never a silent mid-list drop); shrinking
 * `limit` pops whole items from the TAIL only. If still over at `minLimit`, returns
 * PAYLOAD_TOO_LARGE with a suggested smaller `limit`.
 */
export function degradePayload(input: DegradeInput): DegradeResult {
  const maxBytes = input.maxBytes ?? MCP_RESPONSE_MAX_BYTES;
  const minLimit = input.minLimit ?? 1;
  const warnings: AgentWarning[] = [];
  const appliedSteps: string[] = [];
  // Deep-ish clone so we never mutate the caller's objects.
  let items: DegradableItem[] = input.items.map((it) => ({ ...it }));
  let fileHeatTail: unknown[] = input.fileHeatTail ? [...input.fileHeatTail] : [];

  const fits = () => measure(items, fileHeatTail, input.envelopeOverhead) <= maxBytes;
  if (fits()) return { ok: true, items, fileHeatTail, warnings, appliedSteps };

  // 1. snippets
  items = items.map((it) => {
    const { snippet: _s, snippets: _ss, ...rest } = it;
    if ('proposedEdit' in rest && rest.proposedEdit) {
      // keep proposedEdit for the patch step
    }
    return rest as DegradableItem;
  });
  appliedSteps.push('snippets');
  warnings.push({ code: 'DEGRADED_SNIPPETS', message: 'Evidence snippets omitted to fit the response byte cap.' });
  if (fits()) return { ok: true, items, fileHeatTail, warnings, appliedSteps };

  // 2. patches
  items = items.map((it) => {
    const { patch: _p, ...rest } = it;
    if (rest.proposedEdit && typeof rest.proposedEdit === 'object') {
      const { patch: _pp, ...pe } = rest.proposedEdit as Record<string, unknown>;
      rest.proposedEdit = pe as DegradableItem['proposedEdit'];
    }
    return rest as DegradableItem;
  });
  appliedSteps.push('patches');
  warnings.push({ code: 'DEGRADED_PATCHES', message: 'Proposed-edit patches omitted to fit the response byte cap.' });
  if (fits()) return { ok: true, items, fileHeatTail, warnings, appliedSteps };

  // 3. extra citations
  items = items.map((it) => {
    if (Array.isArray(it.citations) && it.citations.length > 0) {
      return { ...it, citations: [] as unknown[] };
    }
    return it;
  });
  appliedSteps.push('citations');
  warnings.push({ code: 'DEGRADED_CITATIONS', message: 'Extra citations omitted to fit the response byte cap; use the detail route.' });
  if (fits()) return { ok: true, items, fileHeatTail, warnings, appliedSteps };

  // 4. fileHeat tail
  if (fileHeatTail.length > 0) {
    fileHeatTail = [];
    appliedSteps.push('fileHeatTail');
    warnings.push({ code: 'DEGRADED_FILEHEAT', message: 'fileHeat tail omitted; use get_file_heat.' });
    if (fits()) return { ok: true, items, fileHeatTail, warnings, appliedSteps };
  }

  // 5. shrink limit — pop whole items from the tail only (never a mid-list hole).
  while (items.length > minLimit) {
    items = items.slice(0, items.length - 1);
    if (!appliedSteps.includes('shrinkLimit')) appliedSteps.push('shrinkLimit');
    if (fits()) {
      warnings.push({
        code: 'DEGRADED_LIMIT',
        message: `Page truncated to ${items.length} items to fit the response byte cap; page again for the rest.`,
        details: { returned: items.length },
      });
      return { ok: true, items, fileHeatTail, warnings, appliedSteps };
    }
  }

  // 6. still over at minLimit → PAYLOAD_TOO_LARGE
  return {
    ok: false,
    error: {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'A single item exceeds the response byte cap. Request the detail route for this id, or a smaller limit.',
      retriable: true,
      details: { suggestedLimit: Math.max(1, minLimit), maxBytes, appliedSteps },
    },
  };
}
