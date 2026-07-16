// optimizer-assemble.ts — WP6 acceptance leg, TASK B. The per-lane `RawLaneInputs[]`
// assembler that composes ON TOP of optimizer-production.ts (task A) + the SEAM #9
// readers in optimizer-pipeline.ts, feeding runOptimizerPipeline / runOptimizerAnalyze.
//
// This is the impure composition that binds the pure WP0–WP5 module DETECTORS to the
// real overhead scan (resident inventory), the deterministic knowledge extractor
// (compiled predicted actions), the live toolset-definition provider (mcp resolver +
// drift grants), and the DB spine (occurrence/exposure/file-heat/bypass rows). It
// produces one `RawLaneInputs` per real persona lane; `runOptimizerPipeline` then runs
// the classifier/attribution/phrase-gap/engine on top (order-preserving, seam #1).
//
// Determinism: every helper is pure over its injected inputs; the only impurity is the
// overhead scan + skill-dir enumeration + toolset `require()`, all funneled through
// `buildAssembleContext` so a caller (the acceptance test) can construct the context
// once and assert against it. No clocks here — `runOptimizerPipeline` stamps time.

import * as path from 'node:path';
import type { AgentContextOverhead, OverheadModel, AgentRoleLane, FileTouchScope } from '../../shared/types';
import type { FileReader } from '../context-overhead/context-overhead-analyzer';
import { makeFileReader, makeToolsetDefsProvider } from '../context-overhead/ipc-deps';
import { runOverheadScan } from '../context-overhead/ipc-deps';
import type { ToolsetDefsProvider } from '../context-overhead/mcp-tool-inventory';
import { TokenEstimator } from '../context-overhead/token-estimator';
import { toolsetsForLane } from '../supervisor/mcp-config-builder';
import { extractAgentKnowledge } from '../agent-knowledge/knowledge-extractor';
import { classifyPathMutability } from '../shared/path-mutability';

import { BehaviorStore } from './behavior-store';
import {
  collectMarkdownTargets,
  findSectionContainingLine,
  type ResidentTarget,
} from './resident-inventory';
import {
  compileGuidanceActions,
  type CompileDeps,
  type PredictedAction,
} from './guidance-action-model';
import {
  classifyFileCoverage,
  detectSkillBypass,
  scriptGlobsFor,
  type SkillOwnedIndex,
  type SkillScriptOwnership,
} from './file-coverage';
import { SKILL_SCRIPT_EXTS } from './optimizer-config';
import { detectConfigDrift, type ConfigDriftDeps } from './config-drift';
import { findImprovisationClusters, coverageFromActions } from './improvisation-clusters';
import { laneHasReference, type DerivationVerifiedResult } from './compiler-parity-gate';
import { buildResidentAssets, joinSkillAdvertisementUsage } from './resident-assets';
import type { LaneResidentSummary } from './context-optimizer';
import {
  aggregateFileTouches,
  queryFileTouchesScoped,
  queryBypassExecEvents,
  toBypassExecEvents,
  querySkillInvocationWindows,
  querySkillLaneExposures,
  laneTurnTotal,
  type PipelineDb,
  type RawLaneInputs,
} from './optimizer-pipeline';

// The three real persona lanes the optimizer proposes over (`legacy` carries no
// grant and no persona knowledge — never assembled).
const REAL_LANES: readonly AgentRoleLane[] = ['supervisor', 'worker', 'researcher'];

// The dashboard toolset keys that CAN be granted to a lane — the registered-toolset
// universe for drift (union of every lane's grant). A documented toolset outside this
// set AND unresolvable via the defs provider reads as decommissioned (honest: the
// live script map no longer defines it). Kept in sync with TOOLSET_SCRIPT_MAP in
// context-overhead/ipc-deps.ts (the authoritative provider) — additive only.
function candidateToolsetKeys(): string[] {
  const out = new Set<string>();
  for (const lane of ['supervisor', 'worker', 'researcher', 'legacy'] as AgentRoleLane[]) {
    for (const t of toolsetsForLane(lane).split(',')) {
      const k = t.trim();
      if (k) out.add(k);
    }
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────────
// Determinate helpers (pure over injected inputs) — each unit-testable in isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** The compiler's `mcpServerResolver` (§4.3): an `mcp: <display>` persona node → its
 *  toolset key + member tool names. For dashboard-injected toolsets the display name
 *  IS the toolset key, so we resolve via the same live defs provider the overhead scan
 *  uses. Unknown display → null ⇒ the compiler degrades to a coarse server grant. */
export function buildMcpServerResolver(
  defs: ToolsetDefsProvider,
): (displayName: string) => { toolset: string; tools: string[] } | null {
  const memo = new Map<string, { toolset: string; tools: string[] } | null>();
  return (displayName: string) => {
    const key = displayName.trim();
    if (memo.has(key)) return memo.get(key)!;
    const toolDefs = defs.defsFor(key);
    const resolved = toolDefs ? { toolset: key, tools: toolDefs.map((t) => t.name) } : null;
    memo.set(key, resolved);
    return resolved;
  };
}

/** `openEpochIdFor` (compiler §5.1): resolve the OPEN epoch id for a section_key
 *  (config_epochs WHERE last_seen_ms IS NULL). Null ⇒ the section is not yet dated
 *  (honest empty `sourceEpochId`, never a fabricated id). */
export function makeOpenEpochResolver(db: PipelineDb): (sectionKey: string) => string | null {
  return (sectionKey: string) => {
    if (!sectionKey) return null;
    const row = db
      .prepare('SELECT id FROM config_epochs WHERE section_key = ? AND last_seen_ms IS NULL')
      .get(sectionKey);
    return row && row.id != null ? String(row.id) : null;
  };
}

/** The drift deps (§5.2): documented (from actions) × GRANTED (toolsetsForLane) ×
 *  REGISTERED (the live defs provider). A documented toolset absent from the registered
 *  set is decommissioned; absent from a lane's grant is documented-but-not-granted. */
export function buildDriftDeps(defs: ToolsetDefsProvider): ConfigDriftDeps {
  const candidates = candidateToolsetKeys();
  const registered = candidates.filter((k) => defs.defsFor(k) != null);
  return {
    grantedToolsetsFor: (lane) => toolsetsForLane(lane),
    registeredToolsets: () => registered,
    registeredToolNamesFor: (toolset) => {
      const d = defs.defsFor(toolset);
      return d ? d.map((t) => t.name) : null;
    },
  };
}

/** The G2 derivation state for the analyze/accept path (§4.5): the human signs off via
 *  the UI only, and the read-only analyze never holds a `verified` row, so every lane is
 *  honestly UNVERIFIED here. Mirrors `derivationVerified(lane, null, …)` exactly —
 *  non-supervisor lanes carry `unverified-no-reference`, supervisor `unverified` — so
 *  the derived SUBTRACTs surface for review but are never auto-promoted to verified. */
export function honestDerivation(lane: AgentRoleLane): DerivationVerifiedResult {
  return {
    lane,
    verified: false,
    state: laneHasReference(lane) ? 'unverified' : 'unverified-no-reference',
    staleReasons: [],
  };
}

// ── SkillOwnedIndex construction from the overhead scan + disk ──────────────────

const SCRIPT_EXT_RE = new RegExp(
  `[\\w./\\\\-]+(?:${SKILL_SCRIPT_EXTS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

/** Executable references inside a SKILL.md body — backtick/command spans naming a
 *  script-extension file (e.g. `python read-comments.py doc.md`). These are the
 *  SKILL.md-referenced executables `scriptGlobsFor` folds into the owned-script set so a
 *  script that is EXECUTED (bypassing the skill) but not a bare file under the root is
 *  still owned. Deterministic, de-duped. */
export function parseSkillMdExecutables(skillMdText: string): string[] {
  const out = new Set<string>();
  SCRIPT_EXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_EXT_RE.exec(skillMdText)) !== null) {
    const tok = m[0].trim();
    // Strip a leading shell-word boundary artifact and obvious noise.
    if (tok.length >= 4) out.add(tok);
  }
  return [...out].sort();
}

/** Every skill SKILL.md source visible to an agent, from the walk-up inheritance chain
 *  (kind skill-header/skill-body). Returns one entry per distinct SKILL.md path with its
 *  root dir + mutability. */
function skillSourcesFor(agent: AgentContextOverhead): Array<{ skillMdPath: string; mutable: SkillScriptOwnership['mutable'] }> {
  const seen = new Map<string, { skillMdPath: string; mutable: SkillScriptOwnership['mutable'] }>();
  const visit = (sources: AgentContextOverhead['flatSources']): void => {
    for (const s of sources) {
      if ((s.kind === 'skill-header' || s.kind === 'skill-body' || s.kind === 'skill') && s.resolvedPath) {
        if (!seen.has(s.resolvedPath)) seen.set(s.resolvedPath, { skillMdPath: s.resolvedPath, mutable: s.mutable });
      }
      if (s.children?.length) visit(s.children);
    }
  };
  for (const frame of agent.inheritanceChain) {
    if (!frame.included) continue;
    visit(frame.sources);
  }
  return [...seen.values()];
}

/** Build the SkillOwnedIndex for a lane: one SkillScriptOwnership per distinct skill the
 *  lane's agents inherit, its `scriptGlobs` computed from the on-disk files under the
 *  skill root PLUS the SKILL.md-referenced executables (so `read-comments.py`, a
 *  SKILL.md-referenced script, is owned even when it is not a bare file under the root).
 *  `lanes` is `[lane]` — the index is built per lane and consumed lane-scoped by both
 *  classifyFileCoverage and detectSkillBypass. */
export function buildLaneSkillIndex(
  model: OverheadModel,
  lane: AgentRoleLane,
  reader: FileReader,
): SkillOwnedIndex {
  const laneAgents = model.agents.filter((a) => a.lane === lane);
  const byRoot = new Map<string, SkillScriptOwnership>();
  for (const agent of laneAgents) {
    for (const src of skillSourcesFor(agent)) {
      const skillRoot = path.dirname(src.skillMdPath).replace(/\\/g, '/');
      if (byRoot.has(skillRoot)) continue;
      const skillName = path.basename(skillRoot);
      const filesUnderRoot = reader.listFiles(`${skillRoot}/**/*`) ?? [];
      const skillMdText = reader.read(src.skillMdPath)?.content ?? '';
      const scriptGlobs = scriptGlobsFor({
        skillRoot,
        filesUnderRoot,
        skillMdReferencedExecutables: parseSkillMdExecutables(skillMdText),
      });
      byRoot.set(skillRoot, {
        skillName,
        skillRoot: skillRoot.toLowerCase(),
        lanes: [lane],
        mutable: classifyPathMutability(skillRoot),
        scriptGlobs,
      });
    }
  }
  return [...byRoot.values()].sort((a, b) => (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0));
}

// ── LaneResidentSummary (ranking denominator) ──────────────────────────────────

const CLAUDE_KINDS = new Set([
  'agent-claude', 'inherited-claude', 'claude-local', 'user-claude',
  'managed-policy', 'rules', 'memory', 'behavioral', 'import',
]);

/** Per-lane resident-cost summary + exposure (LaneResidentSummary, context-optimizer.ts:56).
 *  Costs come from the representative agent's header-view sources (claude markdown, mcp
 *  server totals, skill headers); exposure comes from the DB turn spine. */
export function buildLaneResidentSummary(
  agent: AgentContextOverhead,
  db: PipelineDb,
  lane: AgentRoleLane,
): LaneResidentSummary {
  let claude = 0;
  let skillHeaders = 0;
  for (const s of agent.flatSources) {
    const t = s.estimate?.tokens ?? 0;
    if (CLAUDE_KINDS.has(s.kind)) claude += t;
    else if (s.kind === 'skill-header') skillHeaders += t;
  }
  let mcp = 0;
  for (const server of agent.mcpServers) {
    if (server.excludedByStrictMode) continue;
    mcp += server.total?.tokens ?? 0;
  }
  const exposure = laneExposure(db, lane);
  return {
    residentTokens: claude + mcp + skillHeaders,
    claude,
    mcp,
    skillHeaders,
    exposureTurns: exposure.exposureTurns,
    exposureStreams: exposure.exposureStreams,
    exposureSlugs: exposure.exposureSlugs,
  };
}

/** WP-3 Phase 3 (step 1): per-toolset SCHEMA residency for `subtract-unused-toolset`
 *  sizing. The MCP inventory already tokenizes each granted toolset's total schema cost
 *  (`McpServerOverhead.total`); this rolls it into a `{ toolset → tokens }` map keyed so
 *  the engine's `lane.toolsetResidentTokens?.[toolset]` join hits.
 *
 *  Key discipline: the compiler resolves an `mcp: <display>` persona node to its toolset
 *  via `mcpServerResolver`, so `toolset-usage` actions carry `params.toolset = <resolved
 *  toolset>` (for dashboard toolsets, display name IS the toolset key). We key by the same
 *  resolution so the join is exact; unknown/global servers fall back to the display name.
 *
 *  Strict-excluded servers (counted 0 for this lane) and zero-token servers are OMITTED:
 *  a 0 delta is worse than the engine's honest fallback to the action's own `residentTokens`.
 *  Pure + resolver-injected for unit-testability (no scan/DB needed). */
export function buildToolsetResidentTokens(
  agent: AgentContextOverhead,
  resolveToolset: (displayName: string) => string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const server of agent.mcpServers) {
    if (server.excludedByStrictMode) continue;
    const tokens = server.total?.tokens ?? 0;
    if (tokens <= 0) continue;
    const key = resolveToolset(server.displayName) ?? server.displayName;
    // Deterministic on duplicate display names: keep the larger schema cost.
    out[key] = Math.max(out[key] ?? 0, tokens);
  }
  return out;
}

/** Lane exposure over the whole corpus (turn_outcome turns + distinct streams/slugs) —
 *  the unbounded lane denominator (the epoch-bounded per-action denominator is the
 *  classifier's job via makeEpochBoundedExposureResolver). */
function laneExposure(db: PipelineDb, lane: AgentRoleLane): {
  exposureTurns: number; exposureStreams: number; exposureSlugs: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS turns,
              COUNT(DISTINCT ev.stream_id) AS streams,
              COUNT(DISTINCT sls.slug) AS slugs
         FROM behavior_events ev
         JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'turn_outcome' AND sls.lane = ?`,
    )
    .get(lane);
  const n = (v: unknown): number => (typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0);
  return {
    exposureTurns: n(row?.turns),
    exposureStreams: n(row?.streams),
    exposureSlugs: n(row?.slugs),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared assemble context + per-lane assembly
// ─────────────────────────────────────────────────────────────────────────────

/** The impure inputs shared across every lane's assembly, built once. */
export interface AssembleContext {
  db: PipelineDb;
  model: OverheadModel;
  reader: FileReader;
  estimator: TokenEstimator;
  defs: ToolsetDefsProvider;
  /** Lane-union resident markdown targets (compiler residentTargets + backfill targets). */
  residentTargets: ResidentTarget[];
  /** The compiler dep seams derived from the context (mcp resolver, epoch resolver). */
  mcpServerResolver: (displayName: string) => { toolset: string; tools: string[] } | null;
  openEpochIdFor: (sectionKey: string) => string | null;
  driftDeps: ConfigDriftDeps;
  /** WP-4A — the workspace scope the per-lane file-touch heat query runs under. Defaults
   *  to the scanned workspace id under 'strict' (the honest agents-join scope). */
  scope: FileTouchScope;
}

/** Build the cl100k encoder once (mirrors context-overhead/ipc-deps buildEncoder; kept
 *  local so we don't widen that module's export surface). Falls back to the
 *  chars-heuristic when js-tiktoken is unavailable. */
function buildEncoder(): ((t: string) => number) | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getEncoding } = require('js-tiktoken');
    const enc = getEncoding('cl100k_base');
    return (t: string) => enc.encode(t).length;
  } catch {
    return undefined;
  }
}

/** Construct the shared assemble context from a workspace id + DB. Runs ONE overhead
 *  scan and derives every shared seam. `db` is the analytics DB (behavior spine +
 *  config_epochs ledger). */
export function buildAssembleContext(
  deps: { workspaceId: string; db: PipelineDb; scope?: FileTouchScope },
): AssembleContext {
  const model = runOverheadScan(deps.workspaceId);
  return buildAssembleContextFromModel({ ...deps, model });
}

/** Same as `buildAssembleContext` but over an already-computed OverheadModel — the
 *  acceptance test / a caller that already scanned reuses the model rather than
 *  re-scanning (and can point the reader at a specific pathType). */
export function buildAssembleContextFromModel(deps: {
  db: PipelineDb;
  model: OverheadModel;
  defs?: ToolsetDefsProvider;
  scope?: FileTouchScope;
}): AssembleContext {
  const { db, model } = deps;
  const reader = makeFileReader(model.pathType);
  const estimator = new TokenEstimator({ encoder: buildEncoder() });
  const defs = deps.defs ?? makeToolsetDefsProvider();
  const residentTargets = collectMarkdownTargets(model, reader);
  // WP-4A — default the file-heat scope to the scanned workspace under 'strict' (its
  // honest agents-join scope; mirrors skill-usage). A caller (live-analyze) overrides
  // with the query's slug/scopeMode. `model.workspaceId` is the same REAL id the run
  // was seeded with, so scoping is exact.
  const scope: FileTouchScope = deps.scope ?? { workspaceId: model.workspaceId, scopeMode: 'strict' };
  return {
    db,
    model,
    reader,
    estimator,
    defs,
    residentTargets,
    mcpServerResolver: buildMcpServerResolver(defs),
    openEpochIdFor: makeOpenEpochResolver(db),
    driftDeps: buildDriftDeps(defs),
    scope,
  };
}

/** Assemble ONE lane's `RawLaneInputs`, or null when the lane has no representative
 *  agent in the scan (nothing to analyze — honest skip, never a fabricated lane). */
export function assembleRawLaneInputs(lane: AgentRoleLane, ctx: AssembleContext): RawLaneInputs | null {
  const agent = ctx.model.agents.find((a) => a.lane === lane);
  if (!agent) return null;

  // 1. Compile the lane's persona knowledge into predicted actions (§5.1).
  const compileDeps: CompileDeps = {
    residentTargets: ctx.residentTargets,
    estimateTokens: (text: string) => ctx.estimator.estimate(text).tokens,
    openEpochIdFor: ctx.openEpochIdFor,
    mcpServerResolver: ctx.mcpServerResolver,
    // WP-2A (Priority 0): resolve code-form tool names in resident markdown prose to their
    // registered toolset(s) so real documentation becomes DOCUMENTED input for config-drift.
    // Additive DOCUMENTED-repair over the existing driftDeps (registeredToolsets ×
    // registeredToolNamesFor) — NOT a WP-E seam re-wire. config-drift owns the authoritative
    // ambiguity resolution; this seam only gates "is this a real tool name?".
    toolNameResolver: (name: string) => {
      const s = new Set<string>();
      for (const ts of ctx.driftDeps.registeredToolsets())
        if ((ctx.driftDeps.registeredToolNamesFor(ts) ?? []).includes(name)) s.add(ts);
      return [...s];
    },
  };
  const { nodes } = extractAgentKnowledge(agent, {
    readFile: (absPath) => ctx.reader.read(absPath)?.content ?? null,
  });
  const actions: PredictedAction[] = compileGuidanceActions(nodes, compileDeps);

  // 2. Skill index (incl. SKILL.md-referenced executables) — shared by coverage + bypass.
  const skillIndex = buildLaneSkillIndex(ctx.model, lane, ctx.reader);

  // 3. Skill-bypass detection over the DB spine (§2.4) — the read-comments.py signal.
  const bypass = detectSkillBypass(lane, skillIndex, {
    execEvents: toBypassExecEvents(queryBypassExecEvents(ctx.db, lane)),
    windows: querySkillInvocationWindows(ctx.db, lane),
    exposures: querySkillLaneExposures(ctx.db, lane, skillIndex.map((s) => s.skillName)),
  });

  // 4. File coverage / file-heat (§2.3). WP-4A: the file-touch corpus is now WORKSPACE-
  //    SCOPED (ctx.scope) — the per-workspace analyze finally scopes BEHAVIOR, not just
  //    resident guidance (spec 250). The honest scope counts ride out on `coverageScope`.
  //    No human ignore rows in the first pass (honest empty → nothing suppressed);
  //    classifyPathMutability from WP0.
  const fileTouches = queryFileTouchesScoped(ctx.db, lane, ctx.scope);
  const coverage = classifyFileCoverage(
    lane,
    aggregateFileTouches(fileTouches.rows),
    actions,
    skillIndex,
    [],
    { classifyPathMutability },
  );

  // 5. Improvisation clusters (§5.3) — uncovered repeated behaviour → ADD candidates.
  const clusters = findImprovisationClusters({
    store: new BehaviorStore(ctx.db),
    isCovered: coverageFromActions(actions),
    lanes: [lane],
  });

  // 6. Config drift (§5.2). `detectConfigDrift` internally loops all GRANT_LANES and
  //    returns findings for every one, but this RawLaneInputs is lane-scoped — keeping
  //    other lanes' findings here made `buildDriftProposals` mint duplicate, cross-lane-
  //    misattributed ids (BUG-43). Scope to this lane at the seam so every consumer of
  //    `lane.drift` sees only this lane's findings.
  const drift = detectConfigDrift(actions, ctx.driftDeps).filter((f) => f.lane === lane);

  // 7. Resident-cost summary + derivation state.
  const resident = buildLaneResidentSummary(agent, ctx.db, lane);
  const derivation = honestDerivation(lane);

  // 8. WP-E (P4) grant-mismatch sizing seams — resolve a drift source anchor to its
  //    containing RESIDENT section text (spans only), sized via the shared TokenEstimator.
  //    Path keys are normalized to forward slashes so Windows drift anchors match.
  const residentTextByPath = new Map<string, string>();
  for (const t of ctx.residentTargets) residentTextByPath.set(t.sourcePath.replace(/\\/g, '/'), t.text);

  // 9. WP-3 (P3, step 1): per-toolset schema residency, so `subtract-unused-toolset` sizes
  //    the delta by real schema cost (not the guidance-section fallback). Keyed by the same
  //    toolset resolution the compiler used, so the engine's join hits.
  const resolveToolset = (displayName: string) => ctx.mcpServerResolver(displayName)?.toolset ?? null;
  const toolsetResidentTokens = buildToolsetResidentTokens(agent, resolveToolset);

  // 10. WP-3 (P3, steps 2–3): first-class resident assets + the skill-advertisement usage
  //     join. Toolset deadness stays with the occurrence engine (subtract-unused-toolset);
  //     the usage join backs only the NEW subtract-unused-skill-advertisement path.
  const residentAssets = buildResidentAssets(agent, lane, resolveToolset);
  const residentAssetUsage = joinSkillAdvertisementUsage(ctx.db, lane, residentAssets);

  return {
    lane,
    resident,
    actions,
    clusters,
    bypass,
    drift,
    coverage,
    coverageScope: fileTouches.scope,
    derivation,
    residentSectionTextAt: (absPath, line) => {
      const text = residentTextByPath.get(absPath.replace(/\\/g, '/'));
      if (!text) return null;
      const sec = findSectionContainingLine(text, line);
      return sec ? `${sec.rawHeadingLine}\n${sec.body}` : null;
    },
    estimateTokens: (text) => ctx.estimator.estimate(text).tokens,
    // Empty ⇒ omit, preserving the engine's honest per-action fallback (never a 0 delta).
    toolsetResidentTokens: Object.keys(toolsetResidentTokens).length ? toolsetResidentTokens : undefined,
    residentAssets: residentAssets.length ? residentAssets : undefined,
    residentAssetUsage: residentAssetUsage.length ? residentAssetUsage : undefined,
    // cost omitted (first pass) — the engine falls back honestly.
  };
}

/** Assemble every real persona lane present in the scan. */
export function assembleAllLaneInputs(ctx: AssembleContext): RawLaneInputs[] {
  const out: RawLaneInputs[] = [];
  for (const lane of REAL_LANES) {
    const raw = assembleRawLaneInputs(lane, ctx);
    if (raw) out.push(raw);
  }
  return out;
}
