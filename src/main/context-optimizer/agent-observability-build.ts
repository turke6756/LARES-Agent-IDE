// agent-observability-build.ts — WP7 page builders for the SKILL-USAGE and
// AGENT-KNOWLEDGE observability surfaces (PURE, no IO).
//
// Sibling to agent-dto-build.ts (which owns the context-optimizer proposal + file-heat
// surfaces). These two surfaces are backed by DIFFERENT read layers —
// `querySkillUsage(db, q)` (WP3, skill-analytics/queries.ts → SkillUsageResult) and
// `runKnowledgeExtract(workspaceId, agentId)` (WP4, agent-knowledge → AgentKnowledgeGraph)
// — so they live here rather than reshaping agent-dto-build's optimizer-result builders.
// Both project to LEAN summary rows + a detail-on-demand sibling, ride the shared
// AgentDtoResponse envelope, and reuse the cursor/degrade/redaction mechanics from
// agent-dto.ts. READ-ONLY: nothing here writes.
//
// Test: node dist/main/main/context-optimizer/agent-dto-observability.test.js

import { createHash } from 'node:crypto';
import type {
  AgentKnowledgeGraph,
  KnowledgeBehaviorEvidence,
  KnowledgeFileReferenceStats,
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeSourceRole,
  McpToolUsageResult,
  McpToolUsageRollupDTO,
  SkillContextSample,
  SkillCostRollup,
  SkillEffectiveness,
  SkillMostUsedRow,
  SkillTimelineRow,
  SkillUsageResult,
} from '../../shared/types';
import { coverageBand, nextDrillHint } from './attribution';
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
  validateCursor,
  type AgentDtoDataState,
  type AgentDtoMeta,
  type AgentDtoResponse,
  type AgentWarning,
  type FileHeatPath,
  type PageInfo,
  type RedactionRoots,
  type SkillUsageWarningCode,
} from './agent-dto';

// ── shared meta helpers ──────────────────────────────────────────────────────────
//
// Skill-usage and agent-knowledge have no parity/derivation gate (they are direct
// rollups over parse/scaffold data, not gate-governed optimizer proposals). So parity
// is a constant `unverified-no-reference` and the gate-only counts are 0.
function readyMeta(
  generatedAtIso: string,
  generationId: string,
  dataState: AgentDtoMeta['dataState'],
): Omit<AgentDtoMeta, 'approxTokens'> {
  return {
    generatedAtIso,
    generationId,
    parserVersion: AGENT_DTO_PARSER_VERSION,
    dataState,
    parityStatus: { verified: false, state: 'unverified-no-reference' },
    insufficientExposureCount: 0,
    notAnalyzableCount: 0,
    unverifiedSuppressedCount: 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════
// SKILL USAGE  (get_skill_usage 25/100, timeline ≤100  +  get_skill_usage_detail?id=)
// ══════════════════════════════════════════════════════════════════════════════════

const SKILL_USAGE_ROUTE = 'get_skill_usage';
const SKILL_USAGE_SORT = 'count DESC, id ASC';

/** Lean per-skill summary row (list). id === skill so the detail route resolves by id.
 *  Effectiveness + cost are folded in as scalar fields; NO per-window arrays here (the
 *  detail route carries those). */
export interface SkillUsageSummaryDTO {
  id: string;
  skill: string;
  count: number;
  avgEffectiveness: number | null;
  lastUsedMs: number | null;
  observableScore: number | null;
  scoredInvocations: number;
  freshMedian: number;
  cacheReadMedian: number;
}

export interface SkillUsagePage {
  skills: SkillUsageSummaryDTO[];
  /** Most-recent timeline rows, globally capped at `timelineMax` (§5.3). Trimmed FIRST
   *  under byte pressure (never a silent mid-list drop of the skills page). */
  timeline: SkillTimelineRow[];
  timelineTruncated: boolean;
}

export interface SkillUsagePageParams {
  limit?: number;
  cursor?: string;
}

function skillDigest(result: SkillUsageResult): string {
  // Content-derived (NOT generatedAtIso) so a cursor stays valid across two calls over
  // an unchanged corpus; a real change in counts yields a new id → CURSOR_STALE.
  return computeGenerationId({
    extra: {
      route: SKILL_USAGE_ROUTE,
      rows: [...result.mostUsed].sort((a, b) => (a.skill < b.skill ? -1 : 1))
        .map((r) => [r.skill, r.count, r.lastUsedMs]),
    },
  });
}

function mergeSkillRow(
  m: SkillMostUsedRow,
  eff: SkillEffectiveness | undefined,
  cost: SkillCostRollup | undefined,
): SkillUsageSummaryDTO {
  return {
    id: m.skill,
    skill: m.skill,
    count: m.count,
    avgEffectiveness: m.avgEffectiveness,
    lastUsedMs: m.lastUsedMs,
    observableScore: eff?.observableScore ?? null,
    scoredInvocations: eff?.scoredInvocations ?? 0,
    freshMedian: cost?.freshMedian ?? 0,
    cacheReadMedian: cost?.cacheReadMedian ?? 0,
  };
}

/** WP-D fix leg — typed skill-usage warning (compiler-checks the code against the
 *  union so the emit sites can't drift from the schema). */
function skillWarn(code: SkillUsageWarningCode, message: string, details?: Record<string, unknown>): AgentWarning {
  return { code, message, ...(details ? { details } : {}) };
}

/** WP-D fix leg — classify an EMPTY skill-usage page into an HONEST dataState +
 *  one-line reason + typed warning, so a bare `[]` never reads as "skills unused."
 *  Returns null when rows exist (caller uses 'ready'). Priority: indexing (fresh
 *  install, no marker yet) > scoped-out (data exists, none in this workspace) >
 *  not-instrumented (truly empty table) > outside-window > no-events. */
function classifySkillUsageEmpty(
  result: SkillUsageResult,
  indexing: boolean,
): { dataState: AgentDtoDataState; reason: string; warning?: AgentWarning } {
  const sm = result.scopeMeta;
  if (indexing) {
    return {
      dataState: 'indexing',
      reason: 'The skill index is still building on this machine; retry shortly.',
    };
  }
  const dropped = sm.droppedUnattributedCount ?? 0;
  const scoped = sm.appliedWorkspaceId != null && sm.appliedWorkspaceId !== '';
  const hasAny = sm.hasAnyInvocations ?? false;
  // Scoped-out: a workspace scope excluded everything while the corpus is non-empty.
  // This is the dominant get_skill_usage cause (workspace_root is NULL → agents-join
  // attributes few rows). NEVER mislabel it 'not_instrumented' (WB-01).
  if (scoped && hasAny) {
    const note = dropped > 0
      ? ` ${dropped} invocation${dropped === 1 ? '' : 's'} attribute to no workspace (session-based attribution) and are excluded by this scope.`
      : '';
    return {
      dataState: 'empty_out_of_scope',
      reason: `No skill invocations attribute to this workspace, but the corpus is not empty.${note}`,
      warning: skillWarn('SKILL_USAGE_SCOPED_OUT',
        'Skill invocations exist but none attribute to the requested workspace scope.',
        { droppedUnattributedCount: dropped, appliedWorkspaceId: sm.appliedWorkspaceId }),
    };
  }
  // Truly empty table — the ONLY honest "not instrumented" case.
  if (!hasAny) {
    return {
      dataState: 'empty_not_instrumented',
      reason: 'No skill invocations have been recorded yet.',
      warning: skillWarn('SKILL_USAGE_NOT_INSTRUMENTED',
        'The skill_invocations table is empty — no skill usage has been parsed.'),
    };
  }
  if (sm.windowSinceMs != null || sm.windowUntilMs != null) {
    return {
      dataState: 'empty_outside_window',
      reason: 'No skill invocations fall inside the selected time window.',
      warning: skillWarn('SKILL_USAGE_OUTSIDE_WINDOW',
        'Skill invocations exist, but none inside the selected time window.'),
    };
  }
  return {
    dataState: 'empty_no_events',
    reason: 'No skill invocations match the current filters.',
    warning: skillWarn('SKILL_USAGE_NO_EVENTS', 'No skill invocations match the current filters.'),
  };
}

export function buildSkillUsagePage(
  result: SkillUsageResult,
  params: SkillUsagePageParams,
  // WP-D fix leg — `indexing:true` when the MCP route found the backfill marker unset
  // (fresh install), so the surface reads 'indexing', not a misleading empty.
  opts: { indexing?: boolean } = {},
): AgentDtoResponse<SkillUsagePage> {
  const generationId = skillDigest(result);
  const filtersHash = computeFiltersHash({});
  if (params.cursor) {
    const v = validateCursor(params.cursor, { route: SKILL_USAGE_ROUTE, filtersHash, sort: SKILL_USAGE_SORT, generationId });
    if (!v.ok) return errResponse(v.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }

  const effBySkill = new Map(result.effectiveness.map((e) => [e.skill, e]));
  const costBySkill = new Map(result.cost.map((c) => [c.skill, c]));
  const rows = result.mostUsed.map((m) => mergeSkillRow(m, effBySkill.get(m.skill), costBySkill.get(m.skill)));
  // Stable sort: count DESC, skill (id) ASC.
  rows.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let afterIdx = 0;
  if (params.cursor) {
    const decoded = validateCursor(params.cursor, { route: SKILL_USAGE_ROUTE, filtersHash, sort: SKILL_USAGE_SORT, generationId });
    if (decoded.ok) {
      const [lastCount, lastId] = decoded.cursor.lastSortKey as [number, string];
      afterIdx = rows.findIndex((r) => r.count < lastCount || (r.count === lastCount && r.id > lastId));
      if (afterIdx < 0) afterIdx = rows.length;
    }
  }

  const caps = AGENT_DTO_CAPS.skill_usage;
  const limit = clampLimit(params.limit, caps.listDefault, caps.listMax);
  const slice = rows.slice(afterIdx, afterIdx + limit);
  const hasMore = afterIdx + limit < rows.length;

  // Most-recent timeline, capped at timelineMax. Passed as the degrade tail so it is
  // trimmed before the skills page under byte pressure.
  const timelineFull = [...result.timeline].sort((a, b) => b.tsMs - a.tsMs);
  const timeline = timelineFull.slice(0, caps.timelineMax);
  const timelineTruncated = result.timelineTruncated || timelineFull.length > caps.timelineMax;

  const degraded = degradePayload({
    items: slice as unknown as Record<string, unknown>[],
    fileHeatTail: timeline,
  });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  const finalSkills = degraded.items as unknown as SkillUsageSummaryDTO[];
  const finalTimeline = degraded.fileHeatTail as SkillTimelineRow[];

  const last = finalSkills[finalSkills.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ v: 1, route: SKILL_USAGE_ROUTE, filtersHash, sort: SKILL_USAGE_SORT,
        lastSortKey: [last.count, last.id], generationId, issuedAtMs: 0 })
    : undefined;

  const data: SkillUsagePage = {
    skills: finalSkills,
    timeline: finalTimeline,
    timelineTruncated: timelineTruncated || finalTimeline.length < timeline.length,
  };
  // WP-D fix leg — honest empty state. An empty page never emits a bare 'empty'; it
  // carries an explanatory dataState + dataStateReason + a typed warning distinguishing
  // scoped-out vs no-events vs not-yet-indexed vs outside-window.
  const empty = rows.length === 0 ? classifySkillUsageEmpty(result, opts.indexing ?? false) : null;
  const baseMeta = readyMeta(result.generatedAtIso, generationId, empty?.dataState ?? 'ready');
  const meta = empty ? { ...baseMeta, dataStateReason: empty.reason } : baseMeta;
  const warnings = empty?.warning ? [...degraded.warnings, empty.warning] : degraded.warnings;
  const page: PageInfo = { limit, returned: finalSkills.length, hasMore, nextCursor };
  return okResponse(data, { meta, page, warnings });
}

export interface SkillUsageDetail {
  skill: string;
  summary: SkillUsageSummaryDTO;
  effectiveness: SkillEffectiveness | null;
  cost: SkillCostRollup | null;
  timeline: SkillTimelineRow[];
  contextSamples: SkillContextSample[];
}

export function buildSkillUsageDetail(
  result: SkillUsageResult,
  id: string,
): AgentDtoResponse<SkillUsageDetail> {
  const generationId = skillDigest(result);
  const m = result.mostUsed.find((r) => r.skill === id);
  if (!m) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No skill '${id}' in this generation.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const eff = result.effectiveness.find((e) => e.skill === id) ?? null;
  const cost = result.cost.find((c) => c.skill === id) ?? null;
  const caps = AGENT_DTO_CAPS.skill_usage;
  const timeline = result.timeline.filter((t) => t.skill === id)
    .sort((a, b) => b.tsMs - a.tsMs).slice(0, caps.timelineMax);
  const contextSamples = result.contextSamples.filter((s) => s.skill === id);
  const data: SkillUsageDetail = {
    skill: id,
    summary: mergeSkillRow(m, eff ?? undefined, cost ?? undefined),
    effectiveness: eff,
    cost,
    timeline,
    contextSamples,
  };
  const meta = readyMeta(result.generatedAtIso, generationId, 'ready');
  return okResponse(data, { meta });
}

// ══════════════════════════════════════════════════════════════════════════════════
// AGENT KNOWLEDGE  (get_agent_knowledge 100/300, citations/node ≤2  +  ..._detail?id=)
// ══════════════════════════════════════════════════════════════════════════════════

const KNOWLEDGE_ROUTE = 'get_agent_knowledge';
const KNOWLEDGE_SORT = 'id ASC';
const KNOWLEDGE_DETAIL_MAX_CHARS = 240;

/** Redacted citation for a knowledge node (path scoped, no username/drive per §5.6). */
export interface KnowledgeCitationDTO {
  pathDisplay: string;
  pathScope: FileHeatPath['pathScope'];
  line: number;
}

/** Lean typed node row. `detail` is truncated for the list; the detail route carries
 *  the full text. `citations` is the node's source location(s), capped at 2 (§5.3). */
export interface AgentKnowledgeNodeDTO {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  detail?: string;
  citations: KnowledgeCitationDTO[];
  sourceScope?: string;
  // WP8 — the CLAUDE.md ⇄ behavior linkage reaches agents here.
  sourceRole?: KnowledgeSourceRole;
  sourceSpan?: { lineStart: number; lineEnd: number };
  behavior?: KnowledgeBehaviorEvidence;
  fileReferenceStats?: KnowledgeFileReferenceStats;
  // WP2 (G2): the owning guidance source's provider audience ('unknown' is the
  // explicit disclosed state). Present only on nodes from audience-tagged sources.
  audienceProviders?: string[] | 'unknown';
}

export interface AgentKnowledgePage {
  agentId: string;
  agentName: string;
  nodes: AgentKnowledgeNodeDTO[];
  sourceFileCount: number;
}

export interface AgentKnowledgePageParams {
  limit?: number;
  cursor?: string;
}

/** Deterministic stable id for a node (content-derived; NOT positional). */
function nodeId(n: KnowledgeNode): string {
  return createHash('sha256')
    .update(`${n.type} ${n.source.absPath} ${n.source.lineStart} ${n.label}`)
    .digest('hex').slice(0, 16);
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function citationsFor(n: KnowledgeNode, roots: RedactionRoots, max: number): KnowledgeCitationDTO[] {
  if (!n.source.absPath) return [];
  const redacted = redactFileHeatPath(n.source.absPath, roots);
  return [{ pathDisplay: redacted.pathDisplay, pathScope: redacted.pathScope, line: n.source.lineStart }].slice(0, max);
}

/** Shared WP8 projection of the CLAUDE.md ⇄ behavior linkage onto the DTO. Used by
 *  BOTH list + detail so an agent sees the same fields either way. */
function knowledgeExtras(n: KnowledgeNode): Pick<AgentKnowledgeNodeDTO,
  'sourceRole' | 'sourceSpan' | 'behavior' | 'fileReferenceStats' | 'audienceProviders'> {
  return {
    sourceRole: n.sourceRole,
    sourceSpan: { lineStart: n.source.lineStart, lineEnd: n.source.lineEnd },
    ...(n.behavior ? { behavior: n.behavior } : {}),
    ...(n.fileReferenceStats ? { fileReferenceStats: n.fileReferenceStats } : {}),
    // WP2 (G2): identifiers only (provider names), redaction-safe by construction.
    ...(n.audienceProviders !== undefined ? { audienceProviders: n.audienceProviders } : {}),
  };
}

function knowledgeDigest(graph: AgentKnowledgeGraph, nodeIds: string[]): string {
  // Fold behavior status + sourceRole into the digest: they materially change the
  // visible data (WP8), so a change flips the generationId → any stale cursor is
  // correctly rejected rather than silently paging over changed rows.
  const behaviorFingerprint = [...graph.nodes]
    .map((n) => `${n.sourceRole ?? ''}:${n.behavior?.status ?? ''}`)
    .sort();
  return computeGenerationId({
    proposalIds: nodeIds,
    extra: { route: KNOWLEDGE_ROUTE, agentId: graph.agentId, behaviorFingerprint },
  });
}

export function buildAgentKnowledgePage(
  graph: AgentKnowledgeGraph,
  roots: RedactionRoots,
  params: AgentKnowledgePageParams,
): AgentDtoResponse<AgentKnowledgePage> {
  const caps = AGENT_DTO_CAPS.agent_knowledge;
  // id + stable sort (id ASC) over ALL nodes, before paging.
  const withIds = graph.nodes.map((n) => ({ n, id: nodeId(n) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const generationId = knowledgeDigest(graph, withIds.map((x) => x.id));
  const filtersHash = computeFiltersHash({});
  if (params.cursor) {
    const v = validateCursor(params.cursor, { route: KNOWLEDGE_ROUTE, filtersHash, sort: KNOWLEDGE_SORT, generationId });
    if (!v.ok) return errResponse(v.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }

  let afterIdx = 0;
  if (params.cursor) {
    const decoded = validateCursor(params.cursor, { route: KNOWLEDGE_ROUTE, filtersHash, sort: KNOWLEDGE_SORT, generationId });
    if (decoded.ok) {
      const [lastId] = decoded.cursor.lastSortKey as [string];
      afterIdx = withIds.findIndex((x) => x.id > lastId);
      if (afterIdx < 0) afterIdx = withIds.length;
    }
  }

  const limit = clampLimit(params.limit, caps.listDefault, caps.listMax);
  const slice = withIds.slice(afterIdx, afterIdx + limit);
  const hasMore = afterIdx + limit < withIds.length;
  const rows: AgentKnowledgeNodeDTO[] = slice.map(({ n, id }) => ({
    id,
    type: n.type,
    label: n.label,
    detail: truncate(n.detail, KNOWLEDGE_DETAIL_MAX_CHARS),
    citations: citationsFor(n, roots, caps.citationsPerNodeMax),
    sourceScope: n.sourceScope,
    ...knowledgeExtras(n),
  }));

  const degraded = degradePayload({ items: rows as unknown as Record<string, unknown>[] });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  const finalRows = degraded.items as unknown as AgentKnowledgeNodeDTO[];

  const last = finalRows[finalRows.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ v: 1, route: KNOWLEDGE_ROUTE, filtersHash, sort: KNOWLEDGE_SORT,
        lastSortKey: [last.id], generationId, issuedAtMs: 0 })
    : undefined;

  const data: AgentKnowledgePage = {
    agentId: graph.agentId,
    agentName: graph.agentName,
    nodes: finalRows,
    sourceFileCount: graph.sourceFiles.length,
  };
  const meta = readyMeta(graph.generatedAtIso, generationId, withIds.length === 0 ? 'empty' : 'ready');
  const page: PageInfo = { limit, returned: finalRows.length, hasMore, nextCursor };
  return okResponse(data, { meta, page, warnings: degraded.warnings });
}

// ══════════════════════════════════════════════════════════════════════════════════
// MCP TOOL USAGE  (get_mcp_tool_usage — lean four-tier attribution rollup, WP-C / P2)
// ══════════════════════════════════════════════════════════════════════════════════
//
// The MCP route returns THIS lean rollup (McpToolUsageRollupDTO), NOT the full
// McpToolUsageResult — top-line totals, top-N byTool, a capped byToolLane cross-tab,
// the FULL four-tier tierBreakdown + coverage %, a capped timeline, and a next-drill
// hint. Full per-session detail stays behind the raw IPC result the panel consumes.
// Target ≤ ~15k serialized chars. Parity holds: byToolLane / tierBreakdown / coverage
// live on the shared enriched result both surfaces read.

const MCP_TOOL_USAGE_ROUTE = 'get_mcp_tool_usage';

export interface McpToolUsagePageParams {
  /** Reserved for the deferred explicit pagination/filter param (full per-session
   *  detail). The default lean rollup ignores it today. */
  full?: boolean;
}

function mcpUsageDigest(result: McpToolUsageResult): string {
  return computeGenerationId({
    extra: {
      route: MCP_TOOL_USAGE_ROUTE,
      total: result.totalCalls,
      tiers: result.tierBreakdown,
      tools: [...result.byTool]
        .sort((a, b) => (a.toolName < b.toolName ? -1 : 1))
        .map((t) => [t.toolName, t.count]),
    },
  });
}

export function buildMcpToolUsagePage(
  result: McpToolUsageResult,
  _params: McpToolUsagePageParams = {},
): AgentDtoResponse<McpToolUsageRollupDTO> {
  const caps = AGENT_DTO_CAPS.mcp_tool_usage;
  const generationId = mcpUsageDigest(result);

  // Top-N tools + capped cross-tab. tierBreakdown stays FULL (all four tiers) so the
  // honest four-tier disclosure survives regardless of the byToolLane cap.
  const byTool = result.byTool.slice(0, caps.topTools);
  const byToolLane = [...result.byToolLane]
    .sort((a, b) => b.count - a.count)
    .slice(0, caps.laneCells);
  const timelineFull = [...result.timeline].sort((a, b) => b.tsMs - a.tsMs);
  const timeline = timelineFull.slice(0, caps.timelineMax);
  const timelineTruncated = result.timelineTruncated || timelineFull.length > caps.timelineMax;

  const laneCoverageBand = coverageBand(result.attributionCoveragePct);
  const nextDrill = nextDrillHint({
    tierBreakdown: result.tierBreakdown,
    attributedCount: result.attributedCount,
    unattributedCount: result.unattributedCount,
    attributionCoveragePct: result.attributionCoveragePct,
    laneCoverageBand,
  });

  const data: McpToolUsageRollupDTO = {
    totalCalls: result.totalCalls,
    attributedCount: result.attributedCount,
    unattributedCount: result.unattributedCount,
    attributionCoveragePct: result.attributionCoveragePct,
    laneCoverageBand,
    tierBreakdown: result.tierBreakdown,
    byTool,
    byToolLane,
    byLane: result.byLane,
    timeline,
    timelineTruncated,
    scopeMeta: result.scopeMeta,
    nextDrill,
    generatedAtIso: result.generatedAtIso,
  };

  const degraded = degradePayload({
    items: byToolLane as unknown as Record<string, unknown>[],
    fileHeatTail: timeline,
  });
  if (!degraded.ok) return errResponse(degraded.error, { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  data.byToolLane = degraded.items as unknown as McpToolUsageRollupDTO['byToolLane'];
  data.timeline = degraded.fileHeatTail as McpToolUsageRollupDTO['timeline'];
  data.timelineTruncated = timelineTruncated || data.timeline.length < timeline.length;

  const meta = readyMeta(result.generatedAtIso, generationId, result.totalCalls === 0 ? 'empty' : 'ready');
  return okResponse(data, { meta, warnings: degraded.warnings });
}

export interface AgentKnowledgeNodeDetail {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  detail?: string;
  citations: KnowledgeCitationDTO[];
  sourceScope?: string;
  sourceRole?: KnowledgeSourceRole;
  sourceSpan?: { lineStart: number; lineEnd: number };
  behavior?: KnowledgeBehaviorEvidence;
  fileReferenceStats?: KnowledgeFileReferenceStats;
  // WP2 (G2): same audience projection as the list route.
  audienceProviders?: string[] | 'unknown';
}

export function buildAgentKnowledgeDetail(
  graph: AgentKnowledgeGraph,
  roots: RedactionRoots,
  id: string,
): AgentDtoResponse<AgentKnowledgeNodeDetail> {
  const withIds = graph.nodes.map((n) => ({ n, id: nodeId(n) }));
  const generationId = knowledgeDigest(graph, withIds.map((x) => x.id).sort());
  const hit = withIds.find((x) => x.id === id);
  if (!hit) {
    return errResponse(
      { code: 'INVALID_ARGUMENT', message: `No knowledge node '${id}' for this agent generation.`, retriable: false },
      { generationId, parserVersion: AGENT_DTO_PARSER_VERSION });
  }
  const caps = AGENT_DTO_CAPS.agent_knowledge;
  const data: AgentKnowledgeNodeDetail = {
    id: hit.id,
    type: hit.n.type,
    label: hit.n.label,
    detail: hit.n.detail, // full text on the detail route
    citations: citationsFor(hit.n, roots, caps.citationsPerNodeMax),
    sourceScope: hit.n.sourceScope,
    ...knowledgeExtras(hit.n),
  };
  const meta = readyMeta(graph.generatedAtIso, generationId, 'ready');
  return okResponse(data, { meta });
}
