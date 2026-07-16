// improvisation-clusters.ts — the WP5 "uncovered repeated behaviour" pass (§5.3).
//
// The occurrence classifier (§5.2) asks "did the guidance we HAVE get used?".
// This pass asks the mirror question: "what do agents keep doing that no guidance
// COVERS?" — repeated command families / tool-input shapes / search signatures that
// recur across sessions but map to no PredictedAction. Those are ADD candidates
// (missing guidance / a skill worth minting), not subtracts.
//
// Pipeline (§5.3):
//   1. For each lane, pull `behavior-store.improvisationClusters` grouped by
//      command_family / input_shape_hash / search_signature_hash, kept only when
//      count ≥ REPEAT_MIN AND distinctStreams ≥ REPEAT_MIN_STREAMS (cross-session —
//      one agent's tic doesn't qualify). Floors come from OPTIMIZER_CONFIG.
//   2. SUBTRACT clusters already covered by a PredictedAction — a repeated
//      `command-family` / `search-pattern` that guidance already predicts is NOT an
//      improvisation (the rent question is the classifier's job, not this one).
//      `input_shape_hash` has no PredictedAction predicate, so it is never covered.
//   3. The remainder are uncovered improvisations → ADD candidates. `expectedSaving`
//      = summed post-cluster output tokens, computed by P4.1's repeated-search
//      savings routine (§5.3: route through the optimizer, don't duplicate) — taken
//      here as an INJECTED estimator seam; the default returns 0 (honest: unwired).
//
// Pure over (injected deps). Deterministic: no clocks, no DB handle held.

import type { BehaviorStore, Cluster, Lane } from './behavior-store';
import type { PredictedAction } from './guidance-action-model';
import { OPTIMIZER_CONFIG } from './optimizer-config';

// Persona lanes we scan for improvisations by default. Legacy/unknown streams carry
// no template tail to attach an ADD to, so they are excluded here (they still count
// toward evidence caps in attribution, §6, but are not ADD sources).
const DEFAULT_LANES: Lane[] = ['supervisor', 'worker', 'researcher'];

export interface ImprovisationCandidate {
  lane: Lane;
  dimension: Cluster['dimension'];
  key: string;
  count: number;
  distinctStreams: number;
  /** Summed post-cluster output tokens (P4.1 repeated-search saving). 0 when the
   *  estimator seam is unwired — honest, never a fabricated saving. */
  expectedSaving: number;
  /** WP-B2 — this candidate is the ONE rollup standing in for `rollupCount` hash-only
   *  clusters folded per (lane, dimension). Hash-only dimensions carry a bare-hash
   *  evidence key with no human-readable label, so surfacing each individually would
   *  bury page 1; they collapse into a single rollup instead. Absent ⇒ ordinary
   *  (command_family) candidate. */
  isRollup?: boolean;
  /** WP-B2 — number of hash-only clusters this rollup folds (only when `isRollup`). */
  rollupCount?: number;
  /** WP-B2 — the hash-only dimension this rollup collapses (only when `isRollup`). */
  clusterDimension?: Cluster['dimension'];
  /** WP-B2 — a representative (redacted) evidence key to make the hash cluster
   *  human-actionable. `null` = no exemplar yet (honest seam; B2 never fabricates one —
   *  the drill-in that surfaces a real exemplar is a documented downstream seam). */
  exemplar?: { redactedKey: string } | null;
  /** R2 WP-4B (Step 2) — capped OPAQUE member refs for a rollup: the folded hash-only
   *  cluster keys (already bare hashes — opaque + stable). The drill (`clusterExemplars`)
   *  turns these into redacted structural exemplars. Never raw keys/prompts. Only on a
   *  rollup. */
  memberRefs?: string[];
  /** R2 WP-4B (Step 2) — top-K folded members by occurrence (identifiers + counts only),
   *  so the rollup carries a summary without a drill round-trip. Only on a rollup. */
  topMembers?: Array<{ ref: string; count: number; distinctStreams: number }>;
  /** R2 WP-4B (Step 2) — summed occurrences across the folded members (== `count` on a
   *  rollup; named per the spec `rollup` shape). Only on a rollup. */
  totalOccurrences?: number;
}

/** Hash-only cluster dimensions: the evidence key is a bare hash with NO human-readable
 *  label. WP-B2 folds these per (lane, dimension) into a single rollup candidate so a
 *  lane's many hash titles cannot dominate page 1. `command_family` is NOT hash-only —
 *  it carries a readable family key, so it passes through as an individual candidate. */
const HASH_ONLY_DIMENSIONS: ReadonlySet<Cluster['dimension']> = new Set([
  'input_shape_hash',
  'search_signature_hash',
]);
export function isHashOnlyDimension(dimension: Cluster['dimension']): boolean {
  return HASH_ONLY_DIMENSIONS.has(dimension);
}

/** Coverage predicate: is a repeated behaviour already PREDICTED by guidance? */
export type CoveragePredicate = (dimension: Cluster['dimension'], key: string) => boolean;

/** Injected saving estimator (P4.1 repeated-search savings; §5.3). */
export type SavingEstimator = (cluster: Cluster) => number;

export interface ImprovisationDeps {
  store: Pick<BehaviorStore, 'improvisationClusters'>;
  /** Which clusters are already covered by a PredictedAction (subtracted). Absent ⇒
   *  nothing is treated as covered (every qualifying cluster surfaces). Build from
   *  the compiled actions with `coverageFromActions`. */
  isCovered?: CoveragePredicate;
  /** P4.1 saving estimator seam. Absent ⇒ 0 (documented: savings not yet wired). */
  estimateSaving?: SavingEstimator;
  /** Lanes to scan (default: persona lanes). */
  lanes?: Lane[];
  /** Override the repeat floors (defaults to OPTIMIZER_CONFIG — the source of truth). */
  config?: { REPEAT_MIN: number; REPEAT_MIN_STREAMS: number };
}

/** Build a coverage predicate from the compiled PredictedActions. A cluster is
 *  "covered" iff a PredictedAction already predicts that exact behaviour:
 *   - command_family        ⇔ a `command-family` action with params.commandFamily === key
 *   - search_signature_hash ⇔ a `search-pattern` action with params.queryHash === key
 *   - input_shape_hash      ⇔ NEVER (no PredictedAction predicate for tool-input shape)
 */
export function coverageFromActions(actions: PredictedAction[]): CoveragePredicate {
  const commandFamilies = new Set<string>();
  const searchHashes = new Set<string>();
  for (const a of actions) {
    if (a.kind === 'command-family' && a.params.commandFamily) commandFamilies.add(a.params.commandFamily);
    if (a.kind === 'search-pattern' && a.params.queryHash) searchHashes.add(a.params.queryHash);
  }
  return (dimension, key) => {
    if (dimension === 'command_family') return commandFamilies.has(key);
    if (dimension === 'search_signature_hash') return searchHashes.has(key);
    return false; // input_shape_hash: no predicate ⇒ never covered
  };
}

/** §5.3 — uncovered repeated-behaviour clusters across the scanned lanes. Order is
 *  stable: lane order, then behavior-store's cluster order within a lane. */
export function findImprovisationClusters(deps: ImprovisationDeps): ImprovisationCandidate[] {
  const { REPEAT_MIN, REPEAT_MIN_STREAMS } = deps.config ?? OPTIMIZER_CONFIG;
  const lanes = deps.lanes ?? DEFAULT_LANES;
  const isCovered = deps.isCovered ?? (() => false);
  const estimateSaving = deps.estimateSaving ?? (() => 0);

  const out: ImprovisationCandidate[] = [];
  for (const lane of lanes) {
    const clusters = deps.store.improvisationClusters(lane, { minCount: REPEAT_MIN, minStreams: REPEAT_MIN_STREAMS });
    // WP-B2: fold hash-only clusters per dimension into one rollup; command_family
    // clusters pass through individually. First-seen dimension order (Map preserves
    // insertion) keeps rollup emission deterministic.
    const rollups = new Map<Cluster['dimension'], {
      count: number; streams: number; saving: number; folded: number;
      // R2 WP-4B (Step 2): retain the folded member keys (opaque hashes) + per-member
      // counts so the rollup can carry capped memberRefs + top-K summaries.
      members: Array<{ key: string; count: number; distinctStreams: number }>;
    }>();
    for (const c of clusters) {
      if (isCovered(c.dimension, c.key)) continue; // already predicted by guidance — not an improvisation
      if (isHashOnlyDimension(c.dimension)) {
        const agg = rollups.get(c.dimension) ?? { count: 0, streams: 0, saving: 0, folded: 0, members: [] };
        agg.count += c.count;
        agg.streams = Math.max(agg.streams, c.distinctStreams);
        agg.saving += estimateSaving(c);
        agg.folded += 1;
        agg.members.push({ key: c.key, count: c.count, distinctStreams: c.distinctStreams });
        rollups.set(c.dimension, agg);
        continue;
      }
      out.push({
        lane: c.lane,
        dimension: c.dimension,
        key: c.key,
        count: c.count,
        distinctStreams: c.distinctStreams,
        expectedSaving: estimateSaving(c),
      });
    }
    // One rollup candidate per hash-only dimension seen in this lane. `key` is synthetic —
    // a rollup has no single evidence key. `exemplar: null` is the honest seam: B2 folds
    // but never fabricates a representative command.
    for (const [dimension, agg] of rollups) {
      // R2 WP-4B (Step 2): top-K folded members by occurrence (stable: count desc, then
      // key asc for determinism); memberRefs = capped opaque keys (already bare hashes).
      const REFS_CAP = OPTIMIZER_CONFIG.ROLLUP_MEMBER_REFS_CAP;
      const TOP_K = OPTIMIZER_CONFIG.ROLLUP_TOP_MEMBERS_K;
      const byOccurrence = [...agg.members].sort((a, b) =>
        b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const memberRefs = byOccurrence.slice(0, REFS_CAP).map((m) => m.key);
      const topMembers = byOccurrence.slice(0, TOP_K).map((m) => ({
        ref: m.key, count: m.count, distinctStreams: m.distinctStreams,
      }));
      out.push({
        lane,
        dimension,
        key: `${lane}:${dimension}`,
        count: agg.count,
        distinctStreams: agg.streams,
        expectedSaving: agg.saving,
        isRollup: true,
        rollupCount: agg.folded,
        clusterDimension: dimension,
        exemplar: null,
        memberRefs,
        topMembers,
        totalOccurrences: agg.count,
      });
    }
  }
  return out;
}
