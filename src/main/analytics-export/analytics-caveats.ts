// analytics-caveats.ts — the mandatory caveat registry (plan §3.1).
//
// EVERY entry here is emitted on EVERY snapshot, unconditionally. `observed` and
// `matchedIds` enrich an entry when its predicted condition actually occurs; they
// never gate whether it appears. An empty proposal set does not make the
// derivation-gate wiring defect disappear, and the reader of a zero-row surface
// needs the warning most.
//
// Three entries carry a severity PROMOTION rule: they ship advisory in steady
// state and become `blocking` when their stated condition holds. Promotion is a
// pure function of the observed snapshot state — never an operator flag.
//
// Every `evidence` file:line below was opened and confirmed to say what its
// statement claims (plan §7 task 9).
//
// Pure. No IO, no Electron, no database.

import type { SnapshotCaveatV1, CaveatSeverity, SurfaceKey, GUIDANCE_INVENTORY_SURFACE_KEY } from './analytics-types';

// ── caveat ids ────────────────────────────────────────────────────────────────

export const CAVEAT_IDS = [
  'DERIVATION_GATE_ALWAYS_UNVERIFIED',
  'IMPROVISATION_CLUSTER_INCLUDES_ROUTINE_TOOL_USE',
  'CROSS_SURFACE_COUNTS_NOT_COMPARABLE',
  'SYSTEM_BASELINE_EXCLUDED',
  'TOKEN_COUNTS_ESTIMATED',
  'INDEX_BACKFILL_SKIPPED_READ_ONLY',
  'INDEX_INCOMPLETE',
  'FILESYSTEM_CAPTURE_NOT_ATOMIC',
  'GIT_SHA_UNAVAILABLE',
  'REDACTION_IS_LOSSY',
  'FOREIGN_WORKSPACE_STREAM_IDS_DROPPED',
  'AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED',
  'TOOL_ERROR_RATES_UNAVAILABLE',
] as const;

export type CaveatId = typeof CAVEAT_IDS[number];

/** Blocking in EVERY snapshot, regardless of observed state. A test asserts
 *  these cannot be removed.
 *
 *  WP8 (G8) removed CROSS_SURFACE_COUNTS_NOT_COMPARABLE from this list: it now
 *  carries a CONDITION-DOWNGRADE (never a removal) — advisory only between
 *  surfaces whose `comparabilityKey`s are identical, computed from the keys by
 *  `comparabilityKeysIdentical`, never hardcoded. Absent or differing keys keep
 *  it blocking (fail-closed). */
export const ALWAYS_BLOCKING_CAVEAT_IDS: CaveatId[] = [
  'DERIVATION_GATE_ALWAYS_UNVERIFIED',
  'IMPROVISATION_CLUSTER_INCLUDES_ROUTINE_TOOL_USE',
  'SYSTEM_BASELINE_EXCLUDED',
];

/** Observed conditions that drive the three severity promotions. */
export interface CaveatConditions {
  /** `provenance.indexState.epochsBackfilled` */
  epochsBackfilled: boolean;
  /** `provenance.indexState.skillIndexComplete` */
  skillIndexComplete: boolean;
  /** The overhead model's estimator method. Anything other than the exact
   *  `count_tokens` path promotes TOKEN_COUNTS_ESTIMATED to blocking. */
  estimatorMethod: string;
  /** Null git sha → GIT_SHA_UNAVAILABLE is observed. */
  gitShaAvailable: boolean;
  /** Ids of `add-cluster-rollup` proposals present in this snapshot. */
  clusterRollupProposalIds: string[];
  /** Ids of proposals carrying `verified:false` — i.e. all of them, on this path. */
  unverifiedProposalIds: string[];
  /** How many foreign-workspace stream ids the exporter belt removed from the capped
   *  sample lists. Aggregates are untouched; this discloses the sample shortfall. */
  foreignStreamIdsDropped: number;
  /** WP2 — how many ANALYZED (directory-chain) AGENTS.md guidance sources lack
   *  `complete` capture coverage of their provider audience. >0 keeps
   *  AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED observed. */
  agentsMdSourcesWithoutCompleteCoverage: number;
  /** WP8 — each surface's `provenance.comparabilityKey`. Optional (older
   *  callers / snapshots without surface provenance): ABSENT keys can never
   *  demote a caveat — fail-closed toward blocking. */
  surfaceComparabilityKeys?: Partial<Record<SurfaceKey, string>>;
}

/**
 * WP8 — the ONLY demotion predicate: every listed surface has a non-empty
 * comparabilityKey and all of them are IDENTICAL. Computed from the keys, never
 * hardcoded; a missing key (no provenance) reads as not-comparable. Because the
 * key hashes the population as well as the window, two surfaces whose windows
 * merely share dates but whose populations differ get different keys — date
 * coincidence can never lift a caveat through this predicate.
 */
export function comparabilityKeysIdentical(
  keys: Partial<Record<SurfaceKey, string>> | undefined,
  surfaces: SurfaceKey[],
): boolean {
  if (!keys || surfaces.length === 0) return false;
  const got = surfaces.map((s) => keys[s]);
  if (!got.every((k): k is string => typeof k === 'string' && k.length > 0)) return false;
  return new Set(got).size === 1;
}

// ── the registry ──────────────────────────────────────────────────────────────

interface CaveatSpec {
  id: CaveatId;
  baseSeverity: CaveatSeverity;
  surfaces: Array<SurfaceKey | '*'>;
  fields: string[];
  statement: string;
  evidence: Array<{ file: string; lines: string }>;
  /** Promotion rule; absent ⇒ severity is always `baseSeverity`. */
  promoteWhen?: (c: CaveatConditions) => boolean;
  /** WP8 — condition-downgrade to advisory when EVERY governed surface carries
   *  the same comparabilityKey. The predicate is always
   *  `comparabilityKeysIdentical(conditions.surfaceComparabilityKeys, spec.surfaces)`
   *  — computed from the keys, never an operator flag, never hardcoded. Only
   *  meaningful on a spec whose `surfaces` has no `'*'`. */
  demoteWhenComparable?: boolean;
  /** Did the predicted condition occur in THIS snapshot. */
  observedWhen?: (c: CaveatConditions) => boolean;
  matchedIdsOf?: (c: CaveatConditions) => string[];
}

const SPECS: CaveatSpec[] = [
  {
    id: 'DERIVATION_GATE_ALWAYS_UNVERIFIED',
    baseSeverity: 'blocking',
    surfaces: ['optimizer'],
    fields: ['/proposals/*/parityStatus', '/proposals/*/verified', '/meta/parityStatus'],
    statement:
      'No proposal on this code path can EVER report verified:true. assembleLaneInputs '
      + 'calls honestDerivation(), which hard-returns verified:false for every lane, and '
      + 'the read-only analyze this snapshot uses consumes that assembly unchanged. A '
      + "'candidate-unverified' or 'unverified-no-reference' state here is a WIRING "
      + 'LIMITATION, not a statement about evidence strength. Do not read a zero '
      + "verified-count as \"nothing qualifies\", and do not restate verified:false as "
      + '"low confidence", "unverified (pending)", or any other gradable score — it is a '
      + 'wiring state, not a score.',
    evidence: [
      { file: 'src/main/context-optimizer/optimizer-assemble.ts', lines: '136-147' },
      { file: 'src/main/context-optimizer/optimizer-live-analyze.ts', lines: '45-70' },
      { file: 'plans/context-overhead-review.md', lines: '§10.4(3)' },
    ],
    observedWhen: (c) => c.unverifiedProposalIds.length > 0,
    matchedIdsOf: (c) => c.unverifiedProposalIds,
  },
  {
    id: 'IMPROVISATION_CLUSTER_INCLUDES_ROUTINE_TOOL_USE',
    baseSeverity: 'blocking',
    surfaces: ['optimizer'],
    fields: ['/clusterExemplars', '/proposals[kind=add-cluster-rollup]'],
    statement:
      'The add-improvisation lever fires on ORDINARY tool use. Clustering by '
      + 'input_shape_hash cannot distinguish improvisation from routine calls; the '
      + 'observed top members were Bash(command,description) x2554, Edit(...) x1402 and '
      + 'Read(file_path) x1070. Those occurrence counts are baseline activity, not a '
      + 'missing-guidance opportunity. NO add-cluster-rollup proposal may motivate work, '
      + 'and its occurrence count is diagnostic only — it never appears in a headline '
      + 'row, a summary CSV, or a diff percentage. One member (Bash, inputKeys:[], x318) '
      + 'also looks like a parse artifact rather than a real call shape.',
    evidence: [
      { file: 'plans/context-overhead-review.md', lines: '§10.4(1)' },
      { file: 'src/main/context-optimizer/improvisation-clusters.ts', lines: 'whole file' },
    ],
    observedWhen: (c) => c.clusterRollupProposalIds.length > 0,
    matchedIdsOf: (c) => c.clusterRollupProposalIds,
  },
  {
    id: 'CROSS_SURFACE_COUNTS_NOT_COMPARABLE',
    baseSeverity: 'blocking',
    surfaces: ['optimizer', 'mcpToolUsage'],
    fields: ['/clusterExemplars/*/rollup/count', '/rollup/byTool/*/count'],
    statement:
      'get_mcp_tool_usage and the optimizer cluster exemplars disagree on the same verb '
      + '(read_agent_chat 471 vs 576; stop_agent 199 vs 341) — historically NEITHER '
      + 'declared its scope or its time window; each now declares both on its '
      + '`provenance` (WP8). NEVER combine counts from these two surfaces in one claim, '
      + 'ratio, or delta — no renderer, summary row, CSV row, or diff row in this '
      + 'snapshot does so, and a reader must not either — UNLESS both surfaces carry an '
      + 'IDENTICAL provenance.comparabilityKey (same workspace scope, population, '
      + 'window, and anchor), in which case this caveat is emitted as advisory. The '
      + 'downgrade is computed from the keys; matching dates alone never qualify, '
      + 'because the key hashes the population too.',
    evidence: [
      { file: 'plans/context-overhead-review.md', lines: '§10.4(2)' },
      { file: 'src/main/analytics-export/analytics-types.ts', lines: 'computeComparabilityKey' },
    ],
    // Observed/severity are computed generically in buildCaveats from THIS
    // spec's own `surfaces` list and the conditions' comparability keys.
    demoteWhenComparable: true,
  },
  {
    id: 'SYSTEM_BASELINE_EXCLUDED',
    baseSeverity: 'blocking',
    surfaces: ['contextOverhead'],
    fields: ['/agents/*/total', '/agents/*/residentTotal', '/agents/*/onDemandTotal', '/systemBaseline'],
    statement:
      "Every overhead total in this snapshot is AGENT-VARIABLE ONLY. Claude Code's own "
      + 'base prompt and built-in tool schemas are excluded from the analyzer and are '
      + 'measured by nobody (~29k of a ~46.35k supervisor startup prompt). Any '
      + 'percentage-of-context figure computed from this surface alone is WRONG: these '
      + 'totals are a floor, not a total.',
    evidence: [
      { file: 'src/main/context-overhead/context-overhead-analyzer.ts', lines: '1-7' },
      { file: 'src/shared/types.ts', lines: '1680-1688' },
      { file: 'plans/analytics-export-work-item.md', lines: '§6' },
    ],
  },
  {
    id: 'TOKEN_COUNTS_ESTIMATED',
    baseSeverity: 'advisory',
    surfaces: ['contextOverhead', 'optimizer'],
    fields: ['/agents/*/total/tokens', '/estimatorMethod'],
    statement:
      'Token figures are cl100k_base ESTIMATES with a chars-heuristic fallback when '
      + 'js-tiktoken cannot load. The exact count_tokens path is built but inert '
      + '(Phase-3), so estimator drift versus real tokenization is currently '
      + 'unfalsifiable. Promoted to blocking whenever estimatorMethod is not '
      + "'anthropic-count-tokens'.",
    evidence: [
      { file: 'src/main/context-overhead/ipc-deps.ts', lines: '27-40' },
      { file: 'src/main/context-overhead/token-estimator.ts', lines: 'whole file' },
    ],
    promoteWhen: (c) => c.estimatorMethod !== 'anthropic-count-tokens',
    observedWhen: (c) => c.estimatorMethod !== 'anthropic-count-tokens',
  },
  {
    id: 'INDEX_BACKFILL_SKIPPED_READ_ONLY',
    baseSeverity: 'advisory',
    surfaces: ['optimizer'],
    fields: ['/proposals/*/confidence', '/analyzability', '/meta/insufficientExposureCount'],
    statement:
      'The exporter runs strictly read-only and NEVER repairs or refreshes an index: it '
      + "passes backfillMode:'skip', which suppresses the one-shot cold-start epoch "
      + 'backfill (the only writer on the analyze path). In steady state that skip is a '
      + 'guaranteed no-op. If provenance.indexState.epochsBackfilled is false this '
      + 'snapshot is DEGRADED — every section reads insufficient-exposure and no SUBTRACT '
      + 'can reach never, so subtract classification is unreliable.',
    evidence: [
      { file: 'src/main/context-optimizer/optimizer-pipeline.ts', lines: '1038-1056' },
      { file: 'src/main/context-optimizer/config-epoch-backfill.ts', lines: '158-191' },
    ],
    promoteWhen: (c) => c.epochsBackfilled === false,
    observedWhen: (c) => c.epochsBackfilled === false,
  },
  {
    id: 'INDEX_INCOMPLETE',
    baseSeverity: 'advisory',
    surfaces: ['skillUsage', 'mcpToolUsage'],
    fields: ['/rows/*/count', '/rollup/byTool/*/count', '/rollup/tierBreakdown'],
    statement:
      'Skill and MCP-tool usage reflect whatever the parse index contains RIGHT NOW; the '
      + 'exporter never calls ensureIndexed() and never triggers indexing. An incomplete '
      + 'index reads as LOW USAGE, not as an error — a zero row may mean "never used" or '
      + '"not yet parsed", and this surface cannot tell you which. Promoted to blocking '
      + 'when provenance.indexState.skillIndexComplete is false.',
    evidence: [
      { file: 'src/main/api-server.ts', lines: '636-656' },
      { file: 'src/main/skill-analytics/parse-manager.ts', lines: '90-118' },
    ],
    promoteWhen: (c) => c.skillIndexComplete === false,
    observedWhen: (c) => c.skillIndexComplete === false,
  },
  {
    id: 'FILESYSTEM_CAPTURE_NOT_ATOMIC',
    baseSeverity: 'advisory',
    surfaces: ['*'],
    fields: ['/captureStartedAtIso', '/captureCompletedAtIso'],
    statement:
      'Database-backed surfaces are pinned by one read-only connection and ALL optimizer '
      + 'surfaces derive from a single in-memory analysis, so they are mutually '
      + 'consistent. Filesystem inputs (CLAUDE.md files, skills, personas, plan HTML) are '
      + 'read across the captureStartedAtIso -> captureCompletedAtIso interval and are '
      + 'NOT transactionally simultaneous. A file edited mid-capture may appear in one '
      + 'surface and not another.',
    evidence: [
      { file: 'plans/analytics-export-implementation.md', lines: '§3.1 FILESYSTEM_CAPTURE_NOT_ATOMIC' },
    ],
    observedWhen: () => true,
  },
  {
    id: 'GIT_SHA_UNAVAILABLE',
    baseSeverity: 'advisory',
    surfaces: ['*'],
    fields: ['/provenance/workspaceGitSha'],
    statement:
      'The workspace git SHA could not be read, so this snapshot cannot be tied to a '
      + 'commit. Any before/after comparison against it is comparing two unlabelled '
      + 'points in time.',
    evidence: [
      { file: 'plans/analytics-export-implementation.md', lines: '§3 provenance.workspaceGitSha' },
    ],
    observedWhen: (c) => !c.gitShaAvailable,
  },
  {
    id: 'REDACTION_IS_LOSSY',
    baseSeverity: 'advisory',
    surfaces: ['*'],
    fields: ['/**/pathDisplay', '/**/pathScope', '/**/pathHash'],
    statement:
      'Paths are scope-prefixed ($WORKSPACE / $DASHBOARD / $SKILL / ~ / external) and raw '
      + 'snippets, patches and file bodies are suppressed. Redaction is LOSSY AND ONE-WAY: '
      + 'home and external paths intentionally discard components, and the absolute '
      + 'workspace root is not recorded anywhere in this snapshot — so absolute paths are '
      + 'NOT recoverable from it, not even by joining against the manifest. Join on '
      + 'pathHash for identity instead. Claude PROJECT SLUGS are part of that guarantee: a '
      + 'slug is a lossless encoding of an absolute working directory (only [/\\:_.] is '
      + 'rewritten to "-"), which the path redactor cannot recognise as a path, so this '
      + 'exporter replaces every slug — in a stream id (~/.claude/projects/<slug>/…), in a '
      + 'bare slug/workspaceKey value, and in a usage group key — with a stable '
      + '<slug-xxxxxxxx> digest. Stable means distinct projects stay distinguishable across '
      + 'snapshots and in diff; the drive, username and workspace root do not survive it.',
    evidence: [
      { file: 'src/main/context-optimizer/agent-dto.ts', lines: '506-580' },
      { file: 'src/main/supervisor/log-readers/claude-jsonl-reader.ts', lines: '49-53' },
      { file: 'src/main/analytics-export/analytics-exporter.ts', lines: '269-295' },
    ],
    observedWhen: () => true,
  },
  {
    id: 'FOREIGN_WORKSPACE_STREAM_IDS_DROPPED',
    baseSeverity: 'advisory',
    surfaces: ['*'],
    fields: [
      '/**/attribution/streamIds', '/**/denominator/sampledStreams', '/**/numerator/sampledEvents',
    ],
    statement:
      'Behaviour evidence is scored over the WHOLE Claude corpus on the machine, so a '
      + "strict-scope proposal's exposure denominator legitimately spans OTHER workspaces. "
      + 'The aggregate is wanted; the identifiers are not — a stream id names an unrelated '
      + 'project — so foreign-workspace ids are REMOVED from this snapshot. Only the capped '
      + 'SAMPLE lists shrink. Every aggregate beside them (denominator.turns/streams/slugs, '
      + 'numerator.occurrences/streams, exposure.turns/streams/slugs) is computed upstream '
      + 'of the sample and is UNCHANGED, so no count, rate or ratio here is affected. A '
      + 'sample list may therefore hold fewer entries than the count printed next to it: '
      + 'that gap is this drop, not a short corpus. Do not treat the surviving sample as a '
      + 'complete enumeration of the streams behind a denominator — it never was.',
    evidence: [
      { file: 'src/main/context-optimizer/context-optimizer.ts', lines: '628-632' },
      { file: 'src/main/analytics-export/analytics-exporter.ts', lines: '327-371' },
      { file: 'src/shared/types.ts', lines: '2293-2300' },
    ],
    observedWhen: (c) => c.foreignStreamIdsDropped > 0,
  },
  {
    id: 'AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED',
    baseSeverity: 'advisory',
    surfaces: ['contextOverhead', 'optimizer', 'agentKnowledge'],
    fields: [
      '/agents/*/guidanceSources', '/agents/*/configWeight/tokensByClassByFileKind/agents-md',
      '/proposals/*/occurrence', '/*/nodes/*/audienceProviders',
    ],
    statement:
      'At least one analyzed AGENTS.md guidance source lacks `complete` capture coverage '
      + 'of its provider audience. `observed` coverage is PRESENCE (≥1 captured stream '
      + 'whose provider is in the audience), never completeness — `complete` requires a '
      + 'measured denominator (the capture source enumerating every stream in the analysis '
      + "window), which this snapshot's capture sources do not provide. Consequently NO "
      + 'AGENTS.md-derived guidance can reach a dead/never verdict here: every provisional '
      + 'never is downgraded to capture-incomplete by the WP2 explicit gate '
      + '(occurrence-classifier.ts). Do not read the absence of AGENTS.md dead-weight '
      + 'findings as "all AGENTS.md guidance is live".',
    evidence: [
      { file: 'src/main/context-optimizer/occurrence-classifier.ts', lines: 'resolveCaptureCoverage / audience never-gate' },
      { file: 'src/main/context-overhead/guidance-sources.ts', lines: 'whole file' },
    ],
    observedWhen: (c) => c.agentsMdSourcesWithoutCompleteCoverage > 0,
  },
  {
    // WP9 (G9) — the explicit deferral: per-tool error rates are NOT computed
    // anywhere in this snapshot, and the fileSequences block in particular
    // carries none. Advisory because it discloses a permanent absence, not a
    // degraded measurement.
    id: 'TOOL_ERROR_RATES_UNAVAILABLE',
    baseSeverity: 'advisory',
    surfaces: ['optimizer', 'mcpToolUsage'],
    fields: ['/fileSequences', '/rollup/byTool'],
    statement:
      'No surface in this snapshot reports a per-tool error rate, and none can: '
      + "`tool_result` behavior_events rows carry no tool_name link back to the "
      + 'originating call (mcp-tool-usage-queries.ts:18-19), so an error cannot be '
      + 'attributed to a specific tool without inventing the join. The WP9 '
      + 'fileSequences block (co-touch / predecessor / command-family association) '
      + 'therefore describes WHAT ran near what — never how often a tool FAILED. Do '
      + 'not derive an error or retry rate from any count here.',
    evidence: [
      { file: 'src/main/skill-analytics/mcp-tool-usage-queries.ts', lines: '18-19' },
      { file: 'src/main/context-optimizer/behavior-sequences.ts', lines: 'whole file' },
    ],
    observedWhen: () => true,
  },
];

// ── build ─────────────────────────────────────────────────────────────────────

/**
 * Build the full registry for one snapshot. ALL entries, ALWAYS — `conditions`
 * only decides severity promotion, `observed`, and `matchedIds`.
 */
export function buildCaveats(conditions: CaveatConditions): SnapshotCaveatV1[] {
  return SPECS.map((spec) => {
    const promoted = spec.promoteWhen ? spec.promoteWhen(conditions) : false;
    // WP8 — the only demotion path: every surface THIS spec governs (its own
    // list, no '*') carries the same comparabilityKey. Computed, never hardcoded;
    // promotion always wins over demotion.
    const concrete = spec.surfaces.filter((s): s is SurfaceKey => s !== '*');
    const demoted = spec.demoteWhenComparable === true
      && concrete.length === spec.surfaces.length
      && comparabilityKeysIdentical(conditions.surfaceComparabilityKeys, concrete);
    const matched = spec.matchedIdsOf ? spec.matchedIdsOf(conditions) : undefined;
    const caveat: SnapshotCaveatV1 = {
      id: spec.id,
      severity: promoted ? 'blocking' : demoted ? 'advisory' : spec.baseSeverity,
      surfaces: [...spec.surfaces],
      fields: [...spec.fields],
      statement: spec.statement,
      evidence: spec.evidence.map((e) => ({ ...e })),
    };
    if (spec.observedWhen) caveat.observed = spec.observedWhen(conditions);
    // A demotable spec's predicted condition is the incomparability itself:
    // observed = keys absent or differing (i.e. NOT demoted).
    else if (spec.demoteWhenComparable === true) caveat.observed = !demoted;
    if (matched && matched.length > 0) caveat.matchedIds = [...matched].sort();
    return caveat;
  });
}

/** Caveat ids governing a surface — `'*'` entries match every surface. WP7:
 *  accepts the optional guidanceInventory key alongside the six core keys. */
export function caveatIdsForSurface(
  caveats: SnapshotCaveatV1[],
  surface: SurfaceKey | typeof GUIDANCE_INVENTORY_SURFACE_KEY,
): string[] {
  return caveats
    .filter((c) => c.surfaces.includes('*') || c.surfaces.includes(surface))
    .map((c) => c.id);
}

export function blockingCaveats(caveats: SnapshotCaveatV1[]): SnapshotCaveatV1[] {
  return caveats.filter((c) => c.severity === 'blocking');
}

export function advisoryCaveats(caveats: SnapshotCaveatV1[]): SnapshotCaveatV1[] {
  return caveats.filter((c) => c.severity === 'advisory');
}
