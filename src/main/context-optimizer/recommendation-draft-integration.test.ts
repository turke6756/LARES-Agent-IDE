// WP3 (G3) — engine integration: hot-uncovered candidates → ADD proposals with
// recommendation drafts; command_family clusters → workspace-level drafts.
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/recommendation-draft-integration.test.js

import assert from 'node:assert/strict';
import type { GuidanceSource } from '../../shared/types';
import type { DerivationVerifiedResult } from './compiler-parity-gate';
import type { FileCoverageResult, FileHeatEntry } from './file-coverage';
import type { ImprovisationCandidate } from './improvisation-clusters';
import { findCausalToken, targetIsFile } from './recommendation-draft';
import {
  generateContextOptimizerProposals,
  type LaneOptimizerInput,
  type LaneResidentSummary,
} from './context-optimizer';

// ── fixtures ─────────────────────────────────────────────────────────────────

const derivation: DerivationVerifiedResult = {
  lane: 'supervisor', verified: false, state: 'unverified', staleReasons: [],
};
const resident: LaneResidentSummary = {
  residentTokens: 5000, claude: 3000, mcp: 1800, skillHeaders: 200,
  exposureTurns: 100, exposureStreams: 5, exposureSlugs: 3,
};

function hotEntry(over: Partial<FileHeatEntry> = {}): FileHeatEntry {
  return {
    pathDisplay: '/w/src/app.ts',
    pathHash: 'hash-app',
    coverage: 'uncovered',
    reads: 4, writes: 3, executes: 0, distinctStreams: 2,
    role: 'product-source', roleReason: 'a .ts source file',
    operationalNoise: false, score: 10,
    scoreComponents: { reads: 4, writes: 3, executes: 0, distinctStreams: 2 },
    guidanceGapCandidate: false,
    hotUncoveredCandidate: true,
    coverageChecks: { totalPredicatesTested: 2, matched: 0, sample: ['p1:/w/config/*.yaml'], truncated: false, limit: 10 },
    ...over,
  };
}

function coverage(entries: FileHeatEntry[]): FileCoverageResult {
  return {
    lane: 'supervisor',
    fileHeat: entries,
    bucketCounts: {
      ignored: 0, 'scaffold-vendor': 0, 'skill-owned': 0, 'skill-owned-resource': 0,
      'config-referenced': 0, uncovered: entries.length,
    },
    uncoveredHot: entries.filter((e) => e.coverage === 'uncovered'),
    hotUncoveredCandidateCount: entries.filter((e) => e.hotUncoveredCandidate).length,
  };
}

const agentsMd: GuidanceSource = {
  path: '/w/AGENTS.md', fileKind: 'agents-md', audienceProviders: ['codex'],
  applicability: { model: 'directory-chain' }, loadingSemanticsConfidence: 'documented',
};

function lane(over: Partial<LaneOptimizerInput> = {}): LaneOptimizerInput {
  return {
    lane: 'supervisor', resident, actions: [], verdicts: [], clusters: [],
    bypass: { proposals: [], watchItems: [] }, drift: [], derivation, ...over,
  };
}

function run(over: Partial<LaneOptimizerInput> = {}) {
  return generateContextOptimizerProposals({
    generatedAtIso: '2026-07-21T00:00:00.000Z',
    lanes: [lane(over)],
  });
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
}

// ── hot-uncovered → file-targeted draft ───────────────────────────────────────

check('hot uncovered candidate + single-audience cohort → ADD proposal with a FILE-targeted draft', () => {
  const res = run({
    coverage: coverage([hotEntry()]),
    guidanceSources: [agentsMd],
    observedProviders: ['codex'],
  });
  const p = res.proposals.find((x) => x.id === 'add-hot-uncovered:supervisor:hash-app');
  assert.ok(p, 'the hot-uncovered ADD proposal exists');
  assert.equal(p!.kind, 'add-missing-guidance');
  assert.equal(p!.lever, 'add');
  const d = p!.recommendationDraft;
  assert.ok(d, 'recommendationDraft attached');
  assert.ok(targetIsFile(d!.target), 'audience resolved → file target');
  assert.equal((d!.target as { file: string }).file, '/w/AGENTS.md');
  assert.equal(p!.target.absPath, '/w/AGENTS.md', 'proposal target mirrors the resolved guidance file');
  assert.equal(d!.humanReviewRequired, true);
  assert.equal(findCausalToken(d!.claim), null, 'no causal token in the generated claim');
  assert.deepEqual(d!.evidence.map((e) => e.kind).sort(), ['coverage-check', 'file-heat']);
  for (const e of d!.evidence) {
    assert.deepEqual(e.rowIds, ['hash-app'], 'evidence cites the file-heat/coverage row id');
    assert.equal(e.generationId, res.meta.recommendationGenerationId,
      'evidence is joinable by the result-level generation id');
  }
});

check('mixed cohort without a single covering source → target unresolved (never CLAUDE.md)', () => {
  const res = run({
    coverage: coverage([hotEntry()]),
    guidanceSources: [agentsMd],
    observedProviders: ['codex', 'claude'],
  });
  const d = res.proposals.find((x) => x.id.startsWith('add-hot-uncovered:'))!.recommendationDraft!;
  assert.equal(targetIsFile(d.target), false);
  assert.ok((d.target as { reason: string }).reason.length > 0, 'unresolved carries a reason');
});

check('no guidance-source inventory → unresolved with a disclosed reason; NO default target', () => {
  const res = run({ coverage: coverage([hotEntry()]), observedProviders: ['claude'] });
  const p = res.proposals.find((x) => x.id.startsWith('add-hot-uncovered:'))!;
  const d = p.recommendationDraft!;
  assert.equal(targetIsFile(d.target), false);
  assert.match((d.target as { reason: string }).reason, /no guidance-source inventory/);
  assert.equal(p.target.absPath, undefined, 'no fabricated file target on the proposal either');
});

check('a non-candidate heat row yields NO hot-uncovered proposal', () => {
  const res = run({ coverage: coverage([hotEntry({ hotUncoveredCandidate: false, coverageChecks: undefined })]) });
  assert.equal(res.proposals.some((x) => x.id.startsWith('add-hot-uncovered:')), false);
});

check('fileHeat passthrough carries hotUncoveredCandidate + bounded coverageChecks', () => {
  const res = run({ coverage: coverage([hotEntry()]) });
  const row = res.fileHeat.find((h) => h.pathHash === 'hash-app')!;
  assert.equal(row.hotUncoveredCandidate, true);
  assert.deepEqual(row.coverageChecks, hotEntry().coverageChecks);
});

// ── command_family → workspace-level draft only ───────────────────────────────

check('command_family cluster → draft with FORCED-unresolved target + command_family evidence', () => {
  const c: ImprovisationCandidate = {
    lane: 'supervisor', dimension: 'command_family', key: 'git status',
    count: 3, distinctStreams: 2, expectedSaving: 0,
  };
  const res = run({ clusters: [c] });
  const p = res.proposals.find((x) => x.id === 'add-cluster:supervisor:command_family:git status');
  assert.ok(p, 'the cluster ADD proposal exists');
  const d = p!.recommendationDraft;
  assert.ok(d, 'command_family cluster carries a draft');
  assert.equal(targetIsFile(d!.target), false, 'command_family evidence NEVER yields a file target');
  assert.match((d!.target as { reason: string }).reason, /workspace-level/);
  assert.deepEqual(d!.evidence.map((e) => e.kind), ['command_family']);
  assert.deepEqual(d!.evidence[0].rowIds, [p!.id], 'evidence cites the proposal surface row');
  assert.equal(findCausalToken(d!.claim), null);
  assert.equal(d!.humanReviewRequired, true);
});

check('hash-only cluster rollups carry NO draft (no joinable readable key)', () => {
  const c: ImprovisationCandidate = {
    lane: 'supervisor', dimension: 'input_shape_hash', key: 'rollup',
    count: 5, distinctStreams: 3, expectedSaving: 0,
    isRollup: true, rollupCount: 5, clusterDimension: 'input_shape_hash',
    memberRefs: ['m1'], totalOccurrences: 5,
  };
  const res = run({ clusters: [c] });
  const rollup = res.proposals.find((x) => x.id.startsWith('add-cluster-rollup:'));
  assert.ok(rollup);
  assert.equal(rollup!.recommendationDraft, undefined);
});

// ── meta join key ─────────────────────────────────────────────────────────────

check('meta.recommendationGenerationId present iff ≥1 draft exists (honest absence)', () => {
  const withDrafts = run({ coverage: coverage([hotEntry()]) });
  assert.ok(withDrafts.meta.recommendationGenerationId);
  const without = run({});
  assert.equal(without.meta.recommendationGenerationId, undefined);
});

check('byte-identical determinism: same inputs → deep-equal results incl. drafts', () => {
  const input = () => ({
    coverage: coverage([hotEntry()]),
    guidanceSources: [agentsMd],
    observedProviders: ['codex'],
  });
  assert.deepEqual(run(input()), run(input()));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
