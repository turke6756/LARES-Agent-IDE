// compiler-parity-gate unit tests (classifier addendum §4 / test plan §7.19–24).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/compiler-parity-gate.test.js
//
// Coverage: artifact fingerprints + row table + precheck (§7.19); derivationVerified
// only after a matching verified row (§7.20); necessary-not-sufficient fingerprint
// staleness (§7.21); append-only growth is not stale (§7.22); worker → no-reference
// (§7.23); unverified proposal governance + bypass-unaffected (§7.24); plus the
// artifact-sha determinism and reference-fixture honesty guards.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRoleLane } from '../../shared/types';
import type { PredictedAction } from './guidance-action-model';
import {
  PREDICTED_ACTION_COMPILER_VERSION,
  RESIDENT_PARSER_VERSION,
} from './optimizer-config';
import {
  buildParityArtifact,
  derivationVerified,
  fingerprintDrift,
  gateNameForLane,
  generateParityArtifact,
  isSuppressedFromAgentSurface,
  personaSplitFromRows,
  precheckFlagship,
  proposalRequiresDerivationGate,
  resolveProposalVerification,
  type CompilerParityRow,
  type CurrentParityInputs,
  type DerivationSignOffRecord,
  type OrchestrationHistogram,
  type ParityExpectations,
  type ParityFingerprints,
  type PersonaSplit,
} from './compiler-parity-gate';

// ── fixture builders ─────────────────────────────────────────────────────────

const REF_HISTOGRAM: OrchestrationHistogram = { legacy: 0, supervisor: 239, worker: 0, researcher: 0 };
const REF_SPLIT: PersonaSplit = { occurs: 19, never: 18, insufficient: 0, unobservable: 0 };

function expectations(over: Partial<ParityExpectations> = {}): ParityExpectations {
  return {
    schemaVersion: 1,
    lane: 'supervisor',
    source: 'plans/empirical-log-signal-report.md',
    orchestrationHistogram: REF_HISTOGRAM,
    personaSplit: { occurs: 19, never: 18 },
    driftTolerance: 0,
    ...over,
  };
}

function fingerprints(over: Partial<ParityFingerprints> = {}): ParityFingerprints {
  return {
    parserVersion: RESIDENT_PARSER_VERSION,
    compilerVersion: PREDICTED_ACTION_COMPILER_VERSION,
    corpusFingerprint: 'corpus-A',
    configFingerprint: 'config-A',
    toolsetInventoryFingerprint: 'toolset-A',
    empiricalReportFingerprint: 'report-A',
    ...over,
  };
}

function toolRow(status: CompilerParityRow['classifierStatus'], i: number): CompilerParityRow {
  return {
    sourcePath: '/w/.dashboard/supervisor/CLAUDE.md',
    line: 100 + i,
    sectionKey: `markdown_section:/w:sec${i}`,
    predictedActionId: `act-${i}`,
    kind: 'tool-invocation',
    params: { toolName: `tool_${i}` },
    derivability: 'exact',
    classifierStatus: status,
    occurrences: status === 'occurs' ? 3 : 0,
    exposureTurns: 200,
  };
}

/** 19 occurs + 18 never tool rows + one non-tool (path-touch) row (excluded from the split). */
function refRows(): CompilerParityRow[] {
  const rows: CompilerParityRow[] = [];
  for (let i = 0; i < 19; i++) rows.push(toolRow('occurs', i));
  for (let i = 0; i < 18; i++) rows.push(toolRow('never', 100 + i));
  rows.push({
    sourcePath: '/w/.dashboard/supervisor/CLAUDE.md',
    line: 400,
    sectionKey: 'markdown_section:/w:pt',
    predictedActionId: 'pt-1',
    kind: 'path-touch',
    params: { pathGlob: 'docs/x.md' },
    derivability: 'exact',
    classifierStatus: 'never',
    occurrences: 0,
    exposureTurns: 200,
  });
  return rows;
}

function signOff(over: Partial<DerivationSignOffRecord> = {}): DerivationSignOffRecord {
  return {
    gateName: 'supervisor-compiler-parity',
    lane: 'supervisor',
    status: 'verified',
    parserVersion: RESIDENT_PARSER_VERSION,
    compilerVersion: PREDICTED_ACTION_COMPILER_VERSION,
    corpusFingerprint: 'corpus-A',
    configFingerprint: 'config-A',
    toolsetInventoryFingerprint: 'toolset-A',
    empiricalReportFingerprint: 'report-A',
    signedHistogram: REF_HISTOGRAM,
    signedSplit: REF_SPLIT,
    artifactPath: 'plans/optimizer-parity/supervisor-parity.json',
    artifactSha256: 'sha-A',
    signedOffBy: 'edward',
    signedOffAtMs: 1_700_000_000_000,
    ...over,
  };
}

function current(over: Partial<CurrentParityInputs> = {}): CurrentParityInputs {
  return {
    fingerprints: fingerprints(),
    histogram: REF_HISTOGRAM,
    split: REF_SPLIT,
    postVerificationEvents: 0,
    verifiedAsOfIso: '2023-11-14T22:13:20.000Z',
    ...over,
  };
}

function action(over: Partial<PredictedAction> = {}): PredictedAction {
  return {
    id: 'a1',
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 10 },
    sourceKind: 'tool',
    lanes: ['supervisor'] as AgentRoleLane[],
    kind: 'toolset-usage',
    params: { toolset: 'orchestration' },
    derivability: 'exact',
    residentTokens: 100,
    sourceSectionKey: 'markdown_section:/w:sec',
    sourceEpochId: 'e1',
    requiresDerivationGate: true,
    ...over,
  };
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

// ── §7.19 — artifact carries fingerprints + rows; 239/0 + 19/18 pass; miss → mismatch ──

check('§7.19 artifact carries all four content fingerprints + versions + row table', () => {
  const art = buildParityArtifact({
    lane: 'supervisor',
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    fingerprints: fingerprints(),
    rows: refRows(),
    orchestrationHistogram: REF_HISTOGRAM,
    expectations: expectations(),
  });
  assert.equal(art.corpusFingerprint, 'corpus-A');
  assert.equal(art.configFingerprint, 'config-A');
  assert.equal(art.toolsetInventoryFingerprint, 'toolset-A');
  assert.equal(art.empiricalReportFingerprint, 'report-A');
  assert.equal(art.parserVersion, RESIDENT_PARSER_VERSION);
  assert.equal(art.predictedActionCompilerVersion, PREDICTED_ACTION_COMPILER_VERSION);
  assert.equal(art.rows.length, 38); // 19 + 18 + 1 non-tool
  assert.ok(art.artifactSha256.length === 64);
});

check('§7.19 histogram 239/0 and split 19/18 → status=match (path-touch row excluded)', () => {
  const art = buildParityArtifact({
    lane: 'supervisor',
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    fingerprints: fingerprints(),
    rows: refRows(),
    orchestrationHistogram: REF_HISTOGRAM,
    expectations: expectations(),
  });
  assert.deepEqual(art.personaSplit, { occurs: 19, never: 18, insufficient: 0, unobservable: 0 });
  assert.equal(art.status, 'match');
  assert.equal(art.diff.histogram.length, 0);
  assert.equal(art.diff.split.length, 0);
});

check('§7.19 sentinel miss (split 18/18) → status=mismatch, diff enumerates the delta', () => {
  const rows = refRows().slice(1); // drop one occurs row → 18 occurs / 18 never
  const art = buildParityArtifact({
    lane: 'supervisor',
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    fingerprints: fingerprints(),
    rows,
    orchestrationHistogram: REF_HISTOGRAM,
    expectations: expectations(),
  });
  assert.equal(art.status, 'mismatch');
  assert.deepEqual(art.diff.split, [{ key: 'occurs', expected: 19, computed: 18 }]);
});

check('§7.19 histogram miss (worker=5) → mismatch enumerating the lane', () => {
  const art = buildParityArtifact({
    lane: 'supervisor',
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    fingerprints: fingerprints(),
    rows: refRows(),
    orchestrationHistogram: { ...REF_HISTOGRAM, worker: 5 },
    expectations: expectations(),
  });
  assert.equal(art.status, 'mismatch');
  assert.deepEqual(art.diff.histogram, [{ lane: 'worker', expected: 0, computed: 5 }]);
});

check('artifact_sha256 is byte-stable across key-order-independent rebuilds', () => {
  const mk = () =>
    buildParityArtifact({
      lane: 'supervisor',
      generatedAtIso: '2026-07-06T00:00:00.000Z',
      fingerprints: fingerprints(),
      rows: refRows(),
      orchestrationHistogram: REF_HISTOGRAM,
      expectations: expectations(),
    });
  assert.equal(mk().artifactSha256, mk().artifactSha256);
});

check('personaSplitFromRows counts only tool-predicate kinds', () => {
  assert.deepEqual(personaSplitFromRows(refRows()), {
    occurs: 19,
    never: 18,
    insufficient: 0,
    unobservable: 0,
  });
});

// ── §7.20 — derivationVerified true only after a matching verified row ───────────

check('§7.20 no sign-off row → unverified, not verified', () => {
  const r = derivationVerified('supervisor', null, current());
  assert.equal(r.verified, false);
  assert.equal(r.state, 'unverified');
});

check('§7.20 verified row + all fingerprints match + flagship matches → verified', () => {
  const r = derivationVerified('supervisor', signOff(), current());
  assert.equal(r.verified, true);
  assert.equal(r.state, 'verified');
  assert.deepEqual(r.staleReasons, []);
  assert.equal(r.verifiedAsOf, '2023-11-14T22:13:20.000Z');
});

check('§7.20 stored mismatch status → mismatch state, not verified', () => {
  const r = derivationVerified('supervisor', signOff({ status: 'mismatch' }), current());
  assert.equal(r.verified, false);
  assert.equal(r.state, 'mismatch');
});

check('§7.20 flagship recompute drift alone → stale with flagship-drift', () => {
  const r = derivationVerified('supervisor', signOff(), current({ split: { ...REF_SPLIT, never: 17 } }));
  assert.equal(r.verified, false);
  assert.equal(r.state, 'stale');
  assert.deepEqual(r.staleReasons, ['flagship-drift']);
});

// ── §7.21 — necessary-not-sufficient: changed fingerprint, coincident counts → stale ──

check('§7.21 changed config_fingerprint w/ unchanged flagship → stale [config_fingerprint]', () => {
  const r = derivationVerified(
    'supervisor',
    signOff(),
    current({ fingerprints: fingerprints({ configFingerprint: 'config-B' }) }),
  );
  assert.equal(r.verified, false);
  assert.equal(r.state, 'stale');
  assert.deepEqual(r.staleReasons, ['config_fingerprint']);
});

check('§7.21 compiler_version bump alone → stale [compiler_version]', () => {
  const r = derivationVerified(
    'supervisor',
    signOff(),
    current({ fingerprints: fingerprints({ compilerVersion: PREDICTED_ACTION_COMPILER_VERSION + 1 }) }),
  );
  assert.deepEqual(r.staleReasons, ['compiler_version']);
});

check('§7.21 multiple fingerprint changes surfaced in canonical order', () => {
  const r = derivationVerified(
    'supervisor',
    signOff(),
    current({
      fingerprints: fingerprints({ corpusFingerprint: 'corpus-B', empiricalReportFingerprint: 'report-B' }),
      split: { ...REF_SPLIT, occurs: 20 },
    }),
  );
  assert.deepEqual(r.staleReasons, ['corpus_fingerprint', 'empirical_report_fingerprint', 'flagship-drift']);
});

check('fingerprintDrift is empty when all six match', () => {
  assert.deepEqual(fingerprintDrift(fingerprints(), fingerprints()), []);
});

// ── §7.22 — append-only new rows under unchanged fingerprints → NOT stale ────────

check('§7.22 append-only growth (postVerificationEvents>0, fingerprints unchanged) → verified', () => {
  const r = derivationVerified('supervisor', signOff(), current({ postVerificationEvents: 4210 }));
  assert.equal(r.verified, true);
  assert.equal(r.state, 'verified');
  assert.equal(r.postVerificationEvents, 4210);
});

// ── §7.23 — worker/researcher → unverified-no-reference, never verified ──────────

check('§7.23 worker lane → unverified-no-reference (no reference table)', () => {
  const r = derivationVerified('worker', null, current());
  assert.equal(r.verified, false);
  assert.equal(r.state, 'unverified-no-reference');
  assert.deepEqual(r.staleReasons, []);
});

check('§7.23 worker NEVER promoted even if a verified row is somehow present', () => {
  const r = derivationVerified('worker', signOff({ lane: 'worker', gateName: 'worker-compiler-parity' }), current());
  assert.equal(r.verified, false);
  assert.equal(r.state, 'unverified-no-reference');
});

check('§7.23 researcher + legacy also unverified-no-reference', () => {
  assert.equal(derivationVerified('researcher', null, current()).state, 'unverified-no-reference');
  assert.equal(derivationVerified('legacy', null, current()).state, 'unverified-no-reference');
});

// ── §7.24 — unverified proposal governance; bypass/cluster unaffected ────────────

check('§7.24 proposalRequiresDerivationGate = OR over actions', () => {
  assert.equal(proposalRequiresDerivationGate([action({ requiresDerivationGate: false })]), false);
  assert.equal(
    proposalRequiresDerivationGate([
      action({ requiresDerivationGate: false }),
      action({ requiresDerivationGate: true }),
    ]),
    true,
  );
});

check('§7.24 gate-governed + unverified subtract → suppressed from agent surface', () => {
  const derivation = derivationVerified('supervisor', null, current());
  assert.equal(isSuppressedFromAgentSurface(true, derivation.verified), true);
  const v = resolveProposalVerification(true, derivation);
  assert.equal(v.requiresDerivationGate, true);
  assert.equal(v.verified, false);
  assert.equal(v.state, 'unverified');
});

check('§7.24 bypass tune-skill-trigger (requiresDerivationGate=false) UNAFFECTED by the gate', () => {
  const derivation = derivationVerified('supervisor', null, current()); // unverified
  assert.equal(isSuppressedFromAgentSurface(false, derivation.verified), false);
  const v = resolveProposalVerification(false, derivation);
  assert.equal(v.requiresDerivationGate, false);
  // still reports lane state for transparency, but is never suppressed
  assert.equal(v.state, 'unverified');
});

check('§7.24 verified gate-governed subtract → not suppressed', () => {
  const derivation = derivationVerified('supervisor', signOff(), current());
  assert.equal(isSuppressedFromAgentSurface(true, derivation.verified), false);
});

// ── precheckFlagship no-reference (worker/researcher path) ───────────────────────

check('precheckFlagship with no expectations → no-reference, empty diff', () => {
  const { status, diff } = precheckFlagship(REF_HISTOGRAM, REF_SPLIT, null);
  assert.equal(status, 'no-reference');
  assert.equal(diff.histogram.length, 0);
});

check('buildParityArtifact for a no-reference lane → status=no-reference', () => {
  const art = buildParityArtifact({
    lane: 'worker',
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    fingerprints: fingerprints(),
    rows: refRows(),
    orchestrationHistogram: emptyForWorker(),
    expectations: null,
  });
  assert.equal(art.status, 'no-reference');
});

function emptyForWorker(): OrchestrationHistogram {
  return { legacy: 0, supervisor: 0, worker: 0, researcher: 0 };
}

// ── generateParityArtifact composition seam ─────────────────────────────────────

check('generateParityArtifact composes injected deps deterministically', () => {
  const art = generateParityArtifact('supervisor', {
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    compileRows: () => refRows(),
    orchestrationHistogram: () => REF_HISTOGRAM,
    fingerprints: () => fingerprints(),
    expectations: () => expectations(),
  });
  assert.equal(art.lane, 'supervisor');
  assert.equal(art.status, 'match');
});

check('gateNameForLane matches the DB convention', () => {
  assert.equal(gateNameForLane('supervisor'), 'supervisor-compiler-parity');
});

// ── fixture honesty: the shipped parity-expectations.json pins the report numbers ──

check('parity-expectations.json fixture pins the frozen 239/0 + 19/18 reference', () => {
  const fixturePath = path.resolve(
    __dirname,
    '../../../../plans/optimizer-parity/parity-expectations.json',
  );
  const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as ParityExpectations;
  assert.equal(fx.lane, 'supervisor');
  assert.equal(fx.driftTolerance, 0);
  assert.equal(fx.orchestrationHistogram.supervisor, 239);
  assert.equal(fx.orchestrationHistogram.worker, 0);
  assert.equal(fx.orchestrationHistogram.researcher, 0);
  assert.equal(fx.personaSplit.occurs, 19);
  assert.equal(fx.personaSplit.never, 18);
  // and the shipped fixture actually passes the precheck against reference rows
  const { status } = precheckFlagship(REF_HISTOGRAM, REF_SPLIT, fx);
  assert.equal(status, 'match');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
