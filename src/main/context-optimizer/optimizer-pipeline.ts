// optimizer-pipeline.ts — WP6 PRODUCTION WIRING (the composition layer).
//
// The WP0–WP6 modules in this folder are all PURE over injected deps. This file is
// the one place that reaches the real database and composes them, in the ORDER the
// design mandates, into a single callable pipeline:
//
//     runEpochBackfill (ONE-SHOT, §3)  ──▶  classify occurrences (§5.2)
//        must run BEFORE the first classifier pass or every section opens at
//        parse-time → `insufficient-exposure` across the board → no SUBTRACT can
//        reach `never` (master lines 373-378). The ordering is enforced here.
//                     │
//                     ▼
//     score attribution (§6) ──▶ attach phrase-gap evidence (§3, keyed by the
//        BYPASS scriptPath so gaps actually attach at context-optimizer.ts:644)
//                     │
//                     ▼
//     generateContextOptimizerProposals (§7–§9)  ──▶ ContextOptimizerResult
//
// SEAM PROVENANCE (the WP6 relay seam list — this leg closes them):
//   #1 runEpochBackfill call-site ordering ......... `runOptimizerPipeline` step 1
//   #2 ScaffoldConstantBridge production impl ...... `makeScaffoldConstantResolver`
//   #3 ExposureResolver production impl ............ `makeEpochBoundedExposureResolver`
//   #4 LaneOptimizerInput assembly ................. `assembleLaneInput`
//   #5 Phrase-gap corpus query .................... `queryPhraseGapInputsForBypass`
//   #6 Outcome-tracker WindowMetric recompute ..... `recomputeWindowMetric`
//   #7 Fingerprint producers ...................... `laneParityFingerprints` + helpers
//   #8 generateParityArtifact wiring .............. `buildLaneParityArtifact`
//   #9 File-coverage / bypass row readers ......... `queryFileTouches` / `queryBypassExecEvents`
//
// Everything here is deterministic given a deterministic DB snapshot + injected
// clock (`nowMs` / `generatedAtIso`). The pipeline never calls a clock itself.
//
// What this leg OWNS end-to-end: backfill ordering, the two hardened seams
// (exposure resolver, scaffold bridge), occurrence classification, attribution,
// phrase-gap corpus + attach, fingerprints, and the parity-artifact composition.
// What it still INJECTS (each has its own not-yet-wired module query surface that
// belongs to a sibling / the acceptance leg): compiled `actions`, `clusters`,
// `drift`, `coverage`, `bypass`, `derivation`, `toolsetResidentTokens`, `cost`.

import * as path from 'node:path';
import type {
  AgentRoleLane, ContextOptimizerQuery, ContextOptimizerResult, GuidanceSource,
  ResidentAsset, ResidentAssetUsage,
  FileTouchScope, FileTouchScopeCounts, WorkspaceAttributionBreakdown, WorkspaceAttributionTier,
} from '../../shared/types';
import { BehaviorStore, type Lane, type QueryDb } from './behavior-store';
import { streamAgentIdentityJoin } from './stream-identity';
import { classifyAccessOp } from './behavior-sequences';
import {
  runEpochBackfill,
  type EpochBackfillOutcome,
  type ScaffoldConstantBridge,
} from './config-epoch-backfill';
import type { BirthdayResolver, LedgerDb, ResidentTarget } from './resident-inventory';
import { sha256Hex } from './resident-inventory';
import {
  classifyOccurrences,
  defaultOccurrenceCounter,
  normalizeMatcher,
  type ClassifyDeps,
  type EvidenceInputs,
  type EvidenceResolver,
  type ExposureCount,
  type ExposureResolver,
  type OccurrenceCounter,
  type OccurrenceEvidenceV1,
  type OccurrenceVerdict,
} from './occurrence-classifier';
import type { PredictedAction } from './guidance-action-model';
import {
  scoreAttribution,
  type AttributionScore,
  type AttributionTarget,
  type TargetGranularity,
} from './attribution';
import { buildPhraseGapByScript, type PhraseGapInput, type PhraseGapSnippet } from './phrase-gap';
import type {
  BypassExecEvent,
  BypassProposal,
  BypassResult,
  FileCoverageResult,
  FileTouch,
  SkillInvocationWindow,
  SkillLaneExposure,
} from './file-coverage';
import type { DriftFinding } from './config-drift';
import type { ImprovisationCandidate } from './improvisation-clusters';
import {
  generateContextOptimizerProposals,
  type LaneCostEvidence,
  type LaneOptimizerInput,
  type LaneResidentSummary,
} from './context-optimizer';
import {
  currentFingerprints,
  generateParityArtifact,
  type CompilerParityArtifact,
  type CompilerParityRow,
  type DerivationVerifiedResult,
  type OrchestrationHistogram,
  type ParityExpectations,
  type ParityFingerprints,
} from './compiler-parity-gate';
import { OPTIMIZER_CONFIG, PREDICTED_ACTION_COMPILER_VERSION, RESIDENT_PARSER_VERSION } from './optimizer-config';

// A DB handle that satisfies both the read-query surface (BehaviorStore) and the
// ledger-write surface (backfill). The real better-sqlite3 handle and the sql.js
// test fake both structurally satisfy this.
export type PipelineDb = QueryDb & LedgerDb;

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #3 — epoch-bounded, subagent-varying ExposureResolver (production impl).
//
// The default resolver (`defaultExposureResolver`) sums a lane SCALAR
// (`exposureForLane`) — epoch-UNBOUNDED and subagent-invariant. The real exposure
// denominator (hardening-epochs-outcomes §3.3) is:
//   • bounded to the action's OPEN EPOCH window (`sourceEpochId` → config_epochs
//     first/last_seen_ms) so a section only "counts" turns during which it was
//     actually resident, and
//   • filtered by the subagent policy the classifier already decides per action
//     (`includeSubagents`) — a tool grant pools subagent streams; persona guidance
//     excludes them.
//
// The turn denominator is `behavior_events` rows with kind='turn_outcome' — the
// SAME rows `stream_lane_stats.turn_count` is derived from (parse-runner.ts:230),
// so an epoch-unbounded run of this resolver reproduces the default's totals; we
// only add the time-bound + the subagent filter that a scalar cannot express.
// ─────────────────────────────────────────────────────────────────────────────

/** Behavior-store lanes for an action, de-duplicated (AgentRoleLane ⊆ Lane). */
function laneKeys(lanes: AgentRoleLane[]): Lane[] {
  return [...new Set<Lane>(lanes as Lane[])];
}

interface EpochBounds {
  lo: number | null; // first_seen_ms; null ⇒ no lower bound (epoch unresolved)
  hi: number | null; // last_seen_ms;  null ⇒ open epoch (no upper bound)
}

function epochBoundsFor(db: QueryDb, sourceEpochId: string): EpochBounds {
  if (!sourceEpochId) return { lo: null, hi: null };
  const row = db
    .prepare('SELECT first_seen_ms AS lo, last_seen_ms AS hi FROM config_epochs WHERE id = ?')
    .get(sourceEpochId);
  if (!row) return { lo: null, hi: null };
  const lo = row.lo == null ? null : Number(row.lo);
  const hi = row.hi == null ? null : Number(row.hi);
  return { lo, hi };
}

/** Production `ExposureResolver` (seam #3). */
export function makeEpochBoundedExposureResolver(db: QueryDb): ExposureResolver {
  return {
    resolve(pa: PredictedAction, opts: { includeSubagents: boolean }): ExposureCount {
      const lanes = laneKeys(pa.lanes);
      if (lanes.length === 0) return { exposureTurns: 0, distinctStreams: 0, distinctSlugs: 0 };
      const { lo, hi } = epochBoundsFor(db, pa.sourceEpochId);
      const placeholders = lanes.map(() => '?').join(', ');
      // includeSubagents==false ⇒ restrict to top-level streams (is_subagent = 0).
      // The `(? = 1 OR ...)` shape keeps one prepared statement for both policies.
      const row = db
        .prepare(
          `SELECT COUNT(*) AS turns,
                  COUNT(DISTINCT ev.stream_id) AS streams,
                  COUNT(DISTINCT sls.slug) AS slugs
             FROM behavior_events ev
             JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
            WHERE ev.kind = 'turn_outcome'
              AND sls.lane IN (${placeholders})
              AND (? = 1 OR sls.is_subagent = 0)
              AND (? IS NULL OR ev.ts_ms >= ?)
              AND (? IS NULL OR ev.ts_ms <= ?)`,
        )
        .get(...lanes, opts.includeSubagents ? 1 : 0, lo, lo, hi, hi);
      return {
        exposureTurns: numOf(row?.turns),
        distinctStreams: numOf(row?.streams),
        distinctSlugs: numOf(row?.slugs),
      };
    },
  };
}

function numOf(v: unknown): number {
  return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// WP-1A (Priority 0) — production EvidenceResolver (fail-closed `never` audit).
//
// Composes the three behavior-store evidence readers into a SAME-GENERATION
// OccurrenceEvidenceV1 for a provisional-`never`. It queries over the action's OPEN
// EPOCH window (`sourceEpochId` → config_epochs first/last_seen, via `epochBoundsFor`)
// and the classifier's subagent policy, and applies the config sample caps at the
// query LIMIT. The classifier's fail-closed gates then decide `auditable` vs the
// `capture-incomplete` downgrade — this resolver only produces the honest counts.
//
// When UNWIRED (default deps in tests / a caller that omits it) the classifier keeps
// the legacy `never` but stamps `evidenceState:'unavailable'`; only WHEN this resolver
// is wired does a `never` become gate-auditable in production.
// ─────────────────────────────────────────────────────────────────────────────
export function makeProductionEvidenceResolver(db: QueryDb): EvidenceResolver {
  const store = new BehaviorStore(db);
  return {
    resolve(pa: PredictedAction, inp: EvidenceInputs): OccurrenceEvidenceV1 {
      const { lo, hi } = epochBoundsFor(db, pa.sourceEpochId);
      const window = { includeSubagents: inp.includeSubagents, lo, hi };
      const denomSamples = store.sampleExposureStreams(inp.lanes, window, OPTIMIZER_CONFIG.EVIDENCE_SAMPLE_STREAMS_CAP);
      const numerSamples = store.sampleMatchingEvents(inp.predicate, inp.lanes, window, OPTIMIZER_CONFIG.EVIDENCE_SAMPLE_EVENTS_CAP);
      const coverage = store.captureCoverageFor(inp.lanes, window);
      return {
        predicate: inp.predicate,
        matcherVersion: String(PREDICTED_ACTION_COMPILER_VERSION),
        normalizedMatcher: normalizeMatcher(inp.predicate),
        epoch: {
          ...(inp.epoch.id ? { id: inp.epoch.id } : {}),
          ...(lo != null ? { sinceMs: lo } : (inp.epoch.sinceMs != null ? { sinceMs: inp.epoch.sinceMs } : {})),
          ...(hi != null ? { untilMs: hi } : {}),
          confidence: inp.epoch.confidence,
        },
        denominator: {
          turns: inp.exposure.exposureTurns,
          streams: inp.exposure.distinctStreams,
          slugs: inp.exposure.distinctSlugs,
          sampledStreams: denomSamples,
        },
        numerator: {
          occurrences: inp.match.occurrences,
          streams: inp.match.distinctStreams,
          sampledEvents: numerSamples,
        },
        captureCoverage: coverage,
        exclusions: {
          subagents: !inp.includeSubagents,
          reasons: inp.includeSubagents ? [] : ['persona-derived-predicate-excludes-subagents'],
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #2 — ScaffoldConstantBridge production impl.
//
// A resident file that is gitignored/generated (a `.lares/…` scaffold copy)
// has no git history of its OWN, but it MIRRORS a managed constant in
// `src/shared/constants.ts` (SUPERVISOR_AGENT_MD, WORKER_CLAUDE_MD, the SKILL.md
// constants, …). The backfill's git resolver dates such a section from the
// CONSTANT's own section-hash lineage. This bridge maps `(resident target) →
// (constant coordinates + a text extractor)` so `makeGitBirthdayResolver` can walk
// `constants.ts` revisions (resident-inventory §3.2.3).
//
// The mapping is driven by `ScaffoldConstantEntry[]` — one per managed constant:
//   • `matches(target)` decides whether this resident file mirrors the constant
//     (by source_symbol when the ScaffoldMatcher resolved one, else by path tail).
//   • `extractConstantText(constantsSource)` pulls the constant's markdown string
//     out of a `constants.ts` revision (the exported `const NAME = \`…\`` body).
// ─────────────────────────────────────────────────────────────────────────────

export interface ScaffoldConstantEntry {
  /** Exported symbol name in constants.ts, e.g. 'SUPERVISOR_AGENT_MD'. */
  constantSymbol: string;
  /** True when `target` is the resident mirror of this constant. */
  matches(target: ResidentTarget): boolean;
}

export interface ScaffoldConstantResolverDeps {
  /** Repo root containing `src/shared/constants.ts`. */
  repoDir: string;
  /** Path of the constants file RELATIVE to `repoDir` (default src/shared/constants.ts). */
  constantsRelPath?: string;
  entries: ScaffoldConstantEntry[];
}

/**
 * Extract the markdown body of an exported template-literal constant from a
 * `constants.ts` source revision. Returns null when the constant is absent at that
 * revision (a younger constant) — the bridge then simply reports no hit for that
 * revision, which is the honest "not born yet" answer.
 *
 * Handles the two shapes the scaffold constants use:
 *   export const NAME = `…`;
 *   export const NAME: string = `…`;
 * Backtick escapes (`\`` / `${`) inside the template are preserved verbatim; the
 * section-hash comparison runs over the same normalized markdown either way.
 */
export function extractConstantTemplate(constantsSource: string, symbol: string): string | null {
  // Locate `const <symbol>` then the first backtick after `=`.
  const declRe = new RegExp(`\\bconst\\s+${escapeRegExp(symbol)}\\b[^=]*=\\s*`);
  const m = declRe.exec(constantsSource);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (constantsSource[i] !== '`') return null; // not a template-literal constant
  i += 1;
  let out = '';
  while (i < constantsSource.length) {
    const ch = constantsSource[i];
    if (ch === '\\') {
      // Preserve the escaped pair (\`, \\, \$) as its literal second char.
      out += constantsSource[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '`') return out; // closing backtick
    out += ch;
    i += 1;
  }
  return null; // unterminated — treat as absent
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the `scaffoldConstant` function for `GitBirthdayDeps` (seam #2). */
export function makeScaffoldConstantResolver(
  deps: ScaffoldConstantResolverDeps,
): (target: ResidentTarget) => ScaffoldConstantBridge | null {
  const relPath = deps.constantsRelPath ?? path.join('src', 'shared', 'constants.ts');
  return (target: ResidentTarget): ScaffoldConstantBridge | null => {
    const entry = deps.entries.find((e) => e.matches(target));
    if (!entry) return null;
    return {
      repoDir: deps.repoDir,
      relPath,
      extractConstantText: (fileText: string) => extractConstantTemplate(fileText, entry.constantSymbol),
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #5 — phrase-gap corpus query (invocation vs bypass, per bypass script).
//
// Qualifying snippets (hardening-classifier §3): `selection_reason='matched'` AND
// `source_kind ∈ (user_message, command_args)` — brief relays excluded. We split
// the corpus:
//   • INVOCATION corpus = snippets on skill_invocation events for the skill+lane
//     (the legitimate-trigger phrasing).
//   • BYPASS corpus = snippets on executed_file events whose behavior_event
//     arg_path matches the bypass proposal's scriptPath (WP5 §2.4 bypass exec set).
//
// We derive ONE PhraseGapInput per BypassProposal and key it by
// `proposal.scriptPath` VERBATIM, so `buildPhraseGapByScript` produces keys that
// exactly match what the engine looks up at context-optimizer.ts:644 (relay
// warning #4 — a mismatched normalization silently drops the gap).
// ─────────────────────────────────────────────────────────────────────────────

const QUALIFYING_SOURCE_KINDS = ['user_message', 'command_args'] as const;

function toSnippet(row: Record<string, unknown>): PhraseGapSnippet {
  return {
    snippet: row.snippet == null ? '' : String(row.snippet),
    snippetHash: row.snippet_hash == null ? '' : String(row.snippet_hash),
    streamId: String(row.stream_id ?? ''),
  };
}

/** INVOCATION snippets for a skill in a lane (joined to skill_invocations for the
 *  lane scope via stream_lane_stats). */
function queryInvocationCorpus(db: QueryDb, skillName: string, lane: AgentRoleLane): PhraseGapSnippet[] {
  const rows = db
    .prepare(
      `SELECT ts.snippet AS snippet, ts.snippet_hash AS snippet_hash, ts.stream_id AS stream_id
         FROM trigger_snippets ts
         JOIN skill_invocations si ON si.id = ts.event_id
         JOIN stream_lane_stats sls ON sls.stream_id = ts.stream_id
        WHERE ts.event_type = 'skill_invocation'
          AND ts.selection_reason = 'matched'
          AND ts.source_kind IN ('user_message', 'command_args')
          AND si.skill_name = ?
          AND sls.lane = ?
        ORDER BY ts.event_id`,
    )
    .all(skillName, lane);
  return rows.map(toSnippet);
}

/** BYPASS snippets for a script path in a lane — executed_file trigger snippets
 *  whose owning behavior_event executed that path (LOWER match, matching the
 *  normalized `BypassExecEvent.path` / `BypassProposal.scriptPath`). */
function queryBypassCorpus(db: QueryDb, scriptPath: string, lane: AgentRoleLane): PhraseGapSnippet[] {
  const rows = db
    .prepare(
      `SELECT ts.snippet AS snippet, ts.snippet_hash AS snippet_hash, ts.stream_id AS stream_id
         FROM trigger_snippets ts
         JOIN behavior_events be ON be.id = ts.event_id
         JOIN stream_lane_stats sls ON sls.stream_id = ts.stream_id
        WHERE ts.event_type = 'executed_file'
          AND ts.selection_reason = 'matched'
          AND ts.source_kind IN ('user_message', 'command_args')
          AND be.access_mode = 'executed'
          AND LOWER(be.arg_path) = ?
          AND sls.lane = ?
        ORDER BY ts.event_id`,
    )
    .all(scriptPath.toLowerCase(), lane);
  return rows.map(toSnippet);
}

/** Build one PhraseGapInput per bypass proposal (seam #5). Keys carry through as
 *  `proposal.scriptPath` verbatim so the engine attach matches (warning #4). */
export function queryPhraseGapInputsForBypass(
  db: QueryDb,
  proposals: BypassProposal[],
): PhraseGapInput[] {
  return proposals.map((p) => ({
    skillName: p.skillName,
    lane: p.lane,
    scriptPath: p.scriptPath,
    invocation: queryInvocationCorpus(db, p.skillName, p.lane),
    bypass: queryBypassCorpus(db, p.scriptPath, p.lane),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #6 — outcome-tracker WindowMetric recompute.
//
// A4 reconciliation recomputes rates on demand from behavior_events over the SAME
// lanes + includeSubagents FROZEN in `optimizer_actions.target_json` at apply time
// (never re-derived — a SUBTRACT deletes the source, so the matchers can't be
// recompiled). This helper is the DB read the outcome tracker feeds into
// `toRates` / `assessOutcome`. `exposureTurns` uses the same turn_outcome
// denominator as the exposure resolver so before/after windows normalize per-100
// turns consistently.
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowPredicateSql {
  /** A boolean SQL fragment over `behavior_events ev` (e.g. `ev.tool_name = ?`). */
  whereSql: string;
  params: unknown[];
}

/** Recompute a WindowMetric (occ / streams / exposureTurns) over a [lo,hi] window,
 *  honoring the frozen lane set + subagent policy. */
export function recomputeWindowMetric(
  db: QueryDb,
  opts: {
    lanes: Lane[];
    includeSubagents: boolean;
    window: { lo: number; hi: number };
    predicate: WindowPredicateSql;
  },
): { occ: number; streams: number; exposureTurns: number } {
  const { lanes, includeSubagents, window, predicate } = opts;
  if (lanes.length === 0) return { occ: 0, streams: 0, exposureTurns: 0 };
  const placeholders = lanes.map(() => '?').join(', ');
  const subFilter = includeSubagents ? '' : ' AND sls.is_subagent = 0';

  const occRow = db
    .prepare(
      `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS streams
         FROM behavior_events ev
         JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE (${predicate.whereSql})
          AND sls.lane IN (${placeholders})${subFilter}
          AND ev.ts_ms >= ? AND ev.ts_ms <= ?`,
    )
    .get(...predicate.params, ...lanes, window.lo, window.hi);

  const expRow = db
    .prepare(
      `SELECT COUNT(*) AS turns
         FROM behavior_events ev
         JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'turn_outcome'
          AND sls.lane IN (${placeholders})${subFilter}
          AND ev.ts_ms >= ? AND ev.ts_ms <= ?`,
    )
    .get(...lanes, window.lo, window.hi);

  return {
    occ: numOf(occRow?.occ),
    streams: numOf(occRow?.streams),
    exposureTurns: numOf(expRow?.turns),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #9 — file-coverage / bypass row readers (lean behavior_events reads).
//
// The full file-coverage + bypass DETECTION (classifyFileCoverage /
// detectSkillBypass) wires many inputs (SkillOwnedIndex from disk, invocation
// windows, exposures, ignore rows); that assembly is the file-coverage module's
// own leg. These two readers cover the behavior_events half — FileTouch rows and
// executed-file bypass candidates — which are the pieces sourced purely from the
// DB spine.
// ─────────────────────────────────────────────────────────────────────────────

export interface FileTouchRow {
  streamId: string;
  tsMs: number;
  path: string;
  lane: AgentRoleLane;
  subAgentName: string | null;
  accessMode: string | null;
  argPathConfidence: string | null;
}

// ── WP-4A (Phase 4) — workspace-scoped file-touch reads (spec 258, risk 3). ──────
//
// The lane-only `queryFileTouches` counted a lane's file_touch events across EVERY
// workspace, so top file-heat rows could include paths from other projects. This
// scoping copies the vetted WP-2B lineage model (mcp-tool-usage-queries.ts): a real
// workspace identity resolves via `session_id → agent_sessions → agents.workspace_id`
// (LEFT) or `stream_lane_stats.workspace_id`; the Claude slug is only a PROXY. No row
// enters a strict scoped result without a real or uniquely-inferred workspace id, and
// the dropped/proxy counts are reported so the shrunken dataset is disclosed honestly.

/** LEFT joins so a file_touch row keeps its COUNT even when no session/agent/workspace
 *  resolves (unattributed stays first-class — CLAUDE.md shared-cwd invariant).
 *  WP9: the session→agent leg is the pinned identity join, now provided by the
 *  shared stream-identity helper so this site and behavior-sequences cannot drift. */
const FILE_TOUCH_JOINS = `
  FROM behavior_events ev
  LEFT JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
${streamAgentIdentityJoin('ev', 'asx', 'ag')}`;

/** The workspace-tier CASE (precedence strongest real identity first) — parity with the
 *  MCP-usage classifier. `workspace-explicit` is reserved (launch metadata not yet wired). */
const FILE_TOUCH_WORKSPACE_TIER_CASE = `
  CASE
    WHEN ag.workspace_id IS NOT NULL THEN 'workspace-from-launch-session'
    WHEN sls.workspace_id IS NOT NULL AND sls.workspace_attribution_method = 'explicit' THEN 'workspace-explicit'
    WHEN sls.workspace_id IS NOT NULL THEN 'workspace-from-root'
    WHEN COALESCE(ev.slug, sls.slug) IS NOT NULL THEN 'workspace-slug-proxy'
    ELSE 'workspace-unattributed'
  END`;

const REAL_WS = `COALESCE(ag.workspace_id, sls.workspace_id)`;

function emptyWsBreakdown(): WorkspaceAttributionBreakdown {
  return {
    'workspace-explicit': 0,
    'workspace-from-launch-session': 0,
    'workspace-from-root': 0,
    'workspace-slug-proxy': 0,
    'workspace-unattributed': 0,
  };
}

/** The lane predicate shared by the scoped read and the count probes, so they can never
 *  drift. Every column join-qualified. Returns clauses WITHOUT the workspace-scope leg. */
function fileTouchBaseClauses(lane: AgentRoleLane): { clauses: string[]; params: unknown[] } {
  return {
    clauses: [`ev.kind = 'file_touch'`, `ev.arg_path IS NOT NULL`, `sls.lane = ?`],
    params: [lane],
  };
}

/** True when the include-proxy slug leg is active for this (scope-resolved) scope. */
function proxyLegActive(scope: FileTouchScope): boolean {
  return !!(scope.workspaceId && scope.scopeMode === 'include-proxy' && scope.slug && scope.slugUniqueToWorkspace);
}

/** Base predicate + the workspace-scope predicate for the applied scopeMode. `strict`
 *  matches only a real workspace id; `include-proxy` additionally admits slug-proxy rows
 *  (real id NULL) when the slug uniquely maps to the caller workspace; `global-diagnostic`
 *  applies NO workspace filter. */
function fileTouchWhere(lane: AgentRoleLane, scope: FileTouchScope): { where: string; params: unknown[] } {
  const { clauses, params } = fileTouchBaseClauses(lane);
  if (scope.workspaceId && scope.scopeMode !== 'global-diagnostic') {
    if (proxyLegActive(scope)) {
      clauses.push(`(${REAL_WS} = ? OR (${REAL_WS} IS NULL AND COALESCE(ev.slug, sls.slug) = ?))`);
      params.push(scope.workspaceId, scope.slug);
    } else {
      clauses.push(`${REAL_WS} = ?`);
      params.push(scope.workspaceId);
    }
  }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

/** Whether `slug` maps to EXACTLY the caller workspace (data-driven — no cross-workspace
 *  guess). Zero evidence ⇒ not unique ⇒ denied. */
function slugMapsUniquelyTo(db: QueryDb, lane: AgentRoleLane, workspaceId: string, slug: string): boolean {
  const { clauses, params } = fileTouchBaseClauses(lane);
  clauses.push(`COALESCE(ev.slug, sls.slug) = ?`); params.push(slug);
  clauses.push(`${REAL_WS} IS NOT NULL`);
  const rows = db
    .prepare(`SELECT DISTINCT ${REAL_WS} AS ws ${FILE_TOUCH_JOINS} WHERE ${clauses.join(' AND ')}`)
    .all(...params);
  return rows.length === 1 && String(rows[0].ws) === workspaceId;
}

/** Resolve scope defaults: file-heat defaults to 'strict' (its honest agents-join scope,
 *  mirroring skill-usage); include-proxy self-determines slug↔workspace uniqueness. */
function resolveFileTouchScope(db: QueryDb, lane: AgentRoleLane, scope: FileTouchScope): FileTouchScope {
  const scopeMode = scope.scopeMode ?? 'strict';
  let slugUniqueToWorkspace = scope.slugUniqueToWorkspace ?? false;
  if (scopeMode === 'include-proxy' && scope.workspaceId && scope.slug && scope.slugUniqueToWorkspace === undefined) {
    slugUniqueToWorkspace = slugMapsUniquelyTo(db, lane, scope.workspaceId, scope.slug);
  }
  return { ...scope, scopeMode, slugUniqueToWorkspace };
}

/** Rows admitted into the scoped result ONLY via the slug-proxy leg (real id NULL, slug
 *  matches). 0 unless the proxy leg is active. */
function proxyIncludedCount(db: QueryDb, lane: AgentRoleLane, scope: FileTouchScope): number {
  if (!proxyLegActive(scope)) return 0;
  const { clauses, params } = fileTouchBaseClauses(lane);
  clauses.push(`${REAL_WS} IS NULL`);
  clauses.push(`COALESCE(ev.slug, sls.slug) = ?`); params.push(scope.slug);
  const row = db.prepare(`SELECT COUNT(*) AS n ${FILE_TOUCH_JOINS} WHERE ${clauses.join(' AND ')}`).get(...params);
  return numOf(row?.n);
}

/** file_touch rows the workspace filter drops (no workspace identity) AND not rescued by
 *  the proxy leg. 0 with no workspace scope or under global-diagnostic. */
function droppedUnattributedCount(db: QueryDb, lane: AgentRoleLane, scope: FileTouchScope): number {
  if (!scope.workspaceId || scope.scopeMode === 'global-diagnostic') return 0;
  const { clauses, params } = fileTouchBaseClauses(lane);
  clauses.push(`${REAL_WS} IS NULL`);
  const row = db.prepare(`SELECT COUNT(*) AS n ${FILE_TOUCH_JOINS} WHERE ${clauses.join(' AND ')}`).get(...params);
  return numOf(row?.n) - proxyIncludedCount(db, lane, scope);
}

/** Per-workspace-tier counts over the BASE (non-workspace-filtered) population, so proxy/
 *  unattributed tiers are reported separately from real-identity tiers. */
function fileTouchWorkspaceBreakdown(db: QueryDb, lane: AgentRoleLane): {
  breakdown: WorkspaceAttributionBreakdown; realIdCount: number;
} {
  const { clauses, params } = fileTouchBaseClauses(lane);
  const rows = db
    .prepare(
      `SELECT ${FILE_TOUCH_WORKSPACE_TIER_CASE} AS wtier, COUNT(*) AS n
       ${FILE_TOUCH_JOINS} WHERE ${clauses.join(' AND ')} GROUP BY wtier`,
    )
    .all(...params);
  const breakdown = emptyWsBreakdown();
  for (const r of rows) {
    const tier = String(r.wtier) as WorkspaceAttributionTier;
    if (tier in breakdown) breakdown[tier] = numOf(r.n);
  }
  const realIdCount = breakdown['workspace-explicit']
    + breakdown['workspace-from-launch-session'] + breakdown['workspace-from-root'];
  return { breakdown, realIdCount };
}

/** WP-4A — workspace-scoped file_touch rows for a lane PLUS the honest scope counts.
 *  `scope.workspaceId` absent ⇒ NO workspace filter (lane-global, pre-Phase-4 behavior).
 *  The normalized arg_path is the heat key. */
export function queryFileTouchesScoped(
  db: QueryDb,
  lane: AgentRoleLane,
  scope: FileTouchScope = {},
): { rows: FileTouchRow[]; scope: FileTouchScopeCounts } {
  const resolved = resolveFileTouchScope(db, lane, scope);
  const { where, params } = fileTouchWhere(lane, resolved);
  const rows = db
    .prepare(
      `SELECT ev.stream_id AS s, ev.ts_ms AS t, LOWER(ev.arg_path) AS p,
              ev.sub_agent_name AS sub, ev.access_mode AS am, ev.arg_path_confidence AS conf
       ${FILE_TOUCH_JOINS} ${where}
       ORDER BY ev.ts_ms, ev.id`,
    )
    .all(...params);
  const { breakdown, realIdCount } = fileTouchWorkspaceBreakdown(db, lane);
  return {
    rows: rows.map((r) => ({
      streamId: String(r.s ?? ''),
      tsMs: numOf(r.t),
      path: r.p == null ? '' : String(r.p),
      lane,
      subAgentName: r.sub == null ? null : String(r.sub),
      accessMode: r.am == null ? null : String(r.am),
      argPathConfidence: r.conf == null ? null : String(r.conf),
    })),
    scope: {
      droppedUnattributed: droppedUnattributedCount(db, lane, resolved),
      proxyIncluded: proxyIncludedCount(db, lane, resolved),
      breakdown,
      realIdCount,
    },
  };
}

/** All file_touch behavior_events for a lane (normalized arg_path is the heat key).
 *  Lane-global (no workspace scope) — retained for callers/tests that don't scope;
 *  new scoped callers use `queryFileTouchesScoped`. */
export function queryFileTouches(db: QueryDb, lane: AgentRoleLane): FileTouchRow[] {
  return queryFileTouchesScoped(db, lane, {}).rows;
}

/** Executed-file behavior_events for a lane — the raw bypass exec candidates before
 *  the §2.4 guards. Only access_mode='executed' rows. */
export function queryBypassExecEvents(db: QueryDb, lane: AgentRoleLane): FileTouchRow[] {
  return queryFileTouches(db, lane).filter((r) => r.accessMode === 'executed');
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #9 remainder — the file-coverage/bypass INPUT SHAPES the detectors expect.
//
// `queryFileTouches` / `queryBypassExecEvents` above return the lean raw
// behavior_events rows. `classifyFileCoverage` wants ONE `FileTouch` per distinct
// path (read/write/execute rollup); `detectSkillBypass` wants `BypassExecEvent[]`
// plus the two shapes that had no reader yet: legitimate-invocation `windows` (from
// `skill_invocations` ts bounds) and per-(skill,lane) `exposures`. These four helpers
// close that half so the acceptance leg can drive the real detectors off the DB spine.
// ─────────────────────────────────────────────────────────────────────────────

/** Roll the raw per-event `FileTouchRow[]` up into one `FileTouch` per distinct
 *  normalized path (reads/writes/executes + distinct stream fan-out) — the exact
 *  shape `classifyFileCoverage` consumes (file-coverage.ts:90). */
export function aggregateFileTouches(rows: FileTouchRow[]): FileTouch[] {
  interface Acc { reads: number; writes: number; executes: number; streams: Set<string> }
  const byPath = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.path) continue;
    let acc = byPath.get(r.path);
    if (!acc) { acc = { reads: 0, writes: 0, executes: 0, streams: new Set() }; byPath.set(r.path, acc); }
    // WP9: THE file-coverage op mapping, extracted to behavior-sequences so the
    // sequence miner reuses it byte-for-byte rather than reinventing it.
    const op = classifyAccessOp(r.accessMode);
    if (op === 'execute') acc.executes++;
    else if (op === 'write') acc.writes++;
    else acc.reads++; // read (and any other non-exec/non-write access) counts as a read
    if (r.streamId) acc.streams.add(r.streamId);
  }
  return [...byPath.entries()]
    .map(([path, a]) => ({ path, reads: a.reads, writes: a.writes, executes: a.executes, distinctStreams: a.streams.size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Narrow the raw executed-file rows into `BypassExecEvent[]` (file-coverage.ts:415).
 *  `accessMode` is 'executed' by construction (queryBypassExecEvents); an unknown
 *  arg_path_confidence maps to 'unknown' so the detector's G1 confidence guard drops
 *  it honestly rather than silently trusting it. */
export function toBypassExecEvents(rows: FileTouchRow[]): BypassExecEvent[] {
  const conf = (c: string | null): BypassExecEvent['argPathConfidence'] =>
    c === 'exact' || c === 'normalized' || c === 'heuristic' ? c : 'unknown';
  return rows
    .filter((r) => r.accessMode === 'executed' && r.path)
    .map((r) => ({
      streamId: r.streamId,
      tsMs: r.tsMs,
      path: r.path,
      lane: r.lane,
      subAgentName: r.subAgentName,
      accessMode: 'executed' as const,
      argPathConfidence: conf(r.argPathConfidence),
    }));
}

/** Legitimate-invocation windows for a lane (G2 exclusion). Time bounds prefer the
 *  Gap-A `start_ts_ms`/`end_ts_ms` columns, falling back to `ts_ms`/`window_last_ts`
 *  for pre-Gap-A rows so a window always has a usable span. */
export function querySkillInvocationWindows(db: QueryDb, lane: AgentRoleLane): SkillInvocationWindow[] {
  const rows = db
    .prepare(
      `SELECT si.stream_id AS s, si.skill_name AS skill,
              COALESCE(si.start_ts_ms, si.ts_ms) AS lo,
              COALESCE(si.end_ts_ms, si.window_last_ts, si.ts_ms) AS hi
         FROM skill_invocations si
         JOIN stream_lane_stats sls ON sls.stream_id = si.stream_id
        WHERE sls.lane = ?`,
    )
    .all(lane);
  return rows.map((r) => ({
    streamId: String(r.s ?? ''),
    skillName: String(r.skill ?? ''),
    lane,
    startTsMs: numOf(r.lo),
    endTsMs: Math.max(numOf(r.lo), numOf(r.hi)),
  }));
}

/** Total `turn_outcome` turns observed in a lane (the resident-exposure denominator,
 *  the same rows the exposure resolver / stream_lane_stats.turn_count derive from). */
export function laneTurnTotal(db: QueryDb, lane: AgentRoleLane): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS turns
         FROM behavior_events ev
         JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'turn_outcome' AND sls.lane = ?`,
    )
    .get(lane);
  return numOf(row?.turns);
}

/** Per-(skill,lane) exposure for the bypass min-exposure gate (G7). A scaffolded skill
 *  header is resident for EVERY turn the lane runs, so each resident skill's exposure is
 *  the lane's total turn count — this is what lets a skill that is *bypassed* (hence
 *  never invoked, absent from skill_invocations) still clear the exposure floor and
 *  surface as a `tune-skill-trigger` proposal rather than a quiet-lane watch item. */
export function querySkillLaneExposures(
  db: QueryDb, lane: AgentRoleLane, skillNames: string[],
): SkillLaneExposure[] {
  const exposureTurns = laneTurnTotal(db, lane);
  return [...new Set(skillNames)].map((skillName) => ({ skillName, lane, exposureTurns }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #7 — fingerprint producers (for the compiler-parity gate).
//
// §4.4: `corpusFingerprint` is STRUCTURAL — lane set / root set / inclusion
// filters / parser_version — NEVER row counts (append-only growth must not re-open
// the gate). The other three key a mismatch on the config, toolset inventory, and
// empirical-report inputs the parity artifact was built from.
// ─────────────────────────────────────────────────────────────────────────────

function canonHash(parts: unknown): string {
  return sha256Hex(JSON.stringify(parts));
}

/** STRUCTURAL corpus fingerprint (§4.4). Row counts deliberately EXCLUDED. */
export function structuralCorpusFingerprint(parts: {
  laneSet: string[];
  rootSet: string[];
  inclusionFilters: string[];
  parserVersion?: number;
}): string {
  return canonHash({
    lanes: [...parts.laneSet].sort(),
    roots: [...parts.rootSet].sort(),
    filters: [...parts.inclusionFilters].sort(),
    parserVersion: parts.parserVersion ?? RESIDENT_PARSER_VERSION,
  });
}

/** Config fingerprint — the open-epoch config state (section_key ↦ content_hash).
 *  A section edit (new content_hash) or a new/closed epoch flips this. */
export function configFingerprint(db: QueryDb): string {
  const rows = db
    .prepare(
      `SELECT section_key AS k, content_hash AS h
         FROM config_epochs
        WHERE last_seen_ms IS NULL
        ORDER BY section_key`,
    )
    .all();
  return canonHash(rows.map((r) => [String(r.k), String(r.h)]));
}

/** Toolset-inventory fingerprint — hash of the injected grant inventory (keys +
 *  their schema token sizes). Caller supplies the current inventory. */
export function toolsetInventoryFingerprint(inventory: Record<string, number>): string {
  return canonHash(Object.entries(inventory).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Empirical-report fingerprint — the per-lane orchestration histogram the parity
 *  report reproduces. Distribution, not a coincidental count total. */
export function empiricalReportFingerprint(histogram: OrchestrationHistogram): string {
  return canonHash(Object.entries(histogram).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Assemble the full `ParityFingerprints` for a lane from the four producers. */
export function laneParityFingerprints(parts: {
  corpusFingerprint: string;
  configFingerprint: string;
  toolsetInventoryFingerprint: string;
  empiricalReportFingerprint: string;
}): ParityFingerprints {
  return currentFingerprints(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #8 — generateParityArtifact wiring (compose real compiler+classifier+
// behavior rollup; caller persists to plans/optimizer-parity/<lane>-parity.*).
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneParityDeps {
  generatedAtIso: string;
  compileRows: (lane: AgentRoleLane) => CompilerParityRow[];
  orchestrationHistogram: (lane: AgentRoleLane) => OrchestrationHistogram;
  fingerprints: (lane: AgentRoleLane) => ParityFingerprints;
  expectations: (lane: AgentRoleLane) => ParityExpectations | null;
}

/** Compose a parity artifact for a lane (§4.2 step 1). Persistence (the .json/.tsv
 *  under plans/optimizer-parity/, NEVER under .claude/) is the caller's job. */
export function buildLaneParityArtifact(lane: AgentRoleLane, deps: LaneParityDeps): CompilerParityArtifact {
  return generateParityArtifact(lane, deps);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #4 — LaneOptimizerInput assembly + the top-level pipeline (#1 ordering).
// ─────────────────────────────────────────────────────────────────────────────

/** The per-lane module outputs the pipeline does NOT itself query (each has its
 *  own not-yet-wired query surface). The pipeline OWNS verdicts, attribution, and
 *  phrase-gap; those are NOT part of this bundle. */
export interface RawLaneInputs {
  lane: AgentRoleLane;
  resident: LaneResidentSummary;
  actions: PredictedAction[];
  clusters: ImprovisationCandidate[];
  bypass: BypassResult;
  drift: DriftFinding[];
  coverage?: FileCoverageResult;
  /** WP-4A — workspace-scope counts from the file-touch query feeding `coverage`.
   *  Summed across lanes into `result.meta.fileHeatScope`. */
  coverageScope?: FileTouchScopeCounts;
  derivation: DerivationVerifiedResult;
  toolsetResidentTokens?: Record<string, number>;
  // R2 WP-3 (Priority 1): first-class resident assets + their usage join. Additive +
  // optional — absent ⇒ the engine emits no asset-backed proposals (honest degrade).
  residentAssets?: ResidentAsset[];
  residentAssetUsage?: ResidentAssetUsage[];
  cost?: LaneCostEvidence;
  /** Attribution granularity per action. Absent ⇒ the documented default below. */
  granularityForAction?: (pa: PredictedAction) => TargetGranularity;
  // ── WP-E (P4) grant-mismatch sizing seams (both optional; absent ⇒ honest degrade to
  //    the legacy zero-weight subtract-dead-guidance drift path). Populated by
  //    optimizer-assemble from the TokenEstimator + residentTargets.
  residentSectionTextAt?: (absPath: string, line: number) => string | null;
  estimateTokens?: (text: string) => number;
  // ── WP3 (G3) recommendation-draft target policy inputs (both optional; absent ⇒
  //    every draft target is honestly `{ unresolved, reason }` — never a CLAUDE.md
  //    default). Populated by the caller that composed WP2 guidance sources.
  guidanceSources?: GuidanceSource[];
  observedProviders?: string[];
}

/**
 * Default attribution granularity (design §6): a tool grant is always lane-level
 * (the MCP grant is the lane's own knob). A guidance section maps 1:1 to a lane's
 * scaffold-constant knob when EXACTLY ONE real persona lane inherits it → lane-level;
 * a section pooled across multiple lanes / unknown provenance is narrower-than-lane
 * (capped at `inferred` with the shared-cwd caveat). Override via
 * `granularityForAction` when the scaffold provenance says otherwise.
 */
const REAL_LANES: ReadonlySet<AgentRoleLane> = new Set<AgentRoleLane>([
  'supervisor',
  'worker',
  'researcher',
]);

function defaultGranularity(pa: PredictedAction): TargetGranularity {
  const toolGrant =
    (pa.kind === 'tool-invocation' || pa.kind === 'toolset-usage') && pa.sourceKind === 'tool';
  if (toolGrant) return 'lane-level';
  const realLanes = pa.lanes.filter((l) => REAL_LANES.has(l));
  return realLanes.length === 1 ? 'lane-level' : 'narrower-than-lane';
}

/** Score attribution for every action, keyed by actionId (seam #4). */
function attributionByActionId(
  actions: PredictedAction[],
  verdictById: Map<string, OccurrenceVerdict>,
  granularityForAction: (pa: PredictedAction) => TargetGranularity,
): Record<string, AttributionScore> {
  const out: Record<string, AttributionScore> = {};
  for (const pa of actions) {
    const verdict = verdictById.get(pa.id);
    if (!verdict) continue; // no verdict ⇒ engine falls back to the action's own tier
    const target: AttributionTarget = { verdict, granularity: granularityForAction(pa) };
    out[pa.id] = scoreAttribution(pa, target);
  }
  return out;
}

/** Assemble ONE `LaneOptimizerInput` (seam #4). Classifies occurrences with the
 *  production exposure resolver, scores attribution, and attaches phrase-gap
 *  evidence keyed by the bypass scriptPath. */
export function assembleLaneInput(
  db: PipelineDb,
  raw: RawLaneInputs,
  classifyDeps: ClassifyDeps,
): LaneOptimizerInput {
  const verdicts = classifyOccurrences(raw.actions, classifyDeps);
  const verdictById = new Map<string, OccurrenceVerdict>();
  for (const v of verdicts) verdictById.set(v.actionId, v);

  const granularityForAction = raw.granularityForAction ?? defaultGranularity;
  const attribution = attributionByActionId(raw.actions, verdictById, granularityForAction);

  // Phrase-gap: derive units from the bypass proposals so keys match the engine
  // lookup (warning #4), then compute the gap DTOs.
  const phraseGapInputs = queryPhraseGapInputsForBypass(db, raw.bypass.proposals);
  const phraseGapByScript = buildPhraseGapByScript(phraseGapInputs);

  // WP-E (P4) contradiction guardrail seam: observed usage of tools in the SAME
  // capability family as a drift finding's guidance (conservatively keyed on the
  // finding's own toolset / member tool). `>0` calls ⇒ the engine suppresses the subtract.
  const capabilityFamilyUsageFor = (finding: DriftFinding) => {
    let calls = 0;
    for (const a of raw.actions) {
      const ts = a.params.toolset ?? a.params.server;
      const match = ts === finding.toolset
        || (finding.toolName != null && a.params.toolName === finding.toolName);
      if (!match) continue;
      const v = verdictById.get(a.id);
      if (v && v.status === 'occurs') calls += v.occurrences;
    }
    return calls > 0 ? { family: finding.toolset, calls } : null;
  };

  return {
    lane: raw.lane,
    resident: raw.resident,
    actions: raw.actions,
    verdicts,
    attributionByActionId: attribution,
    clusters: raw.clusters,
    bypass: raw.bypass,
    drift: raw.drift,
    coverage: raw.coverage,
    coverageScope: raw.coverageScope,
    derivation: raw.derivation,
    toolsetResidentTokens: raw.toolsetResidentTokens,
    residentAssets: raw.residentAssets,
    residentAssetUsage: raw.residentAssetUsage,
    cost: raw.cost,
    phraseGapByScript,
    residentSectionTextAt: raw.residentSectionTextAt,
    estimateTokens: raw.estimateTokens,
    capabilityFamilyUsageFor,
    guidanceSources: raw.guidanceSources,
    observedProviders: raw.observedProviders,
  };
}

export interface OptimizerPipelineDeps {
  db: PipelineDb;
  /** Injected ISO clock — stamped onto the engine result (§7). */
  generatedAtIso: string;
  /** Injected ms clock — the backfill's `nowMs` (dates undated sections). */
  nowMs: number;
  /** Resident markdown targets for the ONE-SHOT backfill (collectMarkdownTargets). */
  backfillTargets: ResidentTarget[];
  /** Git section-hash birthday resolver (makeGitBirthdayResolver + seam #2 bridge). */
  birthdayResolver: BirthdayResolver;
  /** Per-lane raw module inputs. */
  lanes: RawLaneInputs[];
  query?: ContextOptimizerQuery;
  /** Override the exposure resolver (default: epoch-bounded over db, seam #3). */
  exposureResolver?: ExposureResolver;
  /** Override the occurrence counter (default: behavior-store over db). */
  occurrenceCounter?: OccurrenceCounter;
  /** WP-1A — override the fail-closed `never` evidence resolver (default:
   *  `makeProductionEvidenceResolver` over db). */
  evidenceResolver?: EvidenceResolver;
  /** Epoch → birth confidence lookup for the classifier (optional). */
  epochConfidenceFor?: (epochId: string) => 'high' | 'low' | null;
  /** 'skip' suppresses the one-shot cold-start epoch backfill (the only writer on
   *  this path). Exporter-only; never exposed over IPC or HTTP. Default 'run'
   *  preserves today's behavior exactly. */
  backfillMode?: 'run' | 'skip';
}

export interface OptimizerPipelineOutcome {
  result: ContextOptimizerResult;
  backfill: EpochBackfillOutcome;
}

/**
 * The production pipeline. ORDER IS LOAD-BEARING (seam #1): the one-shot epoch
 * backfill runs BEFORE any classifier pass, or every section reads
 * `insufficient-exposure` and no SUBTRACT can reach `never`. Steady-state the
 * backfill is a guarded no-op (returns `ran:false`, touches no git).
 */
export function runOptimizerPipeline(deps: OptimizerPipelineDeps): OptimizerPipelineOutcome {
  // ── STEP 1 — one-shot cold-start backfill (MUST precede classification). ──
  // `backfillMode:'skip'` is the read-only exporter's opt-out: it is the ONLY
  // writer on this path, so skipping it makes the whole analyze non-writing. The
  // exporter refuses to snapshot a cold DB rather than freeze the degraded
  // (`insufficient-exposure`) analysis this skip would otherwise produce.
  const backfill: EpochBackfillOutcome = deps.backfillMode === 'skip'
    ? { ran: false, results: [] }
    : runEpochBackfill(deps.backfillTargets, {
      db: deps.db,
      resolver: deps.birthdayResolver,
      nowMs: deps.nowMs,
    });

  // ── STEP 2 — build the classifier deps over the real DB (seam #3 default). ──
  const store = new BehaviorStore(deps.db);
  const classifyDeps: ClassifyDeps = {
    occurrence: deps.occurrenceCounter ?? defaultOccurrenceCounter(store),
    exposure: deps.exposureResolver ?? makeEpochBoundedExposureResolver(deps.db),
    // WP-1A: wiring the production evidence resolver is what makes a `never`
    // gate-auditable in prod; unwired (tests) ⇒ legacy `never`+`unavailable`.
    evidence: deps.evidenceResolver ?? makeProductionEvidenceResolver(deps.db),
    epochConfidenceFor: deps.epochConfidenceFor,
  };

  // ── STEP 3 — assemble one LaneOptimizerInput per lane (classify → attribute →
  //             attach phrase-gap). ──
  const laneInputs = deps.lanes.map((raw) => assembleLaneInput(deps.db, raw, classifyDeps));

  // ── STEP 4 — run the pure engine. ──
  const result = generateContextOptimizerProposals({
    generatedAtIso: deps.generatedAtIso,
    lanes: laneInputs,
    query: deps.query,
  });

  return { result, backfill };
}
