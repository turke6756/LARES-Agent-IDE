// occurrence-classifier.ts — the WP5 "did the rent get paid?" pass (design §5.2).
//
// Consumes `PredictedAction[]` from guidance-action-model.ts (§5.1) and, for each,
// asks behavior-store whether the predicted behaviour was actually OBSERVED in the
// action's lanes. Emits one `OccurrenceVerdict` per action:
//
//   occurs                → rent paid; keep (never a subtract).
//   never                 → dead-weight candidate — BUT only above the exposure floor.
//   insufficient-exposure → quiet lane / young epoch; watch-item only, lowest confidence.
//   unobservable          → we cannot mechanically observe it; never eligible to be dead.
//
// Honesty boundaries this module encodes:
//  • `derivability==='unmatchable'` (and the `unmatchable` kind) SHORT-CIRCUIT to
//    `unobservable` — never a subtract (§5.2 rule 1).
//  • Zero occurrences is ONLY actionable above the exposure floor
//    (`MIN_EXPOSURE_TURNS` / `MIN_STREAMS` from OPTIMIZER_CONFIG — the const is the
//    source of truth; the design prose's 40/3 is "tune in Phase E"). A quiet lane is
//    never pruned: below the floor we emit `insufficient-exposure`, never `never`.
//  • The exposure denominator is NOT behavior-store's lane scalar. It is
//    epoch-bounded + subagent-varying (hardening-epochs-outcomes §3.3), which the
//    lane scalar cannot express. We take an injected `ExposureResolver` seam; the
//    default resolver wraps `exposureForLane` (lane scalar, epoch-UNBOUNDED) and is
//    explicitly the documented fallback (injected-seam style of WP5 #1/#2).
//  • A3 subagent rule (master plan): tool-invocation / toolset-usage predicates that
//    come from a *tool grant* INCLUDE subagent streams in occurrence AND exposure;
//    persona / CLAUDE.md-derived predicates EXCLUDE them from both. Determined by
//    PredicateKind + sourceKind — see `includesSubagents`.
//  • Low-confidence epoch "birthdays" are surfaced (`epochConfidence`) so WP6 can
//    down-rank one tier; the epoch→confidence lookup is an injected seam (unknown
//    when unwired — WP6 treats unknown as no down-rank).
//
// Pure over (action, injected deps). Deterministic: no clocks, no DB handle held.

import type { AgentRoleLane, BehaviorEvidenceTier } from '../../shared/types';
import type { BehaviorPredicate, BehaviorStore, Lane, MatchCount } from './behavior-store';
import type { PredictedAction } from './guidance-action-model';
import { OPTIMIZER_CONFIG } from './optimizer-config';

// ─────────────────────────────────────────────────────────────────────────────
// Verdict types (design §5.2 lines 281–287, + epoch-confidence for WP6)
// ─────────────────────────────────────────────────────────────────────────────

export type OccurrenceStatus =
  | 'occurs' | 'never' | 'unobservable' | 'insufficient-exposure'
  // WP-1A (Priority 0): a provisional-`never` that FAILED a fail-closed audit gate
  // (matcher not exact/canonical, capture unsupported, unresolved-path rate too high,
  // or no reproducible sample). Never a subtract — routed to notAnalyzable + a
  // `capture-incomplete` diagnostic so the reason stays auditable.
  | 'capture-incomplete';

/** WP-1A fail-closed audit state stamped on every verdict. `auditable` ⇒ the gates
 *  passed and a reproducible evidence object (with ≥1 denominator sample) is attached;
 *  `partial` ⇒ a provisional-`never` downgraded to `capture-incomplete` (evidence
 *  attached so the reason is auditable, but the subtract is withheld); `unavailable`
 *  ⇒ legacy (no resolver wired) / non-`never` verdicts with no audit trail. */
export type EvidenceState = 'auditable' | 'partial' | 'unavailable';

/** WP-1A (Priority 0) — the auditable, SAME-GENERATION non-occurrence evidence behind
 *  a `never` verdict. Built during classification (never a second DTO/route pass):
 *  the matcher that ran + its version, the queried epoch/window, capped denominator
 *  EXPOSURE samples (proof the guidance WAS exposed), the numerator occurrence samples
 *  (empty for a true `never`), per-provider capture coverage, and exclusions. Carries
 *  ONLY identifiers + counts — never raw path text or snippets. */
export interface OccurrenceEvidenceV1 {
  predicate: BehaviorPredicate;
  matcherVersion: string;                       // String(PREDICTED_ACTION_COMPILER_VERSION)
  normalizedMatcher: Record<string, unknown>;   // canonical form of the predicate that ran
  epoch: { id?: string; sinceMs?: number; untilMs?: number; confidence: string };
  denominator: {
    turns: number; streams: number; slugs: number;
    sampledStreams: Array<{ streamId: string; turns: number; lane: string }>;   // CAPPED
  };
  numerator: {
    occurrences: number; streams: number;
    sampledEvents: Array<{ streamId: string; entryUuid: string; blockIndex: number; byteOffset: number }>; // CAPPED
  };
  captureCoverage: {
    providers: Record<string, { streams: number; pathEventsSupported: boolean }>;
    unknownToolEvents: number;
    unresolvedPathEvents: number;
  };
  exclusions: { subagents: boolean; reasons: string[] };
}

/** EVIDENCE tier owned by the classifier. `attribution.ts` combines this with the
 *  attribution tier via `min(evidence, attribution)` (§6) — we never claim the final
 *  tier here. `exact` derivability → `observed`; `heuristic` → `inferred`; a
 *  watch-item (`insufficient-exposure`) is forced to the floor (`heuristic`). */
export type ConfidenceTier = 'observed' | 'inferred' | 'heuristic';

/** Lift the classifier's local 3-tier evidence into the shared 4-tier
 *  `BehaviorEvidenceTier` ladder (design §7.1). The classifier NEVER mints
 *  `observed-safe` — that is attribution.ts's job (lane-level + clean dead signal).
 *  Here the top tier maps to plain `observed`; attribution promotes a `never`+exact
 *  verdict to `observed-safe` only when the edit target is lane-level. Additive helper
 *  so `attribution.ts` reuses one canonical mapping instead of re-deriving it. */
export function liftConfidenceTier(tier: ConfidenceTier): BehaviorEvidenceTier {
  return tier; // 'observed' | 'inferred' | 'heuristic' are all valid BehaviorEvidenceTier members
}

/** Why an action was ruled `unobservable` (kept for the "Not analyzable" UI, §9). */
export type UnobservableReason =
  | 'unmatchable'          // pure prose / derivability==='unmatchable'
  | 'coarse-server-grant'  // toolset-usage with only a coarse {server}, no {toolset}
  | 'sequence-deferred'    // workflow-sequence: ordered events, not a countMatching predicate
  | 'branch-deferred'      // decision-branch: no behavior-store predicate
  | 'unresolved-path';     // WP-1B: file reference we could not resolve to a canonical path (never suffix-matched)

export interface OccurrenceVerdict {
  actionId: string;
  status: OccurrenceStatus;
  // Occurrence side (from behavior-store countMatching; zeroed when unobservable).
  occurrences: number;
  distinctStreams: number;
  distinctSlugs: number;
  lastTsMs?: number;
  // Exposure side (the hardened denominator via ExposureResolver).
  exposureTurns: number;
  exposureStreams: number;
  exposureSlugs: number;
  confidence: ConfidenceTier;
  /** Surfaced for WP6 down-rank of low-confidence epoch birthdays. `unknown` when
   *  the epoch→confidence seam is unwired ⇒ WP6 applies no down-rank. */
  epochConfidence: 'high' | 'low' | 'unknown';
  /** A3 decision recorded for transparency: were subagent streams counted? */
  includeSubagents: boolean;
  /** The behavior-store predicate we queried (`null` for unobservable/deferred). */
  predicate: BehaviorPredicate | null;
  unobservableReason?: UnobservableReason;
  // WP-1A (Priority 0) fail-closed evidence.
  /** Present for gate-evaluated verdicts (`never` with a wired resolver, or a
   *  downgraded `capture-incomplete`). Omitted on legacy/unobservable/non-never. */
  evidence?: OccurrenceEvidenceV1;
  /** `'unavailable'` on every non-`never`/legacy path; `'auditable'` when the
   *  fail-closed gates passed; `'partial'` on a `capture-incomplete` downgrade. */
  evidenceState: EvidenceState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injected seams (kept as dependency interfaces so the classifier stays pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Occurrence side. `includeSubagents` is the A3 decision; the production impl is
 *  expected to honour it. The default wraps `store.countMatching`, which pools ALL
 *  lane streams (subagents included) and cannot yet exclude them — a documented
 *  fallback limit, not a claim of subagent isolation. */
export interface OccurrenceCounter {
  count(pred: BehaviorPredicate, opts: { lanes: Lane[]; includeSubagents: boolean; sinceMs?: number }): MatchCount;
}

export interface ExposureCount {
  exposureTurns: number;
  distinctStreams: number;
  distinctSlugs: number;
}

/** Exposure denominator. Production resolves epoch bounds (`sourceEpochId` →
 *  config_epochs first/last_seen) AND subagent-varying `end_turn` counts — neither
 *  expressible via behavior-store's lane scalar (hardening-epochs-outcomes §3.3).
 *  This is the SEAM; the default is the epoch-unbounded fallback. */
export interface ExposureResolver {
  resolve(pa: PredictedAction, opts: { includeSubagents: boolean }): ExposureCount;
}

/** WP-1A — inputs handed to the `EvidenceResolver` when a provisional-`never` is
 *  about to be finalized. Carries the already-resolved match/exposure counts so the
 *  resolver does not recount, plus the epoch shell + lanes it must window over. */
export interface EvidenceInputs {
  predicate: BehaviorPredicate;
  lanes: Lane[];
  includeSubagents: boolean;
  sinceMs?: number;
  epoch: { id?: string; sinceMs?: number; untilMs?: number; confidence: string };
  match: MatchCount;
  exposure: ExposureCount;
}

/** WP-1A injected seam (beside ExposureResolver) — builds the SAME-GENERATION audit
 *  object for a provisional-`never`. Pure over the injected DB it closed over; the
 *  classifier stays DB-free. The production impl lives in optimizer-pipeline.ts
 *  (`makeProductionEvidenceResolver`). When ABSENT, the classifier keeps the legacy
 *  `never` but stamps `evidenceState:'unavailable'` (we could not audit). */
export interface EvidenceResolver {
  resolve(pa: PredictedAction, inp: EvidenceInputs): OccurrenceEvidenceV1;
}

export interface ClassifyDeps {
  occurrence: OccurrenceCounter;
  exposure: ExposureResolver;
  /** WP-1A fail-closed audit seam. Absent ⇒ legacy `never` + `evidenceState:'unavailable'`
   *  (no audit trail available); present ⇒ full fail-closed gating on every `never`. */
  evidence?: EvidenceResolver;
  /** Epoch → birth confidence (`sourceEpochId` lookup). Absent / null ⇒ `unknown`
   *  (honest: the epoch has not been confidence-graded). Documented seam. */
  epochConfidenceFor?: (epochId: string) => 'high' | 'low' | null;
  /** Epoch/window lower bound forwarded to the occurrence counter (optional). */
  sinceMs?: number;
  /** Override the exposure floors (defaults to OPTIMIZER_CONFIG — the source of truth). */
  config?: { MIN_EXPOSURE_TURNS: number; MIN_STREAMS: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default seams (wrap a BehaviorStore) — clearly marked as the fallback
// ─────────────────────────────────────────────────────────────────────────────

/** Default occurrence counter. SEAM LIMIT: `store.countMatching` pools every stream
 *  in the lane including subagent streams and cannot filter by subagent, so
 *  `includeSubagents:false` is an approximation here. The true subagent-excluding
 *  query is production wiring (§3.3). */
export function defaultOccurrenceCounter(store: Pick<BehaviorStore, 'countMatching'>): OccurrenceCounter {
  return {
    count: (pred, { lanes, sinceMs }) => store.countMatching(pred, lanes, sinceMs),
  };
}

/** Default exposure resolver. FALLBACK: lane scalar, epoch-UNBOUNDED and
 *  subagent-invariant — sums `exposureForLane` over the action's lanes. The hardened
 *  resolver (epoch-bounded, subagent-varying) is production wiring (§3.3). */
export function defaultExposureResolver(store: Pick<BehaviorStore, 'exposureForLane'>): ExposureResolver {
  return {
    resolve: (pa) => {
      let exposureTurns = 0;
      let distinctStreams = 0;
      let distinctSlugs = 0;
      for (const lane of mapLanes(pa.lanes)) {
        const e = store.exposureForLane(lane);
        exposureTurns += e.turnCount;
        distinctStreams += e.distinctStreams;
        distinctSlugs += e.distinctSlugs;
      }
      return { exposureTurns, distinctStreams, distinctSlugs };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicate mapping (PredictedAction.params → BehaviorPredicate)
// ─────────────────────────────────────────────────────────────────────────────

/** Map a PredictedAction to the behavior-store predicate it should be counted by,
 *  or `null` when there is no such predicate (coarse server grant, deferred
 *  sequence/branch, unmatchable). Param-name mapping per worker #3's note. */
function toPredicate(pa: PredictedAction): BehaviorPredicate | null {
  switch (pa.kind) {
    case 'tool-invocation':
      return pa.params.toolName ? { kind: 'tool-invocation', toolName: pa.params.toolName } : null;
    case 'toolset-usage':
      // The coarse `{server}`-only variant (no enumerated `{toolset}`) has no
      // behavior-store predicate → unobservable.
      return pa.params.toolset ? { kind: 'toolset-usage', toolset: pa.params.toolset } : null;
    case 'command-family':
      return pa.params.commandFamily ? { kind: 'command-family', family: pa.params.commandFamily } : null;
    case 'path-touch': {
      // WP-1B: a resolved file identity uses the richer `file-access` predicate
      // (canonical-abs / workspace-rel + access-mode constrained, NO basename match).
      const fa = pa.fileAccess;
      if (fa) {
        if (fa.canonicalAbs || fa.workspaceRelative != null) {
          const path: { raw: string; canonicalAbs?: string; workspaceRelative?: string; base: typeof fa.base } = { raw: fa.raw, base: fa.base };
          if (fa.canonicalAbs) path.canonicalAbs = fa.canonicalAbs;
          if (fa.workspaceRelative != null) path.workspaceRelative = fa.workspaceRelative;
          return { kind: 'file-access', path, modes: fa.modes, timing: fa.timing };
        }
        return null; // present but unresolved → unobservable (never a subtract signal)
      }
      // Legacy path-touch action (no resolved identity) → glob predicate as before.
      return pa.params.pathGlob ? { kind: 'path-touch', pathGlob: pa.params.pathGlob } : null;
    }
    case 'search-pattern':
      return pa.params.queryHash ? { kind: 'search-pattern', signatureHash: pa.params.queryHash } : null;
    case 'skill-invocation':
      return pa.params.skillName ? { kind: 'skill-invocation', skillName: pa.params.skillName } : null;
    // workflow-sequence / decision-branch / unmatchable carry NO behavior-store
    // predicate (sequence per §5.2 is ordered behavior_events in one stream/turn
    // window — a special/deferred pass, never hacked into countMatching).
    default:
      return null;
  }
}

/** The `unobservableReason` for an action with no queryable predicate. */
function unobservableReasonFor(pa: PredictedAction): UnobservableReason {
  if (pa.derivability === 'unmatchable' || pa.kind === 'unmatchable') return 'unmatchable';
  if (pa.kind === 'toolset-usage') return 'coarse-server-grant';
  if (pa.kind === 'workflow-sequence') return 'sequence-deferred';
  if (pa.kind === 'decision-branch') return 'branch-deferred';
  // WP-1B: a path reference that carries fileAccess but resolved to no identity.
  if (pa.kind === 'path-touch' && pa.fileAccess && !pa.fileAccess.canonicalAbs && pa.fileAccess.workspaceRelative == null) {
    return 'unresolved-path';
  }
  return 'unmatchable';
}

/** A3 subagent rule: a *tool grant* (sourceKind==='tool') producing a
 *  tool-invocation / toolset-usage predicate INCLUDES subagent streams; every
 *  persona / CLAUDE.md-derived predicate EXCLUDES them. */
function includesSubagents(pa: PredictedAction): boolean {
  const toolPredicate = pa.kind === 'tool-invocation' || pa.kind === 'toolset-usage';
  const toolGrant = pa.sourceKind === 'tool';
  return toolPredicate && toolGrant;
}

/** AgentRoleLane[] → behavior-store Lane[] (AgentRoleLane ⊆ Lane), de-duplicated. */
function mapLanes(lanes: AgentRoleLane[]): Lane[] {
  return [...new Set<Lane>(lanes as Lane[])];
}

/** Evidence tier for a resolved verdict (§6 evidence component). Attribution refines
 *  it later via `min(evidence, attribution)`. */
function evidenceTier(pa: PredictedAction, status: OccurrenceStatus): ConfidenceTier {
  // watch-item / withheld-audit statuses are forced to the floor.
  if (status === 'insufficient-exposure' || status === 'capture-incomplete') return 'heuristic';
  return pa.derivability === 'exact' ? 'observed' : 'inferred';
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify
// ─────────────────────────────────────────────────────────────────────────────

function unobservableVerdict(pa: PredictedAction, includeSubs: boolean): OccurrenceVerdict {
  return {
    actionId: pa.id,
    status: 'unobservable',
    occurrences: 0,
    distinctStreams: 0,
    distinctSlugs: 0,
    exposureTurns: 0,
    exposureStreams: 0,
    exposureSlugs: 0,
    confidence: 'heuristic',
    epochConfidence: 'unknown',
    includeSubagents: includeSubs,
    predicate: null,
    unobservableReason: unobservableReasonFor(pa),
    evidenceState: 'unavailable',
  };
}

/** WP-1A — deterministic canonical form of the predicate that ran, for the evidence
 *  object's `normalizedMatcher` (reproducibility + display). Identifiers only. */
export function normalizeMatcher(pred: BehaviorPredicate): Record<string, unknown> {
  switch (pred.kind) {
    case 'tool-invocation':  return { kind: pred.kind, toolName: pred.toolName };
    case 'toolset-usage':    return { kind: pred.kind, toolset: pred.toolset };
    case 'command-family':   return { kind: pred.kind, family: pred.family };
    case 'skill-invocation': return { kind: pred.kind, skillName: pred.skillName };
    case 'search-pattern':   return { kind: pred.kind, signatureHash: pred.signatureHash };
    case 'path-touch':       return { kind: pred.kind, pathGlob: pred.pathGlob };
    case 'file-access':      return {
      kind: pred.kind,
      canonicalAbs: pred.path.canonicalAbs ?? null,
      workspaceRelative: pred.path.workspaceRelative ?? null,
      base: pred.path.base,
      modes: [...pred.modes].sort(),
      timing: pred.timing ?? null,
    };
  }
}

/** WP-1A fail-closed gates for a provisional-`never`. ALL must hold (with ≥1
 *  denominator sample) for the verdict to stay `never` / `evidenceState:'auditable'`;
 *  otherwise it downgrades to `capture-incomplete` / `'partial'`. Returns the gate
 *  outcome plus the two auditable reason fields the engine surfaces in a diagnostic. */
function neverGates(
  predicate: BehaviorPredicate,
  pa: PredictedAction,
  ev: OccurrenceEvidenceV1,
): { pass: boolean; matcherCanonical: boolean; unresolvedPathRate: number } {
  const isFileAccess = predicate.kind === 'file-access';
  // matcherExactCanonical: exact-equality predicates are canonical by construction;
  // file-access is canonical only with a resolved identity; a `path-touch` glob is NOT.
  const CANONICAL_KINDS = new Set(['tool-invocation', 'toolset-usage', 'command-family', 'skill-invocation', 'search-pattern']);
  let matcherCanonical: boolean;
  if (CANONICAL_KINDS.has(predicate.kind)) matcherCanonical = true;
  else if (isFileAccess) matcherCanonical = !!(predicate.path.canonicalAbs || predicate.path.workspaceRelative != null);
  else matcherCanonical = false; // path-touch glob → the Memory false-positive matcher
  const matcherExactCanonical = matcherCanonical && pa.derivability === 'exact';

  // captureSupported: capture coverage exists; for file-access EVERY provider bucket
  // must emit resolvable paths (else "never touched" is unprovable capture-side).
  const providerEntries = Object.values(ev.captureCoverage.providers);
  const providersNonEmpty = providerEntries.length > 0;
  const captureSupported = providersNonEmpty
    && (!isFileAccess || providerEntries.every((p) => p.pathEventsSupported === true));

  // unresolvedRateOk: only meaningful for file-access; non-path predicates auto-pass.
  const denomTurns = Math.max(1, ev.denominator.turns);
  const unresolvedPathRate = ev.captureCoverage.unresolvedPathEvents / denomTurns;
  const unresolvedRateOk = !isFileAccess || unresolvedPathRate < OPTIMIZER_CONFIG.NEVER_MAX_UNRESOLVED_PATH_RATE;

  // reproducible: the resolver actually ran (providers present + a non-empty
  // normalizedMatcher). The default/absent path never reaches here.
  const reproducible = providersNonEmpty
    && ev.normalizedMatcher != null && Object.keys(ev.normalizedMatcher).length > 0;

  // auditable `never` also requires at least one denominator (exposure) sample.
  const hasDenomSample = ev.denominator.sampledStreams.length >= 1;

  const pass = matcherExactCanonical && captureSupported && unresolvedRateOk && reproducible && hasDenomSample;
  return { pass, matcherCanonical, unresolvedPathRate };
}

/** Classify a single PredictedAction (design §5.2 decision ladder). */
export function classifyAction(pa: PredictedAction, deps: ClassifyDeps): OccurrenceVerdict {
  const includeSubs = includesSubagents(pa);

  // Rule 1 — unmatchable short-circuits to unobservable BEFORE any store query.
  if (pa.derivability === 'unmatchable' || pa.kind === 'unmatchable') {
    return unobservableVerdict(pa, includeSubs);
  }

  // No queryable predicate (coarse server grant / deferred sequence / branch) →
  // unobservable (never a subtract), also before any store query.
  const predicate = toPredicate(pa);
  if (!predicate) {
    return unobservableVerdict(pa, includeSubs);
  }

  const { MIN_EXPOSURE_TURNS, MIN_STREAMS } = deps.config ?? OPTIMIZER_CONFIG;
  const lanes = mapLanes(pa.lanes);

  const match = deps.occurrence.count(predicate, { lanes, includeSubagents: includeSubs, sinceMs: deps.sinceMs });
  const exposure = deps.exposure.resolve(pa, { includeSubagents: includeSubs });

  // Rule 2/3/4 — occurs; else `never` ONLY above the exposure floor; else watch-item.
  let status: OccurrenceStatus;
  if (match.occurrences > 0) {
    status = 'occurs';
  } else if (exposure.exposureTurns >= MIN_EXPOSURE_TURNS && exposure.distinctStreams >= MIN_STREAMS) {
    status = 'never';
  } else {
    status = 'insufficient-exposure';
  }

  const epochConfidence = pa.sourceEpochId
    ? (deps.epochConfidenceFor?.(pa.sourceEpochId) ?? 'unknown')
    : 'unknown';

  // WP-1A — fail-closed, auditable `never`. A provisional-`never` is only finalized
  // as `never` (evidenceState='auditable') when a wired EvidenceResolver produces a
  // reproducible audit object AND every gate holds; a failed gate downgrades it to
  // `capture-incomplete` (evidenceState='partial', evidence still attached so the
  // reason is auditable). When NO resolver is wired we keep the legacy `never` but
  // honestly stamp `evidenceState='unavailable'` (we could not audit). Non-`never`
  // verdicts carry `evidenceState='unavailable'` and no evidence object.
  let evidence: OccurrenceEvidenceV1 | undefined;
  let evidenceState: EvidenceState = 'unavailable';
  if (status === 'never' && deps.evidence) {
    const epoch: OccurrenceEvidenceV1['epoch'] = { confidence: epochConfidence };
    if (pa.sourceEpochId) epoch.id = pa.sourceEpochId;
    if (deps.sinceMs != null) epoch.sinceMs = deps.sinceMs;
    const ev = deps.evidence.resolve(pa, {
      predicate, lanes, includeSubagents: includeSubs, sinceMs: deps.sinceMs, epoch, match, exposure,
    });
    evidence = ev;
    const gates = neverGates(predicate, pa, ev);
    if (gates.pass) {
      evidenceState = 'auditable';
    } else {
      status = 'capture-incomplete';
      evidenceState = 'partial';
    }
  }

  // WP-1B: an AMBIGUOUS-mode file-access predicate (empty modes — the instruction's
  // verb did not disambiguate read vs write) may match any touch, but is capped at
  // `inferred` so attribution can never promote it to an observed-safe subtract.
  let confidence = evidenceTier(pa, status);
  if (predicate.kind === 'file-access' && predicate.modes.length === 0 && confidence === 'observed') {
    confidence = 'inferred';
  }

  const verdict: OccurrenceVerdict = {
    actionId: pa.id,
    status,
    occurrences: match.occurrences,
    distinctStreams: match.distinctStreams,
    distinctSlugs: match.distinctSlugs,
    exposureTurns: exposure.exposureTurns,
    exposureStreams: exposure.distinctStreams,
    exposureSlugs: exposure.distinctSlugs,
    confidence,
    epochConfidence,
    includeSubagents: includeSubs,
    predicate,
    evidenceState,
  };
  if (evidence) verdict.evidence = evidence;
  if (match.lastTsMs != null) verdict.lastTsMs = match.lastTsMs;
  return verdict;
}

/** Classify a batch of PredictedActions. Order preserved (stable). */
export function classifyOccurrences(actions: PredictedAction[], deps: ClassifyDeps): OccurrenceVerdict[] {
  return actions.map((pa) => classifyAction(pa, deps));
}
