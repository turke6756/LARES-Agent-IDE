// analytics-types.ts — the frozen-analytics snapshot schema (plan §3).
//
// `snapshot.json` is the canonical, complete document and the SOLE authority for
// diffing. `manifest.json` is a small provenance/caveat/index file that doubles as
// the pruning marker. `surfaces/*.json`, `SUMMARY.md` and `tables/*.csv` are
// derived and must be reproducible from `snapshot.json`.
//
// Pure types + canonical hashing. No IO, no Electron.

import { createHash } from 'crypto';
import type { AgentRoleLane } from '../../shared/types';
import type { AgentDtoMeta } from '../context-optimizer/agent-dto';
import type { RedactedOverheadModelV1 } from '../context-overhead/overhead-dto';
import type { GuidanceInventoryV1 } from '../context-overhead/guidance-inventory';
import type { FileSequencesV1 } from '../context-optimizer/behavior-sequences';

// WP-S — ONE coordinated schema v2 for the whole context-analytics program.
// Every field added by WP2/3/5/6/7/8/9/12/15 is OPTIONAL in v2; later WPs add
// their v2-optional fields plus a `capabilities` entry WITHOUT incrementing this
// version again. Exactly one version increment across the program.
export const ANALYTICS_SCHEMA_VERSION = 2;
export const SNAPSHOT_MANIFEST_KIND = 'analytics-snapshot';

// ── WP-S capability signaling ─────────────────────────────────────────────────
// One stable name per populating WP. A capability appears in
// `snapshot.capabilities` / `manifest.capabilities` iff that WP's fields are
// POPULATED in this snapshot. Readers must check `capabilities` before relying
// on a v2-optional field; two v2 snapshots can never silently differ in
// contract (analytics-diff discloses CAPABILITY_MISMATCH).
export const SNAPSHOT_CAPABILITIES = [
  'agents-md-sources',        // WP2
  'recommendation-drafts',    // WP3
  'section-behavior-status',  // WP5
  'file-heat-extended',       // WP6
  'guidance-inventory',       // WP7
  'surface-provenance',       // WP8
  'file-sequences',           // WP9
  'derivation-review-state',  // WP12
  'full-population-tables',   // WP15
] as const;
export type SnapshotCapability = typeof SNAPSHOT_CAPABILITIES[number];

/** `20260719T184455123Z-7e30a8c1` — lexically sortable by capture time. The
 *  pruner will only ever delete a directory matching this exact shape. */
export const SNAPSHOT_DIR_RE = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;

export type SurfaceStatus = 'ready' | 'partial' | 'degraded' | 'empty' | 'error';

export interface SurfaceError {
  code: string;
  /** Sanitized — never carries an absolute path. */
  message: string;
  itemId?: string;
}

export interface SnapshotSurface<T> {
  status: SurfaceStatus;
  generationId: string;
  data: T | null;
  errors: SurfaceError[];
  caveatIds: string[];
  /** WP8 (G8, v2-optional): what this surface measured, over which window, with
   *  the comparability key. Always emitted by this exporter version (capability
   *  'surface-provenance'); optional so older v2 snapshots remain valid. */
  provenance?: SurfaceProvenanceV1;
}

export type CaveatSeverity = 'blocking' | 'advisory';

export interface SnapshotCaveatV1 {
  id: string;
  severity: CaveatSeverity;
  /** Surface keys this caveat governs; `'*'` matches all. */
  surfaces: string[];
  /** JSON-pointer-ish targets within those surfaces. */
  fields: string[];
  statement: string;
  evidence: Array<{ file: string; lines: string }>;
  /** Did the predicted condition actually occur in THIS snapshot. */
  observed?: boolean;
  /** e.g. the proposal ids that trip it. */
  matchedIds?: string[];
}

export interface LaneGrantEntry {
  toolsets: string[];
  strictMcp: boolean;
}

// ── WP8 (G8) — per-surface provenance + comparability keys ────────────────────
// Every surface declares WHAT population it measured, over WHICH window, anchored
// to the snapshot's single clock stamp — and a `comparabilityKey` hashed over all
// of it. Counts from two surfaces are comparable ONLY when their full keys are
// identical; comparability is decidable from the surface JSON alone. Date
// coincidence can never fake it: the key hashes the population too, so two
// surfaces with the same window but different populations get different keys.

/** ISO stand-in for "everything the store has ever recorded" — the honest
 *  windowStart of a surface whose query has no time filter. */
export const ALL_RECORDED_HISTORY_START = '1970-01-01T00:00:00.000Z';

/** The population one surface draws from. Arrays are sorted at construction so
 *  the key is order-independent. */
export interface SurfacePopulationV1 {
  /** Agent-role lanes contributing rows ([] = the surface is not lane-scoped). */
  lanes: string[];
  /** Agent providers whose data can appear (e.g. 'claude'; 'any-registered-agent'
   *  for filesystem-config surfaces that are provider-agnostic). */
  providers: string[];
  /** Where the rows physically come from (e.g. 'filesystem-scan',
   *  'behavior-events-sqlite', 'mcp-tool-events-index'). */
  captureSources: string[];
  /** Query-level filters applied, as stable `name:value` strings. The
   *  strict-workspace MCP scope is declared HERE, explicitly. */
  filters: string[];
}

export interface SurfaceProvenanceV1 {
  /** The workspace scoping every query on this surface ran under. `scopeMode`
   *  is the exporter's strict-workspace policy made explicit per surface. */
  workspaceScope: { workspaceId: string; scopeMode: 'strict-workspace' };
  population: SurfacePopulationV1;
  /** Inclusive start of the data window (ISO). `ALL_RECORDED_HISTORY_START` when
   *  the surface's query has no time filter; equal to `windowEnd` for a
   *  point-in-time (current-state) surface. */
  windowStart: string;
  /** EXCLUSIVE end of the data window (ISO) — always the snapshot anchor. */
  windowEnd: string;
  /** The snapshot's single clock stamp, computed ONCE at export start and passed
   *  to every builder. Identical across all surfaces of one snapshot. */
  snapshotAnchor: string;
  /** sha256 over the canonical JSON of everything above. NEVER hand-built. */
  comparabilityKey: string;
}

/** The hash input — provenance minus the key itself. */
export type SurfaceProvenanceKeyInput = Omit<SurfaceProvenanceV1, 'comparabilityKey'>;

/**
 * The ONLY way a comparabilityKey is produced: sha256 over the canonical JSON of
 * the full provenance (scope + population + window + anchor). Computed, never
 * hardcoded — equality of keys IS the comparability decision.
 */
export function computeComparabilityKey(input: SurfaceProvenanceKeyInput): string {
  return sha256Of({
    workspaceScope: input.workspaceScope,
    population: {
      lanes: [...input.population.lanes].sort(),
      providers: [...input.population.providers].sort(),
      captureSources: [...input.population.captureSources].sort(),
      filters: [...input.population.filters].sort(),
    },
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    snapshotAnchor: input.snapshotAnchor,
  });
}

/** Assemble a full provenance: sort the population arrays, compute the key. */
export function buildSurfaceProvenance(input: SurfaceProvenanceKeyInput): SurfaceProvenanceV1 {
  const normalized: SurfaceProvenanceKeyInput = {
    workspaceScope: { ...input.workspaceScope },
    population: {
      lanes: [...input.population.lanes].sort(),
      providers: [...input.population.providers].sort(),
      captureSources: [...input.population.captureSources].sort(),
      filters: [...input.population.filters].sort(),
    },
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    snapshotAnchor: input.snapshotAnchor,
  };
  return { ...normalized, comparabilityKey: computeComparabilityKey(normalized) };
}

// ── WP6 (G6) — per-table truncation metadata ──────────────────────────────────
// Machine-readable disclosure that a `tables/*.csv` artifact is (or is not) the
// full population — never conflatable with a full drain. Emitted per table in
// `manifest.json` AND on the snapshot's surface provenance.

/** How a table's row set was produced relative to its population. The
 *  before-WP15 values are `'truncate-then-paginate'` (file-heat: the engine
 *  slices to top-N per lane, THEN the exporter paginates the truncated set to
 *  exhaustion) and `'single-object-truncated'` (mcp-tool: one rollup object with
 *  a capped `byTool`). WP15 flips them to `'paginate-full-population'` /
 *  `'single-object-full'`. */
export type TablePaginationOrder =
  | 'truncate-then-paginate'
  | 'paginate-full-population'
  | 'single-object-truncated'
  | 'single-object-full';

export interface TableTruncationMetaV1 {
  /** Rows in the FULL population the table was drawn from — `null` when the
   *  producing layer did not disclose it (honest unknown, never a guess). */
  populationAvailable: number | null;
  /** Rows actually written to the CSV. */
  rowsEmitted: number;
  /** `populationAvailable > rowsEmitted`; `null` when the population is unknown
   *  (unknown is NOT "not truncated"). */
  truncated: boolean | null;
  /** The cap that governed the truncation stage (per-lane for file-heat). */
  limit: number;
  paginationOrder: TablePaginationOrder;
}

export interface SnapshotProvenance {
  workspace: { id: string; root: '$WORKSPACE'; pathType: 'windows' | 'wsl' };
  workspaceGitSha: string | null;
  workspaceGitBranch: string | null;
  workspaceGitDirty: boolean | null;
  appVersion: string;
  exporterVersion: 1;
  databaseMode: 'readonly-query-only';
  backfillMode: 'skip';
  scopeMode: 'strict';
  redactionPolicy: 'agent-safe-v1';
  /** Authoritative CONFIGURED grant — toolsetsForLane() / laneUsesStrictMcp().
   *  Never derived from the scan (that is `measuredMcpInventory`). */
  laneGrantMatrix: Record<AgentRoleLane, LaneGrantEntry>;
  indexState: { epochsBackfilled: boolean; skillIndexComplete: boolean };
  generationIds: Record<string, string>;
  /** WP6 (G6, v2-optional): per-table truncation disclosure, keyed by the
   *  `tables/` filename (e.g. `'file-heat.csv'`). Always emitted by this
   *  exporter version; optional so older v2 snapshots remain valid. */
  tableTruncation?: Record<string, TableTruncationMetaV1>;
  /** WP8 (G8, v2-optional): the ONE clock stamp every surface builder received.
   *  A long-running export cannot give surfaces drifting "now"s — every
   *  surface's `provenance.snapshotAnchor` equals this value. */
  snapshotAnchor?: string;
  /** WP8 (G8, v2-optional): the `--window <days>` the CLI requested, or null
   *  when none was given. Disclosed even when no surface could honor it — each
   *  surface's TRUE window lives on its own provenance. */
  requestedWindowDays?: number | null;
}

export interface OptimizerSurfaceData {
  proposals: unknown[];
  proposalDetails: Record<string, unknown>;
  proposalEvidence: Record<string, unknown>;
  clusterExemplars: Record<string, unknown>;
  fileHeatHot: unknown[];
  fileHeatGuidanceGaps: unknown[];
  analyzability: unknown[];
  meta: AgentDtoMeta | null;
  /** WP9 (G9, v2-optional, capability 'file-sequences'): sequence/co-touch +
   *  command-family association block (behavior-sequences.ts). Absent on older
   *  v2 snapshots; null when the build failed (disclosed via a surface error). */
  fileSequences?: FileSequencesV1 | null;
}

export interface SkillUsageSurfaceData {
  rows: unknown[];
  details: Record<string, unknown>;
  meta: AgentDtoMeta | null;
}

export interface McpToolUsageSurfaceData {
  rollup: unknown;
  meta: AgentDtoMeta | null;
}

export interface AgentKnowledgeEntry {
  agentId: string;
  agentName: string;
  nodes: unknown[];
  details: Record<string, unknown>;
  meta: AgentDtoMeta | null;
}

export interface PlanEntry {
  plan: { id: string; title: string; status: string; updatedAt: string };
  sections: unknown;
  activity: unknown;
}

export interface AnalyticsSnapshotV2 {
  schemaVersion: 2;
  /** WP-S: declared contract — which WPs' v2-optional fields are populated.
   *  Optional at the type level (all v2 additions are), always emitted by the
   *  exporter. */
  capabilities?: string[];
  /** sha256 over canonical JSON EXCLUDING timestamps and snapshotId itself, so an
   *  unchanged corpus produces an identical id. */
  snapshotId: string;
  captureStartedAtIso: string;
  captureCompletedAtIso: string;
  provenance: SnapshotProvenance;
  caveats: SnapshotCaveatV1[];
  surfaces: {
    contextOverhead: SnapshotSurface<RedactedOverheadModelV1>;
    optimizer: SnapshotSurface<OptimizerSurfaceData>;
    skillUsage: SnapshotSurface<SkillUsageSurfaceData>;
    mcpToolUsage: SnapshotSurface<McpToolUsageSurfaceData>;
    agentKnowledge: SnapshotSurface<AgentKnowledgeEntry[]>;
    plans: SnapshotSurface<PlanEntry[]>;
    /** WP7 (G7, v2-OPTIONAL): the nested guidance inventory (capability
     *  'guidance-inventory'). Optional so older v2 snapshots — and the v1
     *  adapter path — remain valid; NOT in SURFACE_KEYS, so diff/iteration
     *  over the six core surfaces is untouched. */
    guidanceInventory?: SnapshotSurface<GuidanceInventoryV1>;
  };
}

/** The legacy v1 shape — structurally v2 minus the v2-optional additions.
 *  Accepted ONLY by the analytics-diff v1→v2 compatibility adapter; the
 *  exporter never emits it again. */
export type AnalyticsSnapshotV1 =
  Omit<AnalyticsSnapshotV2, 'schemaVersion' | 'capabilities'> & { schemaVersion: 1 };

/** WP7: the guidanceInventory surface is v2-OPTIONAL and lives OUTSIDE
 *  `SurfaceKey`/`SURFACE_KEYS` — every existing consumer that iterates the six
 *  required core surfaces (diff generation-drift, caveat keys, provenance map)
 *  keeps compiling and never dereferences a possibly-absent surface. */
export const GUIDANCE_INVENTORY_SURFACE_KEY = 'guidanceInventory' as const;

export type SurfaceKey =
  Exclude<keyof AnalyticsSnapshotV2['surfaces'], typeof GUIDANCE_INVENTORY_SURFACE_KEY>;

export const SURFACE_KEYS: SurfaceKey[] = [
  'contextOverhead', 'optimizer', 'skillUsage', 'mcpToolUsage', 'agentKnowledge', 'plans',
];

export interface SnapshotManifestV2 {
  kind: typeof SNAPSHOT_MANIFEST_KIND;
  schemaVersion: 2;
  /** WP-S: the declared contract, mirrored from the snapshot. */
  capabilities: string[];
  snapshotId: string;
  captureStartedAtIso: string;
  captureCompletedAtIso: string;
  provenance: SnapshotProvenance;
  caveats: SnapshotCaveatV1[];
  surfaceIndex: Array<{
    key: SurfaceKey | typeof GUIDANCE_INVENTORY_SURFACE_KEY;
    status: SurfaceStatus;
    generationId: string;
    rows: number;
    file: string;
    sha256: string;
  }>;
  /** WP6 (G6): per-table truncation metadata, mirrored from the snapshot's
   *  provenance so a manifest-only reader still gets the disclosure. */
  tableTruncation?: Record<string, TableTruncationMetaV1>;
  files: Record<string, string>;   // relative path → sha256
}

// ── canonical hashing ─────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order
 * (array order is meaningful in the DTOs and is already deterministic). Used for
 * both the snapshot id and the per-surface content hashes, so two captures over
 * an unchanged corpus hash identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
  return out;
}

export function sha256Of(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Fields excluded from `snapshotId` — everything that moves with the wall clock
 *  even when the corpus does not. */
const ID_EXCLUDED_TOP_LEVEL = new Set(['snapshotId', 'captureStartedAtIso', 'captureCompletedAtIso']);
const ID_EXCLUDED_PROVENANCE = new Set(['workspaceGitDirty']);

/**
 * `snapshotId` = sha256 over the canonical payload with timestamps and the id
 * itself removed. Two captures of an unchanged corpus MUST produce the same id;
 * that is what makes "did anything actually change?" answerable without a diff.
 */
export function computeSnapshotId(snapshot: AnalyticsSnapshotV2): string {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (ID_EXCLUDED_TOP_LEVEL.has(k)) continue;
    payload[k] = v;
  }
  // `generatedAt` inside a surface is a clock stamp too; strip the known ones.
  const prov = { ...(payload.provenance as SnapshotProvenance) } as Record<string, unknown>;
  for (const k of ID_EXCLUDED_PROVENANCE) delete prov[k];
  payload.provenance = prov;
  return createHash('sha256').update(canonicalJson(stripClockStamps(payload))).digest('hex');
}

const CLOCK_KEYS = new Set([
  'generatedAt', 'generatedAtIso', 'capturedAtIso', 'updatedAt',
  // WP8 — surface provenance moves with the wall clock even when the corpus does
  // not: the anchor IS the clock, the window ends at it, and the comparability
  // key hashes both. Strip all four so an unchanged corpus still hashes to the
  // same snapshotId. (Also strips the WP3 evidence `comparabilityKey` stamp,
  // which is derived from the same anchor.)
  'snapshotAnchor', 'windowStart', 'windowEnd', 'comparabilityKey',
]);

/** Recursively drop clock-stamp fields so an otherwise-identical capture hashes
 *  identically. Structural values (counts, ids, hashes) are untouched. */
export function stripClockStamps(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripClockStamps);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (CLOCK_KEYS.has(k)) continue;
    out[k] = stripClockStamps(v);
  }
  return out;
}

// ── pruning (pure) ────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  /** True iff `<name>/manifest.json` parsed and `kind === 'analytics-snapshot'`. */
  hasValidManifest: boolean;
  /** mtime ms — only used for the `.tmp-*` sweep. */
  mtimeMs?: number;
}

/**
 * Decide which directories to delete. ALL FOUR conditions are required (plan §
 * Fork 3): a direct child of the resolved output root (the caller only ever passes
 * those), a name matching the snapshot pattern, a readable manifest whose `kind`
 * is `analytics-snapshot`, and not the directory just published.
 *
 * This is the exporter's only destructive operation, so it is structurally
 * incapable of selecting anything it did not write: a stray file, a malformed
 * name, a directory without a valid manifest, and a `.tmp-*` entry all fail a
 * condition. Pure — the caller does the deleting.
 */
export function planPrune(entries: DirEntry[], keep: number, justPublished: string): string[] {
  const eligible = entries
    .filter((e) => e.isDirectory)
    .filter((e) => SNAPSHOT_DIR_RE.test(e.name))
    .filter((e) => e.hasValidManifest)
    .filter((e) => e.name !== justPublished)
    .map((e) => e.name)
    .sort();                                  // lexical == chronological by construction

  // `justPublished` occupies one of the `keep` slots even though it is filtered
  // out above — otherwise a keep of N would retain N+1 directories.
  const budget = Math.max(0, keep - 1);
  if (eligible.length <= budget) return [];
  return eligible.slice(0, eligible.length - budget);
}

/** Exporter-created `.tmp-*` scratch directories older than 24h, confined to the
 *  same root. A crashed run leaves one behind; a later successful run cleans it. */
export const TMP_DIR_RE = /^\.tmp-\d+-[0-9a-f]{8}$/;
export const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function planTmpSweep(entries: DirEntry[], nowMs: number): string[] {
  return entries
    .filter((e) => e.isDirectory && TMP_DIR_RE.test(e.name))
    .filter((e) => e.mtimeMs !== undefined && nowMs - e.mtimeMs > TMP_MAX_AGE_MS)
    .map((e) => e.name)
    .sort();
}
