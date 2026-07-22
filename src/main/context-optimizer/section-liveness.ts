// section-liveness.ts — WP5 (G5): join occurrence verdicts onto config-weight
// sections, emitting a SEPARATE `behaviorStatus` axis. The structural
// `weightClass` is untouched — a structurally-broken section that is also
// observed exports BOTH axes; no structural evidence is discarded.
//
// The join is a KEY-EQUALITY join on the shared section identity
// (`${targetType}:${targetKey}:${rawAnchor}`, shared/section-identity.ts):
// every PredictedAction carries `sourceSectionKey` and every config-weight
// section now carries `sectionKey` derived through the SAME helper — no
// reconstruction, no line matching, no heuristics.
//
// STRICT LATTICE (plan WP5 §2 — evaluated in this order):
//   1. zero nodes extracted                          → 'not-analyzed'
//   2. all nodes unmatchable/pure-prose (unobservable) → 'unobservable'
//   3. ≥1 observed AND ≥1 fail-closed-dead            → 'mixed'
//   4. ≥1 observed, no dead                           → 'live'
//   5. every analyzable node dead via the fail-closed never-gates
//      AND captureCoverage 'complete' on every one of them
//      AND zero unmatchable/unobservable nodes
//      AND zero unpaired (verdict-less) nodes         → 'dead'
//   6. any capture-incomplete and no observed         → 'capture-incomplete'
//   7. otherwise                                      → 'insufficient-evidence'
//
// Honesty boundaries this module encodes:
//  • "fail-closed-dead" ⇔ verdict `never` with `evidenceState === 'auditable'`
//    (the WP-1A never-gates passed). A legacy `never` with evidenceState
//    'unavailable' (no resolver wired — nothing was audited) NEVER counts as
//    dead here.
//  • `dead` additionally requires `captureCoverage === 'complete'` on every
//    dead node. Verdicts without the field (legacy non-audience actions) fail
//    that check — deliberate fail-closed wiring: absence of a coverage claim is
//    not a coverage claim.
//  • Cohort disagreement (different provider audiences yield different
//    statuses) → top-level 'mixed', with the per-cohort map ALWAYS exported.
//
// Pure over (actions, verdicts, rollup). No IO, no DB, no clocks.

import type {
  ConfigSectionWeight,
  ConfigWeightRollup,
  SectionBehaviorRecord,
  SectionBehaviorStatus,
} from '../../shared/types';
import { rollupTokensByBehavior } from '../context-overhead/config-weight';
import type { PredictedAction } from './guidance-action-model';
import type { OccurrenceVerdict } from './occurrence-classifier';

// ─────────────────────────────────────────────────────────────────────────────
// Pairing (action ⇄ verdict, per lane)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionVerdictPair {
  action: PredictedAction;
  verdict: OccurrenceVerdict;
}

export interface PairedLane {
  pairs: ActionVerdictPair[];
  /** Actions with no verdict — an analysis gap: they bar `dead` and are counted
   *  in `nodeCounts.unpaired` (disclosed, never silently dropped). */
  unpaired: PredictedAction[];
}

/** Pair one lane's actions with its verdicts by `actionId`. MUST be called
 *  per-lane: the same action id legitimately recurs across lanes with
 *  different verdicts, so cross-lane pooled pairing would mispair. */
export function pairActionVerdicts(
  actions: PredictedAction[],
  verdicts: OccurrenceVerdict[],
): PairedLane {
  const byId = new Map<string, OccurrenceVerdict[]>();
  for (const v of verdicts) {
    const list = byId.get(v.actionId);
    if (list) list.push(v); else byId.set(v.actionId, [v]);
  }
  const pairs: ActionVerdictPair[] = [];
  const unpaired: PredictedAction[] = [];
  for (const action of actions) {
    const list = byId.get(action.id);
    const verdict = list?.shift();
    if (verdict) pairs.push({ action, verdict });
    else unpaired.push(action);
  }
  return { pairs, unpaired };
}

// ─────────────────────────────────────────────────────────────────────────────
// The strict lattice
// ─────────────────────────────────────────────────────────────────────────────

interface NodeTallies {
  total: number;
  observed: number;
  deadFailClosed: number;
  deadWithCompleteCoverage: number;
  unobservable: number;
  captureIncomplete: number;
  unpaired: number;
}

function tally(pairs: ActionVerdictPair[], unpairedCount: number): NodeTallies {
  const t: NodeTallies = {
    total: pairs.length + unpairedCount,
    observed: 0, deadFailClosed: 0, deadWithCompleteCoverage: 0,
    unobservable: 0, captureIncomplete: 0, unpaired: unpairedCount,
  };
  for (const { verdict } of pairs) {
    switch (verdict.status) {
      case 'occurs':
        t.observed++;
        break;
      case 'never':
        // Fail-closed never-gates are the ONLY path to dead: an audited pass
        // (`auditable`) counts; a legacy un-audited `never` does not.
        if (verdict.evidenceState === 'auditable') {
          t.deadFailClosed++;
          if (verdict.captureCoverage === 'complete') t.deadWithCompleteCoverage++;
        }
        break;
      case 'unobservable':
        t.unobservable++;
        break;
      case 'capture-incomplete':
        t.captureIncomplete++;
        break;
      // 'insufficient-exposure' — analyzable, neither observed nor dead.
    }
  }
  return t;
}

/** The strict lattice over one node population (exported for row-level tests). */
export function latticeStatus(t: NodeTallies): SectionBehaviorStatus {
  if (t.total === 0) return 'not-analyzed';
  if (t.unobservable === t.total) return 'unobservable';
  if (t.observed >= 1 && t.deadFailClosed >= 1) return 'mixed';
  if (t.observed >= 1) return 'live';
  const analyzable = t.total - t.unobservable;
  const dead = analyzable >= 1
    && t.unobservable === 0                              // zero unmatchable nodes
    && t.unpaired === 0                                  // no unanalyzed gap
    && t.deadFailClosed === analyzable                   // every analyzable node dead via never-gates
    && t.deadWithCompleteCoverage === t.deadFailClosed;  // captureCoverage 'complete' on every one
  if (dead) return 'dead';
  if (t.captureIncomplete >= 1) return 'capture-incomplete'; // no observed by row-3/4 fallthrough
  return 'insufficient-evidence';
}

/** Convenience for tests: lattice over raw pairs. */
export function statusForNodes(pairs: ActionVerdictPair[], unpairedCount = 0): SectionBehaviorStatus {
  return latticeStatus(tally(pairs, unpairedCount));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohorts (provider audiences)
// ─────────────────────────────────────────────────────────────────────────────

/** Cohort key(s) for one action. Legacy Claude walk-up guidance (no audience
 *  field) is the 'claude' cohort; an explicit `'unknown'` / empty audience is
 *  the disclosed 'unknown' cohort; an audience list yields one cohort per
 *  provider (the node counts toward each provider it addresses). */
export function cohortsOf(action: PredictedAction): string[] {
  const a = action.audienceProviders;
  if (a === undefined) return ['claude'];
  if (a === 'unknown' || a.length === 0) return ['unknown'];
  return [...new Set(a.map((p) => p.toLowerCase()))].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// The join
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join paired verdicts per section identity. Top-level status is the lattice
 * over ALL of a section's nodes — unless the per-cohort statuses disagree, in
 * which case it is forced to 'mixed' (the per-cohort map is always exported
 * either way). Actions with an empty `sourceSectionKey` (unresolved section)
 * belong to no section and are skipped. Deterministic: records sorted by key.
 */
export function joinSectionBehavior(
  lanes: Array<{ actions: PredictedAction[]; verdicts: OccurrenceVerdict[] }>,
): SectionBehaviorRecord[] {
  interface Agg {
    pairs: ActionVerdictPair[];
    unpaired: PredictedAction[];
  }
  const bySection = new Map<string, Agg>();
  const aggFor = (key: string): Agg => {
    let agg = bySection.get(key);
    if (!agg) { agg = { pairs: [], unpaired: [] }; bySection.set(key, agg); }
    return agg;
  };
  for (const lane of lanes) {
    const { pairs, unpaired } = pairActionVerdicts(lane.actions, lane.verdicts);
    for (const p of pairs) {
      if (p.action.sourceSectionKey) aggFor(p.action.sourceSectionKey).pairs.push(p);
    }
    for (const a of unpaired) {
      if (a.sourceSectionKey) aggFor(a.sourceSectionKey).unpaired.push(a);
    }
  }

  const records: SectionBehaviorRecord[] = [];
  for (const [sectionKey, agg] of bySection) {
    const overallTallies = tally(agg.pairs, agg.unpaired.length);
    const overall = latticeStatus(overallTallies);

    // Per-cohort lattice — a node addressed to N providers counts in N cohorts.
    const cohortPairs = new Map<string, ActionVerdictPair[]>();
    const cohortUnpaired = new Map<string, number>();
    for (const p of agg.pairs) {
      for (const c of cohortsOf(p.action)) {
        const list = cohortPairs.get(c);
        if (list) list.push(p); else cohortPairs.set(c, [p]);
      }
    }
    for (const a of agg.unpaired) {
      for (const c of cohortsOf(a)) cohortUnpaired.set(c, (cohortUnpaired.get(c) ?? 0) + 1);
    }
    const cohorts = [...new Set([...cohortPairs.keys(), ...cohortUnpaired.keys()])].sort();
    const behaviorStatusByCohort: Record<string, SectionBehaviorStatus> = {};
    for (const c of cohorts) {
      behaviorStatusByCohort[c] = latticeStatus(tally(cohortPairs.get(c) ?? [], cohortUnpaired.get(c) ?? 0));
    }

    // Cohort disagreement → top-level 'mixed' (per-cohort map keeps the truth).
    const distinct = new Set(Object.values(behaviorStatusByCohort));
    const behaviorStatus = distinct.size > 1 ? 'mixed' : overall;

    records.push({
      sectionKey,
      behaviorStatus,
      behaviorStatusByCohort,
      nodeCounts: {
        total: overallTallies.total,
        observed: overallTallies.observed,
        deadFailClosed: overallTallies.deadFailClosed,
        unobservable: overallTallies.unobservable,
        captureIncomplete: overallTallies.captureIncomplete,
        unpaired: overallTallies.unpaired,
      },
    });
  }
  records.sort((a, b) => (a.sectionKey < b.sectionKey ? -1 : a.sectionKey > b.sectionKey ? 1 : 0));
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config-weight annotation
// ─────────────────────────────────────────────────────────────────────────────

export interface AnnotateResult {
  rollup: ConfigWeightRollup;
  /** Sections that received a joined record. */
  joinedSectionCount: number;
  /** Record keys that matched NO section (e.g. deep-subsection anchors the
   *  config-weight splitter does not emit, or pooled-constant targets) —
   *  disclosed so a consumer never mistakes a partial join for a full one. */
  unmatchedRecordKeys: string[];
}

/**
 * Annotate a config-weight rollup with the behavior axis. Key-equality join
 * ONLY. `weightClass` and every structural field survive verbatim. Sections
 * that carry a `sectionKey` but have no record read 'not-analyzed' (lattice
 * row 1 — zero nodes extracted); sections without a key stay un-annotated
 * (the axis cannot make a claim about them). `tokensByBehavior` is recomputed
 * over the annotated sections.
 */
export function annotateConfigWeight(
  rollup: ConfigWeightRollup,
  records: SectionBehaviorRecord[],
): AnnotateResult {
  const byKey = new Map(records.map((r) => [r.sectionKey, r]));
  const matched = new Set<string>();
  let joinedSectionCount = 0;

  const sections: ConfigSectionWeight[] = rollup.sections.map((s) => {
    if (!s.sectionKey) return s;
    const rec = byKey.get(s.sectionKey);
    if (!rec) {
      return { ...s, behaviorStatus: 'not-analyzed' as SectionBehaviorStatus, behaviorStatusByCohort: {} };
    }
    matched.add(rec.sectionKey);
    joinedSectionCount++;
    return {
      ...s,
      behaviorStatus: rec.behaviorStatus,
      behaviorStatusByCohort: { ...rec.behaviorStatusByCohort },
    };
  });

  return {
    rollup: {
      ...rollup,
      sections,
      tokensByBehavior: rollupTokensByBehavior(sections),
    },
    joinedSectionCount,
    unmatchedRecordKeys: records.map((r) => r.sectionKey).filter((k) => !matched.has(k)),
  };
}
