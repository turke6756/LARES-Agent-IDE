// overhead-dto.ts — agent-facing redacted projection of the Context-Overhead model.
//
// Pure, Electron-free, IO-free (plan §2.3). Shared by the new GET
// /api/context-overhead route and by the frozen-analytics exporter, so route and
// file emit byte-identical redaction — one implementation, two consumers.
//
// The raw `OverheadModel` carries absolute paths in a dozen places (working dirs,
// sidecars, inheritance frame dirs, every source's resolvedPath, MCP configPaths,
// config-weight section sourcePaths). Every one of them is replaced by a scoped
// `FileHeatPath` here; the absolute workspace root never appears in an emitted
// artifact.

import type {
  AgentContextOverhead, AgentRoleLane, ConfigSectionWeight, ConfigWeightRollup,
  GuidanceSource, InheritanceFrame, McpServerOverhead, McpToolOverhead, OverheadModel,
  OverheadSource, SectionWeightClass,
} from '../../shared/types';
import {
  okResponse, redactFileHeatPath, computeGenerationId,
  type FileHeatPath, type RedactionRoots, type AgentDtoResponse,
} from '../context-optimizer/agent-dto';

// ── constant disclosure ───────────────────────────────────────────────────────

/** Always emitted alongside every overhead total. The analyzer measures
 *  agent-VARIABLE overhead only; Claude Code's own base prompt and built-in tool
 *  schemas are measured by nobody. A percentage-of-context computed from this
 *  surface alone is wrong. */
export const SYSTEM_BASELINE_NOTE =
  "agent-variable overhead only — Claude Code's own base prompt and built-in tool "
  + 'schemas are NOT measured by this analyzer (context-overhead-analyzer.ts:6). Any '
  + "'total context' or percentage figure derived from this surface alone is a floor, "
  + 'not a total.';

export const OVERHEAD_ROUTE = '/api/context-overhead';

/** DTO projection version for this surface (folded into `generationId`). */
export const OVERHEAD_DTO_PARSER_VERSION = 1;

// ── row shapes ────────────────────────────────────────────────────────────────

/** Authoritative CONFIGURED grant, read from the grant functions themselves
 *  (`toolsetsForLane` / `laneUsesStrictMcp`). Never derived from a scan. Built by
 *  the exporter, not here — see plan §2.3/§2.6 step 4. */
export interface LaneGrantRow {
  lane: AgentRoleLane;
  toolsets: string[];
  strictMcp: boolean;
}

/** Separately reported: what the scan actually MEASURED. This is NOT the grant. */
export interface MeasuredMcpInventoryRow {
  lane: AgentRoleLane;
  countedServers: string[];
  excludedByStrictMode: string[];
  toolCount: number;
  countedTokens: number;
}

/** WP2 (G2): a GuidanceSource with its absolute paths replaced by scoped display
 *  paths. `fileKind` / `audienceProviders` / applicability model / confidence
 *  survive verbatim — they are identifiers, not paths. */
export interface RedactedGuidanceSource extends Omit<GuidanceSource, 'path' | 'applicability'> {
  source: FileHeatPath;
  applicability: {
    model: GuidanceSource['applicability']['model'];
    chainParentDisplay?: FileHeatPath;
  };
}

export interface RedactedOverheadSource extends Omit<OverheadSource, 'resolvedPath' | 'dedupeKey' | 'children' | 'guidanceSource'> {
  /** null for synthetic sources (MCP server total, system baseline). */
  source: FileHeatPath | null;
  children?: RedactedOverheadSource[];
  guidanceSource?: RedactedGuidanceSource;
}

export interface RedactedInheritanceFrame extends Omit<InheritanceFrame, 'dir' | 'sources'> {
  dirDisplay: FileHeatPath;
  sources: RedactedOverheadSource[];
}

export interface RedactedMcpServerOverhead extends Omit<McpServerOverhead, 'configPath' | 'tools'> {
  configPathDisplay: FileHeatPath | null;
  tools: McpToolOverhead[];
}

/** WP5 (G5): `sectionKey` is additionally OMITTED — it embeds the absolute
 *  source path (the join key is internal; the joined `behaviorStatus` /
 *  `behaviorStatusByCohort` fields survive and are identifier-only). */
export interface RedactedConfigSectionWeight extends Omit<ConfigSectionWeight, 'sourcePath' | 'guidanceSource' | 'sectionKey'> {
  source: FileHeatPath;
  guidanceSource?: RedactedGuidanceSource;
}

export interface RedactedConfigWeightRollup {
  sections: RedactedConfigSectionWeight[];
  tokensByClass: Record<SectionWeightClass, number>;
  /** WP2 (G2, v2-optional): per-fileKind buckets — never summed across keys. */
  tokensByClassByFileKind?: Record<string, Record<SectionWeightClass, number>>;
  /** WP5 (G5, v2-optional): behavior-axis token buckets (all seven keys). */
  tokensByBehavior?: ConfigWeightRollup['tokensByBehavior'];
}

export interface RedactedAgentOverhead extends Omit<AgentContextOverhead,
  'workingDir' | 'sidecarPath' | 'inheritanceChain' | 'mcpServers' | 'flatSources' | 'configWeight' | 'guidanceSources'> {
  workingDirDisplay: FileHeatPath;
  sidecarDisplay?: FileHeatPath;
  inheritanceChain: RedactedInheritanceFrame[];
  mcpServers: RedactedMcpServerOverhead[];
  flatSources: RedactedOverheadSource[];
  configWeight?: RedactedConfigWeightRollup;
  /** WP2 (G2, v2-optional): the agent's composed guidance sources, path-redacted. */
  guidanceSources?: RedactedGuidanceSource[];
}

export interface RedactedOverheadModelV1 {
  workspaceId: string;
  workspaceRootDisplay: '$WORKSPACE';
  pathType: OverheadModel['pathType'];
  generatedAt: string;
  estimatorMethod: OverheadModel['estimatorMethod'];
  /** null when the analyzer did not populate it. NEVER coerced to a zero estimate —
   *  "unmeasured" and "measured as zero" are different facts. */
  systemBaseline: NonNullable<OverheadModel['systemBaseline']> | null;
  systemBaselineNote: string;
  agents: RedactedAgentOverhead[];
  measuredMcpInventory: MeasuredMcpInventoryRow[];
  workspaceConfigWeight: RedactedConfigWeightRollup | null;
  globalWarnings: string[];
}

// ── path scrubbing ────────────────────────────────────────────────────────────

const WINDOWS_ABS = /[A-Za-z]:[\\/][^\s'"]*/g;
const POSIX_HOME_ABS = /\/(?:home|Users|mnt\/[a-z])\/[^\s'"]*/g;

/**
 * Scrub absolute paths out of a free-text string (warnings, structural evidence).
 * These strings are analyzer/document-derived rather than filesystem-derived, so
 * they are usually clean — but "usually" is not a boundary. Structure (line
 * numbers, verdicts, reference names) is preserved; only path-shaped tokens go.
 */
export function scrubPaths(text: string): string {
  return text.replace(WINDOWS_ABS, '<path>').replace(POSIX_HOME_ABS, '<path>');
}

function scrubAll(texts: string[] | undefined): string[] {
  return (texts ?? []).map(scrubPaths);
}

// ── redaction ─────────────────────────────────────────────────────────────────

/** WP2 (G2): redact a GuidanceSource's paths; every non-path field survives. */
function redactGuidanceSource(g: GuidanceSource, roots: RedactionRoots): RedactedGuidanceSource {
  return {
    fileKind: g.fileKind,
    audienceProviders: g.audienceProviders,
    loadingSemanticsConfidence: g.loadingSemanticsConfidence,
    source: redactFileHeatPath(g.path, roots),
    applicability: {
      model: g.applicability.model,
      ...(g.applicability.chainParent
        ? { chainParentDisplay: redactFileHeatPath(g.applicability.chainParent, roots) }
        : {}),
    },
  };
}

function redactSource(src: OverheadSource, roots: RedactionRoots): RedactedOverheadSource {
  const { resolvedPath, dedupeKey, children, warnings, guidanceSource, ...rest } = src;
  return {
    ...rest,
    // Line numbers, kinds, scopes, byte counts, token estimates, inclusion flags,
    // exactness and origin all survive verbatim — only the path is scoped.
    source: resolvedPath ? redactFileHeatPath(resolvedPath, roots) : null,
    ...(warnings ? { warnings: scrubAll(warnings) } : {}),
    ...(children ? { children: children.map((c) => redactSource(c, roots)) } : {}),
    ...(guidanceSource ? { guidanceSource: redactGuidanceSource(guidanceSource, roots) } : {}),
  };
}

function redactFrame(frame: InheritanceFrame, roots: RedactionRoots): RedactedInheritanceFrame {
  const { dir, sources, ...rest } = frame;
  return {
    ...rest,
    dirDisplay: redactFileHeatPath(dir, roots),
    sources: sources.map((s) => redactSource(s, roots)),
  };
}

function redactServer(server: McpServerOverhead, roots: RedactionRoots): RedactedMcpServerOverhead {
  const { configPath, warnings, ...rest } = server;
  return {
    ...rest,
    configPathDisplay: configPath ? redactFileHeatPath(configPath, roots) : null,
    warnings: scrubAll(warnings),
  };
}

function redactRollup(rollup: ConfigWeightRollup, roots: RedactionRoots): RedactedConfigWeightRollup {
  return {
    sections: rollup.sections.map((s): RedactedConfigSectionWeight => {
      // WP5 (G5): `sectionKey` embeds the absolute path — dropped, never emitted.
      const { sourcePath, evidence, guidanceSource, sectionKey, ...rest } = s;
      void sectionKey;
      return {
        ...rest,
        source: redactFileHeatPath(sourcePath, roots),
        evidence: scrubAll(evidence),
        ...(guidanceSource ? { guidanceSource: redactGuidanceSource(guidanceSource, roots) } : {}),
      };
    }),
    tokensByClass: rollup.tokensByClass,
    ...(rollup.tokensByClassByFileKind
      ? { tokensByClassByFileKind: rollup.tokensByClassByFileKind }
      : {}),
    ...(rollup.tokensByBehavior ? { tokensByBehavior: rollup.tokensByBehavior } : {}),
  };
}

function redactAgent(agent: AgentContextOverhead, roots: RedactionRoots): RedactedAgentOverhead {
  const { workingDir, sidecarPath, inheritanceChain, mcpServers, flatSources, configWeight, guidanceSources, warnings, ...rest } = agent;
  return {
    ...rest,
    workingDirDisplay: redactFileHeatPath(workingDir, roots),
    ...(sidecarPath ? { sidecarDisplay: redactFileHeatPath(sidecarPath, roots) } : {}),
    inheritanceChain: inheritanceChain.map((f) => redactFrame(f, roots)),
    mcpServers: mcpServers.map((s) => redactServer(s, roots)),
    flatSources: flatSources.map((s) => redactSource(s, roots)),
    ...(configWeight ? { configWeight: redactRollup(configWeight, roots) } : {}),
    ...(guidanceSources
      ? { guidanceSources: guidanceSources.map((g) => redactGuidanceSource(g, roots)) }
      : {}),
    warnings: scrubAll(warnings),
  };
}

/** Per-lane MEASURED inventory, folded from the scan. Deliberately kept apart from
 *  the configured grant so a reader cannot mistake one for the other: a server can
 *  be granted and excluded-by-strict-mode at once, and this row says which. */
export function buildMeasuredMcpInventory(model: OverheadModel): MeasuredMcpInventoryRow[] {
  const byLane = new Map<AgentRoleLane, MeasuredMcpInventoryRow>();
  for (const agent of model.agents) {
    let row = byLane.get(agent.lane);
    if (!row) {
      row = { lane: agent.lane, countedServers: [], excludedByStrictMode: [], toolCount: 0, countedTokens: 0 };
      byLane.set(agent.lane, row);
    }
    for (const server of agent.mcpServers) {
      const bucket = server.excludedByStrictMode ? row.excludedByStrictMode : row.countedServers;
      if (!bucket.includes(server.displayName)) bucket.push(server.displayName);
      if (!server.excludedByStrictMode) {
        row.toolCount += server.tools.length;
        row.countedTokens += server.total.tokens;
      }
    }
  }
  for (const row of byLane.values()) {
    row.countedServers.sort();
    row.excludedByStrictMode.sort();
  }
  return [...byLane.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}

export function redactOverheadModel(
  model: OverheadModel,
  roots: RedactionRoots,
): RedactedOverheadModelV1 {
  return {
    workspaceId: model.workspaceId,
    // The literal token. The absolute root never crosses this boundary.
    workspaceRootDisplay: '$WORKSPACE',
    pathType: model.pathType,
    generatedAt: model.generatedAt,
    estimatorMethod: model.estimatorMethod,
    systemBaseline: model.systemBaseline ?? null,
    systemBaselineNote: SYSTEM_BASELINE_NOTE,
    agents: model.agents.map((a) => redactAgent(a, roots)),
    measuredMcpInventory: buildMeasuredMcpInventory(model),
    workspaceConfigWeight: model.workspaceConfigWeight
      ? redactRollup(model.workspaceConfigWeight, roots)
      : null,
    globalWarnings: scrubAll(model.globalWarnings),
  };
}

// ── generation identity ───────────────────────────────────────────────────────

/**
 * Content-derived scan identity. Deliberately EXCLUDES `generatedAt`: two scans of
 * an unchanged workspace must yield the same id, or drift detection is impossible
 * and the stability contract at agent-dto.ts:274-283 is contradicted.
 */
export function computeOverheadGenerationId(model: OverheadModel): string {
  const agentDigest = model.agents
    .map((a) => [
      a.id, a.lane, a.total.tokens,
      a.residentTotal?.tokens ?? null,
      a.onDemandTotal?.tokens ?? null,
      a.exactness,
    ])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return computeGenerationId({
    parserVersion: OVERHEAD_DTO_PARSER_VERSION,
    extra: { route: OVERHEAD_ROUTE, workspaceId: model.workspaceId, agentDigest },
  });
}

// ── envelope ──────────────────────────────────────────────────────────────────

export function buildOverheadSnapshot(
  model: OverheadModel,
  roots: RedactionRoots,
): AgentDtoResponse<RedactedOverheadModelV1> {
  const data = redactOverheadModel(model, roots);
  return okResponse(data, {
    meta: {
      generatedAtIso: model.generatedAt,
      generationId: computeOverheadGenerationId(model),
      parserVersion: OVERHEAD_DTO_PARSER_VERSION,
      dataState: data.agents.length > 0 ? 'ready' : 'empty',
      // A filesystem scan has no parity reference to check against — that is a
      // *structural* absence, not a weak score. Reported as the union's own
      // no-reference state rather than dressed up as a confidence level.
      parityStatus: { verified: false, state: 'unverified-no-reference' },
      insufficientExposureCount: 0,
      notAnalyzableCount: 0,
      unverifiedSuppressedCount: 0,
    },
    warnings: data.globalWarnings.map((message) => ({ code: 'OVERHEAD_SCAN_WARNING', message })),
  });
}
