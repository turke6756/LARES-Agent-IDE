// compiler-parity-gate.ts — WP5 compiler-parity gate / `derivationVerified` (D1).
//
// Spec of record: `plans/hardening-classifier-agent-surface.md` §4. This module is
// the MECHANISM behind the G2 human sign-off gate — it never flips the flag itself.
//
// What the gate protects: the occurrence-DERIVED subtract proposals
// (`subtract-dead-guidance`, `subtract-unused-toolset`, `relocate-to-progressive-
// disclosure`, `tune-split-section` — the ones whose evidence flows from the §5.2
// classifier's `never` verdict). Before the app is allowed to present those as
// "verified", a human (Edward, G2) must confirm that the §5.1 compiler + §5.2
// classifier reproduce the frozen empirical reference (`plans/empirical-log-signal-
// report.md`): the orchestration histogram (supervisor 239 / everyone else 0) and
// the supervisor persona occurs/never split (19 / 18). That reference is pinned in
// the fixture `plans/optimizer-parity/parity-expectations.json`.
//
// HARD boundaries this module encodes:
//  • READS/COMPUTES ONLY. The `optimizer_derivation_verifications` row is written by
//    WP6 IPC on Edward's sign-off; this module never writes it, never flips
//    `derivationVerified` to true on its own. `derivationVerified()` is a pure
//    predicate over an EXISTING signed row + the current fingerprints/flagship.
//  • PER-LANE, and honest about the reference gap: the empirical report hand-derived
//    ONLY the supervisor persona, so worker/researcher have no reference table to
//    check against → their state is the distinct `'unverified-no-reference'`, NEVER
//    silently promoted to `'verified'` off a supervisor sign-off (§4.5).
//  • FINGERPRINTS ARE NECESSARY, NOT JUST THE COUNTS (§4.4). A coincidental flagship
//    match with a changed input (parser/compiler version bump, config/corpus/toolset/
//    empirical-report change) is STILL `stale`. Fingerprints gate first; the flagship
//    recompute is an ADDITIONAL guard.
//  • ROUTINE APPEND-ONLY GROWTH IS NOT DRIFT (§4.4). The corpus fingerprint binds to
//    structural facts (lane set, root set, inclusion filters, parser version), NOT
//    raw row counts — new log rows under the same scope keep the gate `verified` and
//    are disclosed via `verifiedAsOf` + `postVerificationEvents`, not flipped `stale`.
//
// Pure over (inputs, injected deps). Deterministic: stable ordering, no clocks
// (every timestamp/ISO string is injected), no DB handle, no filesystem.

import type { AgentRoleLane } from '../../shared/types';
import type { Derivability, PredicateKind, PredictedAction } from './guidance-action-model';
import type { OccurrenceStatus } from './occurrence-classifier';
import {
  OPTIMIZER_CONFIG,
  PREDICTED_ACTION_COMPILER_VERSION,
  RESIDENT_PARSER_VERSION,
} from './optimizer-config';
import { sha256Hex } from './resident-inventory';

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprints (§4.4) — the six necessary inputs the sign-off binds to.
// DB-column names are used verbatim as `staleReasons` tokens (see §4.4 / test §7.21).
// ─────────────────────────────────────────────────────────────────────────────

export interface ParityFingerprints {
  /** `RESIDENT_PARSER_VERSION` at sign-off (sectioning/hashing layer). */
  parserVersion: number;
  /** `PREDICTED_ACTION_COMPILER_VERSION` at sign-off (compiler/classifier logic). */
  compilerVersion: number;
  /** Structural corpus identity (lane set, root set, inclusion filters, parser
   *  version) — NOT raw row counts, so routine growth does not change it (§4.4). */
  corpusFingerprint: string;
  /** The lane's resolved persona/config content the compiler ran over. */
  configFingerprint: string;
  /** The live toolset inventory (registered toolset keys + member tools). */
  toolsetInventoryFingerprint: string;
  /** The frozen empirical report the reference numbers were sourced from. */
  empiricalReportFingerprint: string;
}

/** DB-column names, in the order surfaced in `staleReasons`. */
const FINGERPRINT_FIELDS = [
  'parser_version',
  'compiler_version',
  'corpus_fingerprint',
  'config_fingerprint',
  'toolset_inventory_fingerprint',
  'empirical_report_fingerprint',
] as const;

export type FingerprintField = (typeof FINGERPRINT_FIELDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Flagship reference (the counts a human eyeballs at sign-off).
// ─────────────────────────────────────────────────────────────────────────────

/** occurs/never/insufficient/unobservable over the lane's TOOL-predicate universe
 *  (§4.1). The empirical reference pins occurs=19, never=18 for the supervisor. */
export interface PersonaSplit {
  occurs: number;
  never: number;
  insufficient: number;
  unobservable: number;
}

/** Orchestration-toolset invocations by lane (§4.1). Reference: supervisor 239, all
 *  others 0. A full per-lane record so a nonzero worker/researcher count is drift. */
export type OrchestrationHistogram = Record<AgentRoleLane, number>;

const ALL_LANES: AgentRoleLane[] = ['legacy', 'supervisor', 'worker', 'researcher'];

// ─────────────────────────────────────────────────────────────────────────────
// Reference expectations (the fixture `parity-expectations.json`, §4.1)
// ─────────────────────────────────────────────────────────────────────────────

/** The frozen reference numbers, from `plans/empirical-log-signal-report.md`. Only
 *  the supervisor lane has a hand-derived reference; the precheck compares the
 *  computed flagship to `histogram` + `split.occurs`/`split.never` exactly
 *  (`PARITY_DRIFT_TOLERANCE`). */
export interface ParityExpectations {
  schemaVersion: 1;
  lane: AgentRoleLane;
  source: string;
  orchestrationHistogram: OrchestrationHistogram;
  /** Only occurs/never are pinned by the report; insufficient/unobservable are not
   *  quantified there and are NOT compared. */
  personaSplit: { occurs: number; never: number };
  driftTolerance: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact (§4.1) — deterministic, reproducible, byte-identical per fingerprint set.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompilerParityRow {
  sourcePath: string;
  line: number;
  sectionKey: string;
  predictedActionId: string;
  kind: PredicateKind;
  params: Record<string, string>;
  derivability: Derivability;
  classifierStatus: OccurrenceStatus;
  occurrences: number;
  exposureTurns: number;
  empiricalFindingId?: string;
}

/** Precheck outcome: whether the computed flagship reproduces the frozen reference. */
export type ParityPrecheckStatus = 'match' | 'mismatch' | 'no-reference';

export interface ParityFlagshipDiff {
  histogram: Array<{ lane: AgentRoleLane; expected: number; computed: number }>;
  split: Array<{ key: 'occurs' | 'never'; expected: number; computed: number }>;
}

export interface CompilerParityArtifact {
  schemaVersion: 1;
  generatedAtIso: string;
  lane: AgentRoleLane;
  parserVersion: number;
  predictedActionCompilerVersion: number;
  corpusFingerprint: string;
  configFingerprint: string;
  toolsetInventoryFingerprint: string;
  empiricalReportFingerprint: string;
  orchestrationHistogram: OrchestrationHistogram;
  personaSplit: PersonaSplit;
  rows: CompilerParityRow[];
  /** Precheck vs the reference fixture. `mismatch` BLOCKS sign-off (§4.1). */
  status: ParityPrecheckStatus;
  /** Enumerated deltas backing a `mismatch` (empty on `match`/`no-reference`). */
  diff: ParityFlagshipDiff;
  /** sha256 of the canonical artifact JSON with `artifactSha256` itself blanked —
   *  byte-identical given the same fingerprints (§4.1). */
  artifactSha256: string;
}

/** Kinds that count toward the persona occurs/never split — the tool-grant universe
 *  the empirical report's "37 discrete tools" measures. Non-tool predicates
 *  (path-touch, command-family, …) are compiler rows but not part of the split. */
const TOOL_SPLIT_KINDS = new Set<PredicateKind>([
  'tool-invocation',
  'toolset-usage',
  'skill-invocation',
]);

function emptyHistogram(): OrchestrationHistogram {
  return { legacy: 0, supervisor: 0, worker: 0, researcher: 0 };
}

/** Count the tool-predicate rows into the four occurs/never/… buckets. */
export function personaSplitFromRows(rows: CompilerParityRow[]): PersonaSplit {
  const split: PersonaSplit = { occurs: 0, never: 0, insufficient: 0, unobservable: 0 };
  for (const r of rows) {
    if (!TOOL_SPLIT_KINDS.has(r.kind)) continue;
    if (r.classifierStatus === 'occurs') split.occurs++;
    else if (r.classifierStatus === 'never') split.never++;
    else if (r.classifierStatus === 'insufficient-exposure') split.insufficient++;
    else if (r.classifierStatus === 'unobservable') split.unobservable++;
  }
  return split;
}

/** Stable JSON for hashing: sort object keys recursively so key order never perturbs
 *  the fingerprint. Arrays keep their (already deterministic) order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildParityArtifact — the pure core (§4.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildParityArtifactInput {
  lane: AgentRoleLane;
  /** Injected ISO clock — the module holds no clock (determinism). */
  generatedAtIso: string;
  fingerprints: ParityFingerprints;
  /** Full compiler+classifier rows for the lane's persona. */
  rows: CompilerParityRow[];
  /** Orchestration-toolset invocations by lane (from behavior-store rollup). */
  orchestrationHistogram: OrchestrationHistogram;
  /** Reference to precheck against; `null`/absent ⇒ `status='no-reference'` (the
   *  honest worker/researcher case — no hand-derived reference exists). */
  expectations?: ParityExpectations | null;
}

/** Assemble the deterministic parity artifact + run the reference precheck. The
 *  `personaSplit` is computed from the tool-predicate rows; `artifactSha256` is the
 *  hash of the canonical JSON with the hash field blanked. */
export function buildParityArtifact(input: BuildParityArtifactInput): CompilerParityArtifact {
  const { lane, generatedAtIso, fingerprints, rows, orchestrationHistogram } = input;
  const expectations = input.expectations ?? null;
  const personaSplit = personaSplitFromRows(rows);
  const histogram = { ...emptyHistogram(), ...orchestrationHistogram };

  const { status, diff } = precheckFlagship(histogram, personaSplit, expectations);

  const artifact: CompilerParityArtifact = {
    schemaVersion: 1,
    generatedAtIso,
    lane,
    parserVersion: fingerprints.parserVersion,
    predictedActionCompilerVersion: fingerprints.compilerVersion,
    corpusFingerprint: fingerprints.corpusFingerprint,
    configFingerprint: fingerprints.configFingerprint,
    toolsetInventoryFingerprint: fingerprints.toolsetInventoryFingerprint,
    empiricalReportFingerprint: fingerprints.empiricalReportFingerprint,
    orchestrationHistogram: histogram,
    personaSplit,
    rows,
    status,
    diff,
    artifactSha256: '',
  };
  artifact.artifactSha256 = sha256Hex(canonicalJson({ ...artifact, artifactSha256: '' }));
  return artifact;
}

/** Row-level precheck (§4.1): computed flagship vs the frozen reference within
 *  `PARITY_DRIFT_TOLERANCE`. `mismatch` blocks sign-off. */
export function precheckFlagship(
  histogram: OrchestrationHistogram,
  split: PersonaSplit,
  expectations: ParityExpectations | null,
): { status: ParityPrecheckStatus; diff: ParityFlagshipDiff } {
  const diff: ParityFlagshipDiff = { histogram: [], split: [] };
  if (!expectations) return { status: 'no-reference', diff };

  const tol = expectations.driftTolerance ?? OPTIMIZER_CONFIG.PARITY_DRIFT_TOLERANCE;
  for (const l of ALL_LANES) {
    const expected = expectations.orchestrationHistogram[l] ?? 0;
    const computed = histogram[l] ?? 0;
    if (Math.abs(expected - computed) > tol) diff.histogram.push({ lane: l, expected, computed });
  }
  const splitChecks: Array<'occurs' | 'never'> = ['occurs', 'never'];
  for (const key of splitChecks) {
    const expected = expectations.personaSplit[key];
    const computed = split[key];
    if (Math.abs(expected - computed) > tol) diff.split.push({ key, expected, computed });
  }
  const status: ParityPrecheckStatus =
    diff.histogram.length === 0 && diff.split.length === 0 ? 'match' : 'mismatch';
  return { status, diff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign-off record (read-only mirror of `optimizer_derivation_verifications`, §4.3)
// ─────────────────────────────────────────────────────────────────────────────

export type SignOffStatus = 'unverified' | 'verified' | 'stale' | 'mismatch' | 'no-reference';

export interface DerivationSignOffRecord {
  gateName: string; // '<lane>-compiler-parity'
  lane: AgentRoleLane;
  status: SignOffStatus;
  parserVersion: number;
  compilerVersion: number;
  corpusFingerprint: string;
  configFingerprint: string;
  toolsetInventoryFingerprint: string;
  empiricalReportFingerprint: string;
  signedHistogram: OrchestrationHistogram;
  signedSplit: PersonaSplit;
  artifactPath: string;
  artifactSha256: string;
  signedOffBy?: string;
  signedOffAtMs?: number;
  notes?: string;
}

/** The gate name convention (`'<lane>-compiler-parity'`, §4.3). */
export function gateNameForLane(lane: AgentRoleLane): string {
  return `${lane}-compiler-parity`;
}

// ─────────────────────────────────────────────────────────────────────────────
// derivationVerified — the per-lane predicate (§4.4 / §4.5)
// ─────────────────────────────────────────────────────────────────────────────

export type ParityVerificationState =
  | 'verified'
  | 'unverified'
  | 'stale'
  | 'mismatch'
  | 'unverified-no-reference';

export interface CurrentParityInputs {
  fingerprints: ParityFingerprints;
  /** Cheaply-recomputed flagship on the CURRENT corpus (the additional §4.4 guard). */
  histogram: OrchestrationHistogram;
  split: PersonaSplit;
  /** Count of append-only log rows recorded since sign-off, under the SAME corpus
   *  scope + unchanged fingerprints (§4.4). Disclosed, never a staleness trigger. */
  postVerificationEvents?: number;
  /** Injected: ISO of `signedOffAtMs` for `verifiedAsOf` (module holds no clock). */
  verifiedAsOfIso?: string;
}

export interface DerivationVerifiedResult {
  lane: AgentRoleLane;
  verified: boolean;
  state: ParityVerificationState;
  /** Which fingerprint(s) changed (DB-column names) and/or `'flagship-drift'`. */
  staleReasons: string[];
  verifiedAsOf?: string;
  postVerificationEvents?: number;
}

/** Only the supervisor lane has a hand-derived empirical reference (§4.5). */
export function laneHasReference(lane: AgentRoleLane): boolean {
  return lane === 'supervisor';
}

/** Compare two fingerprint sets → the DB-column names that differ, in canonical
 *  order. Empty ⇒ all six match. */
export function fingerprintDrift(
  signed: ParityFingerprints,
  current: ParityFingerprints,
): FingerprintField[] {
  const out: FingerprintField[] = [];
  if (signed.parserVersion !== current.parserVersion) out.push('parser_version');
  if (signed.compilerVersion !== current.compilerVersion) out.push('compiler_version');
  if (signed.corpusFingerprint !== current.corpusFingerprint) out.push('corpus_fingerprint');
  if (signed.configFingerprint !== current.configFingerprint) out.push('config_fingerprint');
  if (signed.toolsetInventoryFingerprint !== current.toolsetInventoryFingerprint)
    out.push('toolset_inventory_fingerprint');
  if (signed.empiricalReportFingerprint !== current.empiricalReportFingerprint)
    out.push('empirical_report_fingerprint');
  return out;
}

function histogramDrift(
  signed: OrchestrationHistogram,
  current: OrchestrationHistogram,
  tol: number,
): boolean {
  return ALL_LANES.some((l) => Math.abs((signed[l] ?? 0) - (current[l] ?? 0)) > tol);
}

function splitDrift(signed: PersonaSplit, current: PersonaSplit, tol: number): boolean {
  return (['occurs', 'never', 'insufficient', 'unobservable'] as const).some(
    (k) => Math.abs(signed[k] - current[k]) > tol,
  );
}

/**
 * The load-bearing predicate. `verified` iff a `verified` sign-off row exists for the
 * lane AND neither a fingerprint mismatch nor flagship drift is present (§4.4).
 *
 * Per-lane honesty (§4.5):
 *  - worker/researcher/legacy → `'unverified-no-reference'` ALWAYS — never promoted
 *    off a supervisor sign-off, even if a row is somehow present.
 *  - supervisor with no `verified` row → reflects the stored status
 *    (`'mismatch'` if the precheck failed, else `'unverified'`).
 *
 * Fingerprints are checked FIRST and independently of the counts: a changed input
 * with a coincidentally-unchanged flagship is still `stale` (§4.4, test §7.21).
 */
export function derivationVerified(
  lane: AgentRoleLane,
  signOff: DerivationSignOffRecord | null,
  current: CurrentParityInputs,
  opts?: { driftTolerance?: number },
): DerivationVerifiedResult {
  // §4.5 — no reference for non-supervisor lanes. Distinct honest state; never verified.
  if (!laneHasReference(lane)) {
    return { lane, verified: false, state: 'unverified-no-reference', staleReasons: [] };
  }

  if (!signOff || signOff.status !== 'verified') {
    const state: ParityVerificationState = signOff?.status === 'mismatch' ? 'mismatch' : 'unverified';
    return { lane, verified: false, state, staleReasons: [] };
  }

  const tol = opts?.driftTolerance ?? OPTIMIZER_CONFIG.PARITY_DRIFT_TOLERANCE;
  const signedFingerprints: ParityFingerprints = {
    parserVersion: signOff.parserVersion,
    compilerVersion: signOff.compilerVersion,
    corpusFingerprint: signOff.corpusFingerprint,
    configFingerprint: signOff.configFingerprint,
    toolsetInventoryFingerprint: signOff.toolsetInventoryFingerprint,
    empiricalReportFingerprint: signOff.empiricalReportFingerprint,
  };

  const staleReasons: string[] = [...fingerprintDrift(signedFingerprints, current.fingerprints)];
  const flagshipDrift =
    histogramDrift(signOff.signedHistogram, current.histogram, tol) ||
    splitDrift(signOff.signedSplit, current.split, tol);
  if (flagshipDrift) staleReasons.push('flagship-drift');

  if (staleReasons.length > 0) {
    return { lane, verified: false, state: 'stale', staleReasons };
  }

  // Verified. Routine append-only growth is disclosed, not a staleness trigger (§4.4).
  return {
    lane,
    verified: true,
    state: 'verified',
    staleReasons: [],
    verifiedAsOf: current.verifiedAsOfIso,
    postVerificationEvents: current.postVerificationEvents ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal-facing helpers (§4.5 / §4.6) — the gate governs only the derived subtracts
// ─────────────────────────────────────────────────────────────────────────────

/** A proposal's `requiresDerivationGate` = OR over its actions (§4.5). */
export function proposalRequiresDerivationGate(actions: PredictedAction[]): boolean {
  return actions.some((a) => a.requiresDerivationGate);
}

export interface ProposalVerification {
  state: ParityVerificationState;
  verified: boolean;
  requiresDerivationGate: boolean;
  staleReasons?: string[];
  verifiedAsOf?: string;
}

/** Resolve the `verification` block a proposal carries. A proposal that does NOT
 *  require the gate (cluster/bypass-derived `add-*`, bypass `tune-skill-trigger`) is
 *  UNAFFECTED — it reports the lane's derivation state for transparency but is never
 *  suppressed by it (§4.5). */
export function resolveProposalVerification(
  requiresDerivationGate: boolean,
  derivation: DerivationVerifiedResult,
): ProposalVerification {
  return {
    state: derivation.state,
    verified: derivation.verified,
    requiresDerivationGate,
    staleReasons: derivation.staleReasons.length > 0 ? derivation.staleReasons : undefined,
    verifiedAsOf: derivation.verifiedAsOf,
  };
}

/** §4.6 WP7 rule: a gate-governed proposal that is NOT derivation-verified is excluded
 *  from the agent actionable list by default (but always disclosed via
 *  `meta.unverifiedSuppressedCount`). Cluster/bypass proposals are never suppressed. */
export function isSuppressedFromAgentSurface(
  requiresDerivationGate: boolean,
  verified: boolean,
): boolean {
  return requiresDerivationGate && !verified;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateParityArtifact — thin production composition (WP6 seam)
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateParityArtifactDeps {
  /** Injected ISO clock. */
  generatedAtIso: string;
  /** Run the §5.1 compiler + §5.2 classifier over the lane's persona → artifact rows.
   *  Real-corpus wiring is a WP6 orchestrator concern; this seam keeps the module
   *  pure + testable. */
  compileRows: (lane: AgentRoleLane) => CompilerParityRow[];
  /** Orchestration-toolset invocation histogram (behavior-store rollup). */
  orchestrationHistogram: (lane: AgentRoleLane) => OrchestrationHistogram;
  /** Current fingerprints for the lane. */
  fingerprints: (lane: AgentRoleLane) => ParityFingerprints;
  /** Reference expectations for the lane (`null` for lanes with no reference). */
  expectations: (lane: AgentRoleLane) => ParityExpectations | null;
}

/**
 * Compose the injected deps into a parity artifact for `lane` (§4.1). Deterministic
 * given deterministic deps. The caller (WP6) persists the `.json`/`.tsv` to
 * `plans/optimizer-parity/<lane>-parity.*` (NEVER under `.claude/`); this module only
 * computes the artifact object.
 */
export function generateParityArtifact(
  lane: AgentRoleLane,
  deps: GenerateParityArtifactDeps,
): CompilerParityArtifact {
  return buildParityArtifact({
    lane,
    generatedAtIso: deps.generatedAtIso,
    fingerprints: deps.fingerprints(lane),
    rows: deps.compileRows(lane),
    orchestrationHistogram: deps.orchestrationHistogram(lane),
    expectations: deps.expectations(lane),
  });
}

/** Convenience fingerprint set from the current build-time versions + the three
 *  content hashes a caller has on hand. Keeps `PREDICTED_ACTION_COMPILER_VERSION` /
 *  `RESIDENT_PARSER_VERSION` as the single source of the two version fields. */
export function currentFingerprints(parts: {
  corpusFingerprint: string;
  configFingerprint: string;
  toolsetInventoryFingerprint: string;
  empiricalReportFingerprint: string;
}): ParityFingerprints {
  return {
    parserVersion: RESIDENT_PARSER_VERSION,
    compilerVersion: PREDICTED_ACTION_COMPILER_VERSION,
    ...parts,
  };
}
