// outcome-tracker.ts — A4 proposal-outcome tracking (closes the flywheel).
//
// SPEC OF RECORD: hardening-epochs-outcomes.md §4–§5.
//
// "Mark applied" records INTENT and never mutates `config_epochs`. This module is the
// pure logic behind the applied-action ledger:
//
//   1. SNAPSHOT (§4.1–§4.2) — freeze the resolved watch predicate into
//      `optimizer_actions.target_json` at apply time. A `subtract-dead-guidance`
//      removes its source section, so the NEXT compiler run can no longer emit its
//      PredictedActions; the matchers must be self-contained to be re-runnable against
//      `behavior_events` WITHOUT recompiling. `target_predicate_hash` keys overlap /
//      supersession (§4.6).
//   2. RECONCILE (§5) — map the WP5 resident pass's DETECTED epoch transitions on the
//      action's `epochRefs[].sectionKey` to one of five states (matched /
//      applied_variant / relocated / not_detected / target_mismatch), producing the
//      `optimizer_action_epoch_links` rows + `after_start_ms`. The after-window starts
//      at the DETECTED epoch close, NEVER the click. A4 READS epochs and WRITES only
//      its own rows — the detected close is authoritative (Bug-10).
//   3. WINDOWS + RECOMPUTE (§4.3–§4.4) — bound the before/after reporting windows
//      (outcome reporting only — NEVER the death denominator, Bug-3) and compare
//      per-100-turns RATES, never raw counts.
//   4. ASSESS (§4.5) — apply the NON-VACUOUS regret thresholds to emit a
//      `suggest-revert` / `rework` / success verdict. NEVER auto-revert.
//
// PURE + IO-free, like every WP5 sibling. DB reads/writes are the caller's job; the
// caller injects the observed epoch transitions and the recomputed window metrics.
// Deterministic: same inputs in → byte-identical ledger rows + verdicts out.

import type { AgentRoleLane } from '../../shared/types';
import type { ContextOptimizerProposal, ContextOptimizerProposalKind } from '../../shared/types';
import type { PredicateKind, Derivability } from './guidance-action-model';
import { sha256Hex } from './resident-inventory';
import { OPTIMIZER_CONFIG } from './optimizer-config';

const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// §4.2 — the snapshotted watch predicate (frozen into `optimizer_actions.target_json`)
// ─────────────────────────────────────────────────────────────────────────────

export type WatchPredicateKind = 'predicted_action' | 'cluster' | 'skill_trigger' | 'toolset_grant';

/** The desired direction of change — drives the §4.5 regret test. Exactly the fields
 *  the assessment reads back; unset flags are simply not tested. */
export interface WatchExpect {
  subtractStaysCold?: boolean;  // SUBTRACT: the after-rate should stay ≈0
  clusterShrinks?: boolean;     // ADD: the after cluster-rate should drop
  skillRises?: boolean;         // TUNE: skill invocations up …
  bypassFalls?: boolean;        //       … and raw-script exec down
}

export interface OptimizerActionTargetV1 {
  schemaVersion: 1;
  actionKind: ContextOptimizerProposalKind;
  lane: AgentRoleLane;
  target: ContextOptimizerProposal['target'];
  proposedEdit: { summary: string; patchHash?: string; beforeHash?: string; afterHash?: string };
  /** The epochs this proposal touches. One action can reference MANY (QW3 removes the
   *  Teams AND Notebooks sections) — reconciliation writes one link per closed epoch. */
  epochRefs: Array<{ sectionKey: string; epochId: string; contentHash: string;
                     sourcePath: string; lineStart?: number; lineEnd?: number }>;
  /** SNAPSHOTTED matchers — re-runnable against `behavior_events` without recompiling. */
  predictedActions: Array<{ id: string; kind: PredicateKind;
                            params: Record<string, string>; derivability: Derivability }>;
  cluster?: { key: string; family?: string; inputShapeHash?: string; searchSignatureHash?: string };
  skill?: { skillName: string; skillPath: string; ownedScriptGlobs: string[] };
  toolset?: { lane: AgentRoleLane; toolset: string; memberToolNames: string[]; grantHash: string };
  watch: {
    predicateKind: WatchPredicateKind;
    lanes: AgentRoleLane[];
    includeSubagents: boolean;    // MUST equal the original verdict's basis (Bug-4)
    minOutcomeTurns: number;      // = MIN_EXPOSURE_TURNS
    expect: WatchExpect;
  };
}

// ── build the snapshot ─────────────────────────────────────────────────────────

export interface BuildActionTargetInput {
  proposal: Pick<ContextOptimizerProposal, 'kind' | 'target'>;
  lane: AgentRoleLane;
  /** The lanes the watch recompute pools over (§3.3 `lanes_json`). */
  watchLanes: AgentRoleLane[];
  /** MUST equal the original verdict's basis (Bug-4): 0 for persona/CLAUDE predicates,
   *  1 for toolset/tool-invocation predicates. */
  includeSubagents: boolean;
  proposedEdit: OptimizerActionTargetV1['proposedEdit'];
  epochRefs: OptimizerActionTargetV1['epochRefs'];
  predictedActions: OptimizerActionTargetV1['predictedActions'];
  cluster?: OptimizerActionTargetV1['cluster'];
  skill?: OptimizerActionTargetV1['skill'];
  toolset?: OptimizerActionTargetV1['toolset'];
}

/** The watch `predicateKind` implied by a proposal kind + the supporting evidence
 *  present (a SUBTRACT of a toolset watches the grant; a SUBTRACT of guidance watches
 *  its snapshotted predicted actions; an ADD watches its cluster; a TUNE watches the
 *  skill trigger). */
function watchKindFor(input: BuildActionTargetInput): WatchPredicateKind {
  const k = input.proposal.kind;
  if (k === 'subtract-unused-toolset') return 'toolset_grant';
  // A grant-mismatch subtract removes RESIDENT GUIDANCE TEXT for a tool the lane no longer
  // holds — NOT a live grant. The grant is absent by construction (that is the deadness),
  // so there is no grant/grantHash to snapshot or watch; the re-runnable matcher is the
  // section's snapshotted predicted actions staying cold, exactly like subtract-dead-
  // guidance. Explicit (not a silent fallthrough) so the choice is auditable.
  if (k === 'subtract-grant-mismatch') return 'predicted_action';
  if (k === 'add-improvisation-support' || k === 'add-missing-guidance') {
    return input.cluster ? 'cluster' : 'predicted_action';
  }
  if (k === 'tune-skill-trigger' || k === 'tune-split-section' ||
      k === 'relocate-to-progressive-disclosure') {
    return input.skill ? 'skill_trigger' : 'predicted_action';
  }
  return 'predicted_action';
}

/** The desired-direction `expect` block for a proposal kind (§4.5 direction of each
 *  lever's regret test). */
function expectFor(kind: ContextOptimizerProposalKind): WatchExpect {
  switch (kind) {
    case 'subtract-unused-toolset':
    case 'subtract-dead-guidance':
    // Grant-mismatch removes resident guidance for an absent tool → the after-rate
    // should stay ≈0, same regret direction as the other subtracts.
    case 'subtract-grant-mismatch':
    // R2 WP-3: an unused skill advertisement / a split-off toolset remainder both remove
    // resident surface that should stay cold after the cut — same subtract regret direction.
    case 'subtract-unused-skill-advertisement':
    case 'tune-split-toolset':
      return { subtractStaysCold: true };
    case 'add-improvisation-support':
    case 'add-missing-guidance':
      return { clusterShrinks: true };
    case 'tune-skill-trigger':
    case 'tune-split-section':
      return { skillRises: true, bypassFalls: true };
    case 'relocate-to-progressive-disclosure':
      return { skillRises: true, bypassFalls: true };
  }
}

/** Deterministic canonical JSON (sorted object keys, recursively) — the hash basis
 *  for `target_predicate_hash`. Kept local so the module owns its determinism. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Build the immutable `target_json` snapshot + its `target_predicate_hash`. The hash
 *  covers ONLY the runnable matchers (`watch`, `predictedActions`, `cluster`, `skill`,
 *  `toolset`) — §4.2 — so two actions that watch the same thing collide for overlap /
 *  supersession (§4.6) regardless of cosmetic proposal differences. */
export function buildOptimizerActionTarget(
  input: BuildActionTargetInput,
): { target: OptimizerActionTargetV1; targetPredicateHash: string } {
  const target: OptimizerActionTargetV1 = {
    schemaVersion: 1,
    actionKind: input.proposal.kind,
    lane: input.lane,
    target: input.proposal.target,
    proposedEdit: input.proposedEdit,
    epochRefs: input.epochRefs,
    predictedActions: input.predictedActions,
    ...(input.cluster ? { cluster: input.cluster } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    ...(input.toolset ? { toolset: input.toolset } : {}),
    watch: {
      predicateKind: watchKindFor(input),
      lanes: input.watchLanes,
      includeSubagents: input.includeSubagents,
      minOutcomeTurns: OPTIMIZER_CONFIG.MIN_EXPOSURE_TURNS,
      expect: expectFor(input.proposal.kind),
    },
  };
  const targetPredicateHash = sha256Hex(canonicalJson({
    watch: target.watch,
    predictedActions: target.predictedActions,
    cluster: target.cluster,
    skill: target.skill,
    toolset: target.toolset,
  }));
  return { target, targetPredicateHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 — reconciliation: observed epoch transitions → one of five states
// ─────────────────────────────────────────────────────────────────────────────

export type ReconcileStatus =
  | 'matched' | 'applied_variant' | 'relocated' | 'not_detected' | 'target_mismatch';

/** A detected epoch transition from the WP5 resident pass (A4 READS these). */
export interface EpochTransition {
  epochId: string;
  sectionKey: string;
  /** `content_hash` of the epoch that CLOSED in this transition. */
  closedContentHash?: string;
  /** `content_hash` of the NEW epoch opened on the same section (an in-place reword);
   *  absent ⇒ the section was removed, not reworded. */
  openedContentHash?: string;
  /** The DETECTED close time (`config_epochs.last_seen_ms`) — the authoritative
   *  `after_start_ms` source. */
  closedAtMs: number;
  /** Set when the section relocated cross-target (QW3, §2.4). */
  movedToSectionKey?: string | null;
  lastSeenReason?: string; // 'edited'|'removed'|'moved_cross_target'|'superseded'|'unknown'
}

export interface EpochLink {
  actionId: string;
  epochId: string;
  relation: 'closed' | 'opened' | 'touched' | 'mismatch';
  confidence: 'exact' | 'variant' | 'inferred' | 'mismatch';
}

export interface ReconcileInput {
  actionId: string;
  appliedAtMs: number;
  target: Pick<OptimizerActionTargetV1, 'epochRefs' | 'proposedEdit'>;
  /** Epoch transitions the WP5 pass observed. Transitions on a section NOT in
   *  `epochRefs` are candidate `target_mismatch` evidence. */
  transitions: EpochTransition[];
  /** The reconcile pass time — becomes `detected_at_ms`. */
  nowMs: number;
  reconcileWindowMs?: number; // default APPLY_RECONCILE_WINDOW_MS
}

export interface ReconcileResult {
  status: ReconcileStatus;
  /** The DETECTED epoch close (max over matched on-target transitions) — the after
   *  window start. NULL for not_detected / target_mismatch (no verdict, §5). */
  afterStartMs: number | null;
  /** The reconcile pass time when a transition was linked; NULL when nothing linked. */
  detectedAtMs: number | null;
  links: EpochLink[];
  reDeriveMatchers: boolean; // applied_variant ⇒ re-derive fresh matchers next compile
  message: string;
}

/** Classify a single on-target transition. */
function classifyTransition(
  t: EpochTransition,
  removedHashes: ReadonlySet<string>,
  afterHash: string | undefined,
): 'matched' | 'applied_variant' | 'relocated' {
  if (t.movedToSectionKey || t.lastSeenReason === 'moved_cross_target') return 'relocated';
  // Applied exactly as proposed: the section was removed at the proposed content, OR it
  // was reworded to precisely the proposed after-content.
  const removedAsProposed =
    !t.openedContentHash && t.closedContentHash != null && removedHashes.has(t.closedContentHash);
  const reworkedToProposed = afterHash != null && t.openedContentHash === afterHash;
  if (removedAsProposed || reworkedToProposed) return 'matched';
  // Section changed, but not to the proposed form → the human applied a DIFFERENT edit.
  return 'applied_variant';
}

/**
 * Reconcile an applied action against the WP5 pass's detected epoch transitions (§5).
 * "Mark applied" never mutates `config_epochs`; this maps intent → observed reality and
 * returns the `optimizer_action_epoch_links` + `after_start_ms` the caller persists.
 */
export function reconcileAction(input: ReconcileInput): ReconcileResult {
  const windowMs = input.reconcileWindowMs ?? OPTIMIZER_CONFIG.APPLY_RECONCILE_WINDOW_MS;
  const sectionKeys = new Set(input.target.epochRefs.map((r) => r.sectionKey));
  const removedHashes = new Set<string>(input.target.epochRefs.map((r) => r.contentHash));
  if (input.target.proposedEdit.beforeHash) removedHashes.add(input.target.proposedEdit.beforeHash);
  const afterHash = input.target.proposedEdit.afterHash;

  // Only transitions within APPLY_RECONCILE_WINDOW_MS of the click are candidates.
  const inWindow = input.transitions.filter(
    (t) => Math.abs(t.closedAtMs - input.appliedAtMs) <= windowMs,
  );
  const onTarget = inWindow.filter((t) => sectionKeys.has(t.sectionKey));
  const offTarget = inWindow.filter((t) => !sectionKeys.has(t.sectionKey));

  // No on-target transition: either the human touched a DIFFERENT section (wrong
  // target) or nothing changed at all. Neither yields a verdict.
  if (onTarget.length === 0) {
    if (offTarget.length > 0) {
      return {
        status: 'target_mismatch',
        afterStartMs: null,
        detectedAtMs: input.nowMs,
        links: offTarget.map((t) => ({
          actionId: input.actionId, epochId: t.epochId, relation: 'mismatch', confidence: 'mismatch',
        })),
        reDeriveMatchers: false,
        message: 'marked applied but a different section changed; wrong target — no verdict',
      };
    }
    return {
      status: 'not_detected',
      afterStartMs: null,
      detectedAtMs: null,
      links: [],
      reDeriveMatchers: false,
      message: 'marked applied but no on-disk change detected — no after-window, no verdict',
    };
  }

  const perTransition = onTarget.map((t) => classifyTransition(t, removedHashes, afterHash));
  const allMatched = perTransition.every((s) => s === 'matched');
  const allRelocated = perTransition.every((s) => s === 'relocated');
  const status: ReconcileStatus =
    allMatched ? 'matched' : allRelocated ? 'relocated' : 'applied_variant';

  const links: EpochLink[] = onTarget.map((t, i) => {
    const s = perTransition[i];
    if (s === 'matched') return { actionId: input.actionId, epochId: t.epochId, relation: 'closed', confidence: 'exact' };
    if (s === 'relocated') return { actionId: input.actionId, epochId: t.epochId, relation: 'closed', confidence: 'variant' };
    return { actionId: input.actionId, epochId: t.epochId, relation: 'touched', confidence: 'variant' };
  });

  // The after-window opens once ALL targeted epochs have closed (the change is fully
  // applied) — the DETECTED close, never the click.
  const afterStartMs = Math.max(...onTarget.map((t) => t.closedAtMs));

  const message =
    status === 'matched'
      ? 'applied as proposed; measuring from the detected epoch close'
      : status === 'relocated'
        ? 'relocated; watching improvisation/bypass — section now non-resident'
        : 'applied edit differs from proposal; measuring the human\'s actual edit';

  return {
    status,
    afterStartMs,
    detectedAtMs: input.nowMs,
    links,
    reDeriveMatchers: status === 'applied_variant',
    message,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 — outcome windows (outcome reporting only — NEVER the death denominator)
// ─────────────────────────────────────────────────────────────────────────────

export interface Window { lo: number; hi: number; }

export interface OutcomeWindowInput {
  appliedAtMs: number;
  /** From reconciliation. NULL (not_detected / mismatch) ⇒ NO after-window, no verdict. */
  afterStartMs: number | null;
  /** `config_epochs.first_seen_ms` of the referenced epoch — clips the `before` lower
   *  bound so a young section's before-window can't reach before it existed. */
  epochFirstSeenMs: number;
  nowMs: number;
  /** §4.6: the next action sharing this `target_predicate_hash` (or a re-add on the
   *  same `section_key`) — ends the after-window early so a later change doesn't
   *  pollute this one's measurement. */
  nextOverlappingActionAtMs?: number | null;
  /** §4.6: a re-added epoch's close on the same `section_key` — also caps the after
   *  window (a re-add must not pollute a SUBTRACT's after-window). */
  epochReaddedAtMs?: number | null;
  outcomeWindowMs?: number; // default OUTCOME_WINDOW_DAYS
}

export interface OutcomeWindows { before: Window; after: Window | null; }

/** Resolve the bounded before/after reporting windows (§4.3). `before` is
 *  recency-matched (bounded by `OUTCOME_WINDOW_DAYS`, floored at the epoch birthday);
 *  `after` opens at the DETECTED close and is capped by now / any overlapping action /
 *  a re-add. Returns `after: null` when there is no detected close. */
export function computeOutcomeWindows(input: OutcomeWindowInput): OutcomeWindows {
  const windowMs = input.outcomeWindowMs ?? OPTIMIZER_CONFIG.OUTCOME_WINDOW_DAYS * DAY_MS;
  const before: Window = {
    lo: Math.max(input.epochFirstSeenMs, input.appliedAtMs - windowMs),
    hi: input.appliedAtMs,
  };
  if (input.afterStartMs == null) return { before, after: null };
  const caps = [input.nowMs];
  if (input.nextOverlappingActionAtMs != null) caps.push(input.nextOverlappingActionAtMs);
  if (input.epochReaddedAtMs != null) caps.push(input.epochReaddedAtMs);
  const after: Window = { lo: input.afterStartMs, hi: Math.min(...caps) };
  return { before, after };
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.4 — recompute rates (never raw counts). Metrics injected by the caller.
// ─────────────────────────────────────────────────────────────────────────────

/** One window's recomputed metric for a single matcher. `exposureTurns` is the §3.3
 *  `end_turn` count over the window with the SAME lane + subagent filter as the
 *  original verdict (Bug-4). */
export interface WindowMetric { occ: number; streams: number; exposureTurns: number; }

export interface WindowRates {
  occ: number;
  streams: number;
  exposureTurns: number;
  /** `100 * occ / exposureTurns`; 0 when the window has no exposure. */
  ratePer100: number;
}

/** Normalize a raw window metric to a per-100-turns rate (§4.4). Compare RATES, never
 *  raw counts — a 5× turn-volume imbalance between before/after otherwise misfires. */
export function toRates(m: WindowMetric): WindowRates {
  const ratePer100 = m.exposureTurns > 0
    ? (OPTIMIZER_CONFIG.RATE_NORMALIZATION_TURNS * m.occ) / m.exposureTurns
    : 0;
  return { occ: m.occ, streams: m.streams, exposureTurns: m.exposureTurns, ratePer100 };
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.5 — assessment: NON-VACUOUS regret thresholds → suggest-revert / rework / success
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeVerdict =
  | 'insufficient-outcome-exposure' // < REGRET_MIN_AFTER_TURNS after → withhold (guards rare-event zero-count)
  | 'confounded'                    // §4.6 overlap left too little after-window
  | 'suggest-revert'                // SUBTRACT / RELOCATE regret — NEVER auto-revert
  | 'rework'                        // ADD didn't shrink / TUNE improved neither path
  | 'success'                       // TUNE improved a path / ADD shrank / SUBTRACT stayed cold
  | 'no-regret';                    // thresholds not breached — silent

export interface AssessInput {
  kind: ContextOptimizerProposalKind;
  /** Primary matcher (SUBTRACT: the removed predicate; ADD: the cluster; TUNE/RELOCATE:
   *  the bypass/improvisation matcher). */
  before: WindowRates;
  after: WindowRates;
  /** Secondary matcher for TUNE/RELOCATE — the skill-invocation rate. */
  beforeSkill?: WindowRates;
  afterSkill?: WindowRates;
  /** §4.6: set when overlap/supersession left `< MIN_EXPOSURE_TURNS` in the after
   *  window → `confounded`, no verdict. */
  confounded?: boolean;
}

export interface OutcomeAssessment {
  verdict: OutcomeVerdict;
  before: WindowRates;
  after: WindowRates;
  /** Human-facing one-liner for the "Applied changes" card. */
  message: string;
}

const isSubtract = (k: ContextOptimizerProposalKind): boolean =>
  k === 'subtract-unused-toolset' || k === 'subtract-dead-guidance' ||
  k === 'subtract-grant-mismatch' || // removes resident guidance → assessed on the subtract regret path
  k === 'subtract-unused-skill-advertisement' || k === 'tune-split-toolset'; // R2 WP-3: schema/header removed → subtract regret path

const isAdd = (k: ContextOptimizerProposalKind): boolean =>
  k === 'add-improvisation-support' || k === 'add-missing-guidance';
const isTune = (k: ContextOptimizerProposalKind): boolean =>
  k === 'tune-skill-trigger' || k === 'tune-split-section';

/** Relative rise/fall of `after` vs `before` as a signed fraction (`+0.5` = up 50%).
 *  When `before ≈ 0`, any positive `after` is treated as an unbounded rise (+∞ → 1). */
function relDelta(beforeRate: number, afterRate: number): number {
  if (beforeRate <= 0) return afterRate > 0 ? 1 : 0;
  return (afterRate - beforeRate) / beforeRate;
}

/**
 * Apply the §4.5 regret thresholds. NON-VACUOUS by construction: a SUBTRACT only
 * regrets when the removed guidance was genuinely `never` (before≈0) AND the after-rate
 * crosses `REGRET_RATE_PER_100` with cross-session support (≥3 occ / ≥2 streams) — a
 * noisy-before section or one agent's tic never triggers a revert. NEVER auto-reverts.
 */
export function assessOutcome(input: AssessInput): OutcomeAssessment {
  const C = OPTIMIZER_CONFIG;
  const base = { before: input.before, after: input.after };

  if (input.confounded) {
    return { ...base, verdict: 'confounded', message: 'confounded by an overlapping later change — no verdict' };
  }
  // Guard the rare-event zero-count case: too little after-exposure → no verdict.
  if (input.after.exposureTurns < C.REGRET_MIN_AFTER_TURNS) {
    return { ...base, verdict: 'insufficient-outcome-exposure', message: 'insufficient after-window exposure — no verdict' };
  }

  if (isSubtract(input.kind)) {
    // before≈0 is the NON-VACUOUS gate: only a section that was `never` can regret.
    const beforeCold = input.before.occ === 0;
    const afterCrosses =
      input.after.ratePer100 >= C.REGRET_RATE_PER_100 &&
      input.after.occ >= C.REGRET_MIN_OCCURRENCES &&
      input.after.streams >= C.REGRET_MIN_STREAMS;
    if (beforeCold && afterCrosses) {
      return { ...base, verdict: 'suggest-revert',
        message: `removed guidance regressed: improvisation returned at ${input.after.ratePer100.toFixed(2)}/100 turns — consider reverting` };
    }
    return { ...base, verdict: beforeCold ? 'success' : 'no-regret',
      message: beforeCold ? 'removed guidance stayed cold — no regression' : 'before was not cold; regret test not applicable' };
  }

  if (isAdd(input.kind)) {
    // Cluster didn't shrink enough: after ≥ before · floor → rework.
    const didNotShrink = input.after.ratePer100 >= input.before.ratePer100 * C.ADD_REWORK_SHRINK_FLOOR;
    return didNotShrink
      ? { ...base, verdict: 'rework', message: 'the targeted improvisation did not shrink after the addition — rework' }
      : { ...base, verdict: 'success', message: 'the targeted improvisation shrank after the addition' };
  }

  if (isTune(input.kind)) {
    // Success ⇔ bypass down ≥50% OR skill up ≥50%.
    const bypassDown = -relDelta(input.before.ratePer100, input.after.ratePer100) >= C.TUNE_SUCCESS_DELTA;
    const skillUp = input.beforeSkill != null && input.afterSkill != null &&
      relDelta(input.beforeSkill.ratePer100, input.afterSkill.ratePer100) >= C.TUNE_SUCCESS_DELTA;
    return bypassDown || skillUp
      ? { ...base, verdict: 'success', message: 'tune worked: bypass fell or skill use rose by ≥50%' }
      : { ...base, verdict: 'rework', message: 'tune moved neither the bypass rate nor skill use by ≥50% — rework' };
  }

  // relocate-to-progressive-disclosure: regret ⇔ bypass rises AND skill use does not
  // rise — the guidance was needed resident.
  const bypassRose = relDelta(input.before.ratePer100, input.after.ratePer100) > 0;
  const skillRose = input.beforeSkill != null && input.afterSkill != null &&
    relDelta(input.beforeSkill.ratePer100, input.afterSkill.ratePer100) > 0;
  if (bypassRose && !skillRose) {
    return { ...base, verdict: 'suggest-revert',
      message: 'relocation regressed: improvisation rose without matching skill use — guidance was needed resident' };
  }
  return { ...base, verdict: 'success', message: 'relocation held: no improvisation regression' };
}
