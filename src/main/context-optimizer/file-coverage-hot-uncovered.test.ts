// WP3 (G3) — hotUncoveredCandidate + bounded coverageChecks tests (plan WP3 point 1).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/file-coverage-hot-uncovered.test.js
//
// Coverage: the explicit role allowlist (hot product-source → candidate; test →
// candidate; build-control → candidate; vendor/generated → excluded; noisy artifact
// → excluded; guidance .md → NOT this candidate), the disclosed score threshold,
// the zero-predicate-match bar (a matching prediction disqualifies, disclosed), and
// coverageChecks bounding + truncation metadata.

import assert from 'node:assert/strict';
import type { AgentRoleLane } from '../../shared/types';
import type { PredictedAction } from './guidance-action-model';
import { OPTIMIZER_CONFIG } from './optimizer-config';
import {
  classifyFileCoverage,
  isBuildControlBasename,
  isHotUncoveredEligibleRole,
  HOT_UNCOVERED_ROLE_ALLOWLIST,
  HOT_UNCOVERED_EXCLUDED_ROLES,
  type ClassifyDeps,
  type FileTouch,
} from './file-coverage';

const SUP: AgentRoleLane = 'supervisor';

const DEPS: ClassifyDeps = { classifyPathMutability: () => 'user-owned' };

function touch(over: Partial<FileTouch> & { path: string }): FileTouch {
  // reads 4 + writes 3 → canonical score 4 + 6 = 10 = HOT_UNCOVERED_MIN_SCORE.
  return { reads: 4, writes: 3, executes: 0, distinctStreams: 2, ...over };
}

function pathTouchAction(over: Partial<PredictedAction> & { id: string }): PredictedAction {
  return {
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 5 },
    sourceKind: 'capability' as PredictedAction['sourceKind'],
    lanes: [SUP],
    kind: 'path-touch',
    params: { pathGlob: '/w/config/*.yaml' },
    derivability: 'exact',
    residentTokens: 40,
    sourceSectionKey: 'sec-1',
    sourceEpochId: 'ep-1',
    requiresDerivationGate: true,
    ...over,
  };
}

function classify(touches: FileTouch[], actions: PredictedAction[] = []) {
  return classifyFileCoverage(SUP, touches, actions, [], [], DEPS);
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
}

// ── role allowlist ────────────────────────────────────────────────────────────

check('hot uncovered product-source with zero predicate matches → candidate', () => {
  const res = classify([touch({ path: '/w/src/app.ts' })]);
  const row = res.fileHeat[0];
  assert.equal(row.role, 'product-source');
  assert.equal(row.coverage, 'uncovered');
  assert.equal(row.hotUncoveredCandidate, true);
  assert.ok(row.coverageChecks);
  assert.equal(row.coverageChecks!.matched, 0);
  assert.equal(res.hotUncoveredCandidateCount, 1);
});

check('test file (test-or-fixture) is explicitly allowlisted → candidate', () => {
  const res = classify([touch({ path: '/w/tests/app.test.ts' })]);
  const row = res.fileHeat[0];
  assert.equal(row.role, 'test-or-fixture');
  assert.equal(row.hotUncoveredCandidate, true);
});

check('build-control file (package.json → guidance-or-config role) → candidate', () => {
  const res = classify([touch({ path: '/w/package.json' })]);
  const row = res.fileHeat[0];
  assert.equal(row.role, 'guidance-or-config');
  assert.equal(row.hotUncoveredCandidate, true);
});

check('vendor path (node_modules) → excluded', () => {
  const res = classify([touch({ path: '/w/node_modules/lib/x.js' })]);
  const row = res.fileHeat[0];
  assert.equal(row.role, 'dependency-or-vendor');
  assert.notEqual(row.hotUncoveredCandidate, true);
  assert.equal(row.coverageChecks, undefined);
});

check('generated path (dist/) → excluded', () => {
  const res = classify([touch({ path: '/w/dist/out.js' })]);
  assert.equal(res.fileHeat[0].role, 'build-generated');
  assert.notEqual(res.fileHeat[0].hotUncoveredCandidate, true);
});

check('noisy artifact (*.min.js → build-generated) → excluded', () => {
  const res = classify([touch({ path: '/w/src/app.min.js' })]);
  assert.equal(res.fileHeat[0].role, 'build-generated');
  assert.notEqual(res.fileHeat[0].hotUncoveredCandidate, true);
});

check('a guidance .md file is NOT this candidate (guidanceGapCandidate owns it)', () => {
  const res = classify([touch({ path: '/w/notes.md' })]);
  const row = res.fileHeat[0];
  assert.equal(row.role, 'guidance-or-config');
  assert.notEqual(row.hotUncoveredCandidate, true);
});

check('allowlist constants: exact real-enum names; generated/vendor explicitly excluded', () => {
  assert.ok(HOT_UNCOVERED_ROLE_ALLOWLIST.has('product-source'));
  assert.ok(HOT_UNCOVERED_ROLE_ALLOWLIST.has('test-or-fixture'));
  assert.ok(HOT_UNCOVERED_EXCLUDED_ROLES.has('build-generated'));
  assert.ok(HOT_UNCOVERED_EXCLUDED_ROLES.has('dependency-or-vendor'));
  assert.equal(isHotUncoveredEligibleRole('build-generated', 'x.js'), false);
  assert.equal(isHotUncoveredEligibleRole('dependency-or-vendor', 'x.js'), false);
  assert.equal(isHotUncoveredEligibleRole('product-source', 'x.ts'), true);
  // build-control maps onto guidance-or-config by basename ONLY.
  assert.equal(isHotUncoveredEligibleRole('guidance-or-config', 'package.json'), true);
  assert.equal(isHotUncoveredEligibleRole('guidance-or-config', 'readme.md'), false);
  assert.equal(isBuildControlBasename('tsconfig.build.json'), true);
  assert.equal(isBuildControlBasename('vite.config.ts'), true);
  assert.equal(isBuildControlBasename('claude.md'), false);
});

// ── score threshold ───────────────────────────────────────────────────────────

check('below the disclosed score threshold → excluded (no coverageChecks attached)', () => {
  const res = classify([touch({ path: '/w/src/cold.ts', reads: 2, writes: 0 })]); // score 2
  const row = res.fileHeat[0];
  assert.notEqual(row.hotUncoveredCandidate, true);
  assert.equal(row.coverageChecks, undefined);
});

check('exactly at the threshold → candidate (score >= HOT_UNCOVERED_MIN_SCORE)', () => {
  const res = classify([touch({ path: '/w/src/edge.ts' })]); // score 10
  assert.equal(res.fileHeat[0].score, OPTIMIZER_CONFIG.HOT_UNCOVERED_MIN_SCORE);
  assert.equal(res.fileHeat[0].hotUncoveredCandidate, true);
});

// ── guidance-prediction matching ──────────────────────────────────────────────

check('an exact open-epoch prediction match → config-referenced bucket, never a candidate', () => {
  const a = pathTouchAction({ id: 'p1', params: { pathGlob: '/w/src/*.ts' } });
  const res = classify([touch({ path: '/w/src/app.ts' })], [a]);
  const row = res.fileHeat.find((h) => h.pathDisplay === '/w/src/app.ts')!;
  assert.equal(row.coverage, 'config-referenced', 'the exact match covers the path outright');
  assert.notEqual(row.hotUncoveredCandidate, true, 'a covered path is not a candidate');
  assert.equal(res.hotUncoveredCandidateCount, 0);
});

check('an uncovered path with a NON-bucket-grade prediction match: matched > 0 disclosed', () => {
  // Closed-epoch (isOpenEpoch false) predictions do not create a config-referenced
  // umbrella, but the conservative WP3 sweep still counts them — the near-miss is
  // disclosed via coverageChecks, never silently dropped.
  const a = pathTouchAction({ id: 'p1', params: { pathGlob: '/w/src/*.ts' } });
  const deps: ClassifyDeps = { ...DEPS, isOpenEpoch: () => false };
  const res = classifyFileCoverage(SUP, [touch({ path: '/w/src/app.ts' })], [a], [], [], deps);
  const row = res.fileHeat.find((h) => h.pathDisplay === '/w/src/app.ts')!;
  assert.equal(row.coverage, 'uncovered', 'a closed-epoch reference does not cover');
  assert.notEqual(row.hotUncoveredCandidate, true, 'but it still disqualifies the candidate');
  assert.ok(row.coverageChecks, 'the near-miss is disclosed, not silently dropped');
  assert.equal(row.coverageChecks!.matched, 1);
  assert.equal(row.coverageChecks!.totalPredicatesTested, 1);
  assert.equal(res.hotUncoveredCandidateCount, 0);
});

check('predictions for OTHER lanes are not tested (lane-scoped sweep)', () => {
  const a = pathTouchAction({ id: 'p1', lanes: ['worker'], params: { pathGlob: '/w/src/*.ts' } });
  const res = classify([touch({ path: '/w/src/app.ts' })], [a]);
  const row = res.fileHeat[0];
  assert.equal(row.hotUncoveredCandidate, true);
  assert.equal(row.coverageChecks!.totalPredicatesTested, 0);
});

check('non-exact (heuristic) predictions still disqualify — fail-closed for proposing', () => {
  const a = pathTouchAction({ id: 'p1', derivability: 'heuristic', params: { pathGlob: '/w/src/*.ts' } });
  const res = classify([touch({ path: '/w/src/app.ts' })], [a]);
  assert.notEqual(res.fileHeat[0].hotUncoveredCandidate, true);
  assert.equal(res.fileHeat[0].coverageChecks!.matched, 1);
});

// ── coverageChecks bounding + truncation metadata ─────────────────────────────

check('coverageChecks is BOUNDED: capped sample + truncation metadata, never the full list', () => {
  const limit = OPTIMIZER_CONFIG.COVERAGE_CHECKS_SAMPLE_LIMIT;
  const actions = Array.from({ length: limit + 2 }, (_, i) =>
    pathTouchAction({ id: `p${String(i).padStart(2, '0')}`, params: { pathGlob: `/w/config/a${i}.yaml` } }));
  const res = classify([touch({ path: '/w/src/app.ts' })], actions);
  const checks = res.fileHeat[0].coverageChecks!;
  assert.equal(checks.totalPredicatesTested, limit + 2);
  assert.equal(checks.matched, 0);
  assert.equal(checks.sample.length, limit, 'sample capped at the disclosed limit');
  assert.equal(checks.truncated, true);
  assert.equal(checks.limit, limit);
  assert.equal(res.fileHeat[0].hotUncoveredCandidate, true);
});

check('under the cap: truncated=false and the sample is deterministic (id-ordered)', () => {
  const actions = [
    pathTouchAction({ id: 'p2', params: { pathGlob: '/w/b/*.md' } }),
    pathTouchAction({ id: 'p1', params: { pathGlob: '/w/a/*.md' } }),
  ];
  const res = classify([touch({ path: '/w/src/app.ts' })], actions);
  const checks = res.fileHeat[0].coverageChecks!;
  assert.equal(checks.truncated, false);
  assert.deepEqual(checks.sample, ['p1:/w/a/*.md', 'p2:/w/b/*.md']);
});

// ── determinism ───────────────────────────────────────────────────────────────

check('byte-identical determinism: same inputs → deep-equal results', () => {
  const touches = [touch({ path: '/w/src/app.ts' }), touch({ path: '/w/package.json' })];
  const actions = [pathTouchAction({ id: 'p1' })];
  assert.deepEqual(classify(touches, actions), classify(touches, actions));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
