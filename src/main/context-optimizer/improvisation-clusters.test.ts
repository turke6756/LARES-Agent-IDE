// Tests for improvisation-clusters.ts (WP5 uncovered-repeated-behaviour pass, §5.3).
// node:assert on dist. Run: node dist/main/main/context-optimizer/improvisation-clusters.test.js
import assert from 'node:assert';
import type { Cluster, Lane } from './behavior-store';
import type { PredictedAction } from './guidance-action-model';
import {
  coverageFromActions,
  findImprovisationClusters,
  type ImprovisationDeps,
} from './improvisation-clusters';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function pa(partial: Partial<PredictedAction>): PredictedAction {
  return {
    id: 'id', source: { absPath: '/ws/CLAUDE.md', line: 1 }, sourceKind: 'capability',
    lanes: ['worker'], kind: 'tool-invocation', params: {}, derivability: 'exact',
    residentTokens: 0, sourceSectionKey: '', sourceEpochId: '', requiresDerivationGate: true,
    ...partial,
  } as PredictedAction;
}

function cluster(p: Partial<Cluster> & Pick<Cluster, 'dimension' | 'key'>): Cluster {
  return { lane: 'worker', count: 5, distinctStreams: 3, ...p };
}

/** Fake store returning fixed clusters per lane, tracking the floors it was asked for. */
function store(byLane: Partial<Record<Lane, Cluster[]>>): {
  store: ImprovisationDeps['store'];
  lastOpts: { minCount: number; minStreams: number } | null;
} {
  const box: { lastOpts: { minCount: number; minStreams: number } | null } = { lastOpts: null };
  return {
    store: {
      improvisationClusters: (lane, opts) => { box.lastOpts = opts; return byLane[lane] ?? []; },
    },
    get lastOpts() { return box.lastOpts; },
  };
}

// ── 1. uncovered clusters surface as candidates ───────────────────────────────
check('uncovered clusters → candidates (default lanes)', () => {
  const s = store({ worker: [cluster({ dimension: 'command_family', key: 'jq' })] });
  const out = findImprovisationClusters({ store: s.store });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].key, 'jq');
  assert.strictEqual(out[0].lane, 'worker');
  assert.strictEqual(out[0].expectedSaving, 0); // estimator unwired → honest 0
});

// ── 2. coverage subtracts already-predicted command families / search hashes ──
check('coverageFromActions subtracts covered command-family + search-pattern', () => {
  const actions = [
    pa({ kind: 'command-family', params: { commandFamily: 'npm-run:build' } }),
    pa({ kind: 'search-pattern', params: { queryHash: 'sig-aaa' } }),
  ];
  const s = store({ worker: [
    cluster({ dimension: 'command_family', key: 'npm-run:build' }),  // covered → dropped
    cluster({ dimension: 'command_family', key: 'jq' }),             // uncovered → kept
    cluster({ dimension: 'search_signature_hash', key: 'sig-aaa' }), // covered → dropped
    cluster({ dimension: 'search_signature_hash', key: 'sig-bbb' }), // uncovered → kept
  ] });
  const out = findImprovisationClusters({ store: s.store, isCovered: coverageFromActions(actions) });
  // WP-B2: jq (command_family) stays individual; the one uncovered search hash (sig-bbb)
  // folds into a single rollup — covered sig-aaa is dropped BEFORE folding.
  const individual = out.filter((c) => !c.isRollup);
  assert.deepStrictEqual(individual.map((c) => c.key), ['jq']);
  const rollup = out.find((c) => c.isRollup && c.dimension === 'search_signature_hash');
  assert.ok(rollup, 'uncovered search hash folds into a rollup');
  assert.strictEqual(rollup?.rollupCount, 1); // only sig-bbb; sig-aaa was covered
});

// ── 3. input_shape_hash is never covered (no PredictedAction predicate) ───────
check('input_shape_hash never covered — folds into a rollup that surfaces', () => {
  // Even with a command-family action whose family collides with the shape key.
  const actions = [pa({ kind: 'command-family', params: { commandFamily: 'shape-x' } })];
  const s = store({ worker: [cluster({ dimension: 'input_shape_hash', key: 'shape-x' })] });
  const out = findImprovisationClusters({ store: s.store, isCovered: coverageFromActions(actions) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].dimension, 'input_shape_hash');
  assert.strictEqual(out[0].isRollup, true); // WP-B2: hash-only → rollup, not individual
  assert.strictEqual(out[0].rollupCount, 1);
});

// ── 4. floors default to OPTIMIZER_CONFIG (REPEAT_MIN / REPEAT_MIN_STREAMS) ────
check('default floors passed to store = OPTIMIZER_CONFIG', () => {
  const s = store({ worker: [] });
  findImprovisationClusters({ store: s.store });
  assert.deepStrictEqual(s.lastOpts, { minCount: 3, minStreams: 2 });
});
check('config override forwarded to store', () => {
  const s = store({ worker: [] });
  findImprovisationClusters({ store: s.store, config: { REPEAT_MIN: 9, REPEAT_MIN_STREAMS: 4 } });
  assert.deepStrictEqual(s.lastOpts, { minCount: 9, minStreams: 4 });
});

// ── 5. injected saving estimator is applied ───────────────────────────────────
check('estimateSaving seam is applied per cluster', () => {
  const s = store({ worker: [cluster({ dimension: 'command_family', key: 'jq', count: 7 })] });
  const out = findImprovisationClusters({ store: s.store, estimateSaving: (c) => c.count * 100 });
  assert.strictEqual(out[0].expectedSaving, 700);
});

// ── 6. lanes are scanned in order; custom lane set honoured ───────────────────
check('scans provided lanes in order', () => {
  const s = store({
    supervisor: [cluster({ lane: 'supervisor', dimension: 'command_family', key: 's' })],
    worker: [cluster({ lane: 'worker', dimension: 'command_family', key: 'w' })],
  });
  const out = findImprovisationClusters({ store: s.store, lanes: ['worker', 'supervisor'] });
  assert.deepStrictEqual(out.map((c) => c.key), ['w', 's']);
});

// ── WP-B2: hash-only clusters fold into per-(lane,dimension) rollups ───────────
// (a) M hash candidates across a lane collapse to exactly one rollup with rollupCount M.
check('WP-B2 (a) M hash candidates fold to one rollup with rollupCount M', () => {
  const s = store({ worker: [
    cluster({ dimension: 'input_shape_hash', key: 'h1' }),
    cluster({ dimension: 'input_shape_hash', key: 'h2' }),
    cluster({ dimension: 'input_shape_hash', key: 'h3' }),
  ] });
  const out = findImprovisationClusters({ store: s.store });
  const rollups = out.filter((c) => c.isRollup);
  assert.strictEqual(rollups.length, 1, 'exactly one rollup for the hash dimension');
  assert.strictEqual(rollups[0].rollupCount, 3, 'rollupCount = M folded clusters');
  assert.strictEqual(rollups[0].dimension, 'input_shape_hash');
  assert.strictEqual(rollups[0].clusterDimension, 'input_shape_hash');
});

// Two distinct hash dimensions in one lane fold into one rollup EACH (per dimension).
check('WP-B2 (a) two hash dimensions → one rollup per dimension', () => {
  const s = store({ worker: [
    cluster({ dimension: 'input_shape_hash', key: 'h1' }),
    cluster({ dimension: 'input_shape_hash', key: 'h2' }),
    cluster({ dimension: 'search_signature_hash', key: 's1' }),
  ] });
  const out = findImprovisationClusters({ store: s.store });
  const rollups = out.filter((c) => c.isRollup);
  assert.strictEqual(rollups.length, 2);
  const byDim = new Map(rollups.map((r) => [r.dimension, r.rollupCount]));
  assert.strictEqual(byDim.get('input_shape_hash'), 2);
  assert.strictEqual(byDim.get('search_signature_hash'), 1);
});

// (b) command_family rows stay individual, never folded.
check('WP-B2 (b) command_family rows stay individual (not folded)', () => {
  const s = store({ worker: [
    cluster({ dimension: 'command_family', key: 'jq' }),
    cluster({ dimension: 'command_family', key: 'rg' }),
    cluster({ dimension: 'input_shape_hash', key: 'h1' }),
  ] });
  const out = findImprovisationClusters({ store: s.store });
  const individual = out.filter((c) => !c.isRollup);
  assert.deepStrictEqual(individual.map((c) => c.key).sort(), ['jq', 'rg']);
  assert.strictEqual(out.filter((c) => c.isRollup).length, 1, 'only the hash cluster folds');
});

// (c) no fabricated exemplar — the rollup carries exemplar:null.
check('WP-B2 (c) rollup carries no fabricated exemplar (exemplar:null)', () => {
  const s = store({ worker: [cluster({ dimension: 'search_signature_hash', key: 'h1' })] });
  const out = findImprovisationClusters({ store: s.store });
  const rollup = out.find((c) => c.isRollup);
  assert.ok(rollup);
  assert.strictEqual(rollup?.exemplar, null);
});

// ── R2 WP-4B (Step 2): rollup carries capped opaque memberRefs + top-K summaries ──
// 25 folded hash members with strictly descending counts (h00=25 … h24=1) so the
// count-desc/key-asc order is unambiguous. Caps: REFS=20, TOP_K=5, total=Σ1..25=325.
function hashMembers(): Cluster[] {
  const out: Cluster[] = [];
  for (let i = 0; i < 25; i++) {
    const key = `h${String(i).padStart(2, '0')}`;
    out.push(cluster({ dimension: 'input_shape_hash', key, count: 25 - i, distinctStreams: (25 - i) % 4 }));
  }
  return out;
}

check('Step 2 — memberRefs capped at ROLLUP_MEMBER_REFS_CAP (20)', () => {
  const s = store({ worker: hashMembers() });
  const rollup = findImprovisationClusters({ store: s.store }).find((c) => c.isRollup);
  assert.ok(rollup);
  assert.strictEqual(rollup!.memberRefs?.length, 20, '25 members → capped to 20 refs');
  assert.strictEqual(rollup!.rollupCount, 25, 'all 25 still folded/counted');
});

check('Step 2 — memberRefs sorted count-desc (then key-asc)', () => {
  const s = store({ worker: hashMembers() });
  const rollup = findImprovisationClusters({ store: s.store }).find((c) => c.isRollup);
  // h00 (count 25) … h19 (count 6) — the first 20 by descending count.
  const expected = Array.from({ length: 20 }, (_, i) => `h${String(i).padStart(2, '0')}`);
  assert.deepStrictEqual(rollup!.memberRefs, expected);
});

check('Step 2 — topMembers = top-K (5) by count, carrying counts', () => {
  const s = store({ worker: hashMembers() });
  const rollup = findImprovisationClusters({ store: s.store }).find((c) => c.isRollup);
  assert.strictEqual(rollup!.topMembers?.length, 5, 'top-K = 5');
  assert.deepStrictEqual(rollup!.topMembers!.map((m) => m.ref), ['h00', 'h01', 'h02', 'h03', 'h04']);
  assert.deepStrictEqual(rollup!.topMembers!.map((m) => m.count), [25, 24, 23, 22, 21]);
});

check('Step 2 — totalOccurrences == summed folded occurrences (== count)', () => {
  const s = store({ worker: hashMembers() });
  const rollup = findImprovisationClusters({ store: s.store }).find((c) => c.isRollup);
  assert.strictEqual(rollup!.totalOccurrences, 325, 'Σ 1..25 = 325');
  assert.strictEqual(rollup!.count, 325, 'rollup count == totalOccurrences');
});

console.log(`\n${passed} passed`);
