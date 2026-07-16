// agent-dto-build page-builder tests (WP7 §7 tests 25–27, 31–32 at the page level).
//   npm run build:main
//   node dist/main/main/context-optimizer/agent-dto-build.test.js

import assert from 'node:assert/strict';
import type { ContextOptimizerProposal, ContextOptimizerResult, FileHeatRollupEntry, FileHeatScopeMeta } from '../../shared/types';
import { isProposalDefaultSurfaced } from '../../shared/context-optimizer-policy';
import type { AnalyzabilityDiagnostic } from '../../shared/types';
import { buildAnalyzabilityPage, buildClusterExemplars, buildFileHeatPage, buildProposalDetail, buildProposalEvidence, buildProposalsPage } from './agent-dto-build';
import type { ClusterExemplar } from './behavior-store';
import { AGENT_DTO_CAPS, AGENT_DTO_PARSER_VERSION, computeFiltersHash, computeGenerationId, encodeCursor } from './agent-dto';

let passed = 0;
function ok(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function prop(over: Partial<ContextOptimizerProposal> & { id: string; weight: number }): ContextOptimizerProposal {
  const { weight, id, ...rest } = over;
  return {
    id, kind: 'subtract-dead-guidance', lever: 'subtract', title: `t-${id}`,
    rationale: 'r', target: { lane: 'worker', mutable: 'user-owned' },
    residentTokenDelta: { estimate: 100, basis: 'remove-resident' },
    tokenTurnsWeight: weight, occurrence: 'never', evidenceState: 'unavailable', confidence: 'observed', epochConfidence: 'high',
    attribution: { lane: 'worker', streamIds: ['s'], sharedCwdRisk: 'none' },
    exposure: { turns: 10, streams: 2, slugs: 1 },
    citations: [{ source: 'staticOverheadModel' }],
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false, suppressedFromAgentSurface: false,
    ...rest,
  };
}

function makeResult(proposals: ContextOptimizerProposal[], fileHeat: FileHeatRollupEntry[] = []): ContextOptimizerResult {
  return {
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    proposals, fileHeat,
    modelStats: { residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [] },
    meta: { tierGroups: [], unverifiedSuppressedCount: proposals.filter((p) => p.suppressedFromAgentSurface).length },
  };
}

// ── Test 25/32: suppression hidden by default, disclosed in meta ─────────────────
ok('32 suppressed proposals hidden from list but counted in meta', () => {
  const res = makeResult([
    prop({ id: 'a', weight: 300 }),
    prop({ id: 'b', weight: 200, suppressedFromAgentSurface: true }),
    prop({ id: 'c', weight: 100 }),
  ]);
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.deepEqual(page.data.map((s) => s.id), ['a', 'c'], 'suppressed b hidden');
    assert.equal(page.meta.unverifiedSuppressedCount, 1, 'but disclosed in meta');
    assert.equal(page.meta.dataState, 'unverified');
  }
  const withUnverified = buildProposalsPage(res, { includeUnverified: true });
  assert.equal(withUnverified.ok && withUnverified.data.map((s) => s.id).join(','), 'a,b,c');
});

// ── BUG-43: DTO dedup belt ───────────────────────────────────────────────────────
ok('BUG-43 buildProposalsPage dedupes duplicate ids to one row + warns', () => {
  const res = makeResult([
    prop({ id: 'dup', weight: 300 }),
    prop({ id: 'dup', weight: 300 }),
    prop({ id: 'other', weight: 100 }),
  ]);
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (page.ok) {
    const ids = page.data.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids on the page');
    assert.equal(ids.filter((id) => id === 'dup').length, 1, 'the duplicate collapsed to one row');
    const warn = page.warnings.find((w) => w.code === 'DUPLICATE_PROPOSAL_IDS');
    assert.ok(warn, 'a DUPLICATE_PROPOSAL_IDS warning discloses the drop');
    assert.equal((warn?.details as { dropped?: number } | undefined)?.dropped, 1);
  }
});

ok('25 list carries lean summary only', () => {
  const page = buildProposalsPage(makeResult([prop({ id: 'a', weight: 1 })]), {});
  assert.equal(page.ok, true);
  if (page.ok) {
    const row = page.data[0] as unknown as Record<string, unknown>;
    assert.equal(row.citations, undefined);
    assert.equal(row.citationCount, 1);
    assert.equal(row.hasPatch, false);
  }
});

// ── Test 26: cursor stable within generation, stale across regen, invalid on filter ─
ok('26 cursor pages stably then reports hasMore=false', () => {
  const res = makeResult([300, 250, 200, 150, 100].map((w, i) => prop({ id: `p${i}`, weight: w })));
  const p1 = buildProposalsPage(res, { limit: 2 });
  assert.equal(p1.ok && p1.data.map((s) => s.id).join(','), 'p0,p1');
  assert.equal(p1.ok && p1.page?.hasMore, true);
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  const p2 = buildProposalsPage(res, { limit: 2, cursor: cur });
  assert.equal(p2.ok && p2.data.map((s) => s.id).join(','), 'p2,p3');
  const cur2 = (p2.ok && p2.page?.nextCursor) as string;
  const p3 = buildProposalsPage(res, { limit: 2, cursor: cur2 });
  assert.equal(p3.ok && p3.data.map((s) => s.id).join(','), 'p4');
  assert.equal(p3.ok && p3.page?.hasMore, false);
});

ok('26 CURSOR_STALE when the proposal set regenerates between pages', () => {
  const res = makeResult([300, 200, 100].map((w, i) => prop({ id: `p${i}`, weight: w })));
  const p1 = buildProposalsPage(res, { limit: 1 });
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  // Regenerate: add a proposal → new generationId.
  const res2 = makeResult([300, 250, 200, 100].map((w, i) => prop({ id: `q${i}`, weight: w })));
  const stale = buildProposalsPage(res2, { limit: 1, cursor: cur });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.error.code, 'CURSOR_STALE');
});

ok('26 CURSOR_INVALID when filters change under a replayed cursor', () => {
  const res = makeResult([300, 200, 100].map((w, i) => prop({ id: `p${i}`, weight: w })));
  const p1 = buildProposalsPage(res, { limit: 1 });
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  const invalid = buildProposalsPage(res, { limit: 1, cursor: cur, lane: 'supervisor' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok === false && invalid.error.code, 'CURSOR_INVALID');
});

// ── detail route ─────────────────────────────────────────────────────────────────
ok('25 detail returns full proposal; patch gated by includePatch', () => {
  const res = makeResult([prop({ id: 'a', weight: 1,
    citations: Array.from({ length: 9 }, () => ({ source: 'staticOverheadModel' as const })),
    proposedEdit: { summary: 'do it', patch: 'DIFF' },
    phraseGap: { terms: Array.from({ length: 20 }, (_, i) => ({ term: `t${i}`, bypassCount: 1, invocationCount: 0, gapBps: 1, liftBps: 1 })) },
  })]);
  const noPatch = buildProposalDetail(res, 'a');
  assert.equal(noPatch.ok, true);
  if (noPatch.ok) {
    assert.equal(noPatch.data.citations.length, 5, 'citations capped at 5');
    assert.equal(noPatch.data.phraseGap?.terms.length, 10, 'phrase terms capped at 10');
    assert.equal(noPatch.data.proposedEdit?.patch, undefined, 'patch omitted by default');
    assert.equal(noPatch.data.proposedEdit?.summary, 'do it');
  }
  const withPatch = buildProposalDetail(res, 'a', { includePatch: true });
  assert.equal(withPatch.ok && withPatch.data.proposedEdit?.patch, 'DIFF');
  const missing = buildProposalDetail(res, 'nope');
  assert.equal(missing.ok === false && missing.error.code, 'INVALID_ARGUMENT');
});

// ── Test 31: file-heat redaction + scope ─────────────────────────────────────────
const ROOTS = {
  workspaceRoot: 'C:/Users/turke/Projects/AgentDashboard',
  dashboardRoot: 'C:/Users/turke/Projects/AgentDashboard/.dashboard',
  homeDir: 'C:/Users/turke',
};
function heat(over: Partial<FileHeatRollupEntry> & { pathDisplay: string; pathHash: string }): FileHeatRollupEntry {
  return { lane: 'worker', coverage: 'covered', reads: 1, writes: 0, executes: 0, distinctStreams: 1, uncovered: false, ...over };
}

ok('31 file-heat rows are redacted (scope prefix, no username/drive)', () => {
  const res = makeResult([], [
    heat({ pathDisplay: 'c:/users/turke/projects/agentdashboard/src/main/index.ts', pathHash: 'h1', reads: 9 }),
    heat({ pathDisplay: 'd:/secret/passwords.txt', pathHash: 'h2', reads: 3 }),
    heat({ pathDisplay: 'c:/users/turke/.ssh/id_rsa', pathHash: 'h3', reads: 1 }),
  ]);
  const page = buildFileHeatPage(res, ROOTS, {});
  assert.equal(page.ok, true);
  if (page.ok) {
    // sorted by heat DESC: h1(9), h2(3), h3(1)
    assert.deepEqual(page.data.map((r) => r.pathDisplay), [
      '$WORKSPACE/src/main/index.ts', 'external/passwords.txt', '~/.ssh/id_rsa',
    ]);
    for (const r of page.data) {
      assert.ok(!/turke/i.test(r.pathDisplay));
      assert.ok(!/^[a-z]:/i.test(r.pathDisplay));
    }
    assert.equal(page.data[0].pathScope, 'workspace');
    assert.equal(page.data[1].pathScope, 'external');
  }
});

ok('31 file-heat paginates by heat with a stable cursor', () => {
  const res = makeResult([], [10, 8, 6, 4].map((n, i) => heat({ pathDisplay: `c:/users/turke/projects/agentdashboard/f${i}.ts`, pathHash: `h${i}`, reads: n })));
  const p1 = buildFileHeatPage(res, ROOTS, { limit: 2 });
  assert.equal(p1.ok && p1.data.length, 2);
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  const p2 = buildFileHeatPage(res, ROOTS, { limit: 2, cursor: cur });
  assert.equal(p2.ok && p2.data.map((r) => r.pathHash).join(','), 'h2,h3');
  assert.equal(p2.ok && p2.page?.hasMore, false);
});

// ── WP-B1: material subtract visibility + hasActionableContent sort/cursor ───────

/** A material supervisor subtract: concrete file target + positive cost, gate-suppressed. */
function materialSubtract(i: number, weight: number): ContextOptimizerProposal {
  return prop({
    id: `subtract-dead-guidance:supervisor:s${i}`, weight,
    kind: 'subtract-dead-guidance', lever: 'subtract',
    target: { absPath: `/ws/CLAUDE.md`, lineStart: 10 + i, lane: 'supervisor', mutable: 'scaffold-managed' },
    residentTokenDelta: { estimate: 1000, basis: 'remove-resident' },
    occurrence: 'never', actionability: 'candidate-unverified',
    suppressedFromAgentSurface: true,
  });
}

// A B1 fixture: 4 material supervisor subtracts (gate-suppressed but material) + a
// visible-but-non-actionable ADD + a still-hidden non-material suppressed subtract.
function b1Fixture(): ContextOptimizerResult {
  return makeResult([
    materialSubtract(0, 900),
    materialSubtract(1, 800),
    materialSubtract(2, 700),
    materialSubtract(3, 600),
    // Visible (not suppressed) but no concrete target → not actionable → ranks below.
    prop({ id: 'add-cluster:worker:command_family:git commit', weight: 5,
      kind: 'add-improvisation-support', lever: 'add', title: "Support a 'git commit' improvisation",
      occurrence: 'occurs', suppressedFromAgentSurface: false }),
    // Still hidden: suppressed AND non-material (no concrete target) — even at high weight.
    prop({ id: 'subtract-dead-guidance:worker:lane-only', weight: 1000,
      kind: 'subtract-dead-guidance', lever: 'subtract',
      target: { lane: 'worker', mutable: 'scaffold-managed' },
      suppressedFromAgentSurface: true }),
  ]);
}

ok('B1 (a) the 4 material subtracts land on page 1, hasActionableContent + candidate-unverified', () => {
  const page = buildProposalsPage(b1Fixture(), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const subs = page.data.filter((s) => s.id.startsWith('subtract-dead-guidance:supervisor:'));
  assert.equal(subs.length, 4, 'all 4 supervisor subtracts on page 1');
  for (const s of subs) {
    assert.equal(s.hasActionableContent, true, `${s.id} hasActionableContent`);
    assert.equal(s.actionability, 'candidate-unverified', `${s.id} caveated`);
  }
});

ok('B1 (b) no zero-weight / non-actionable row outranks the material subtracts', () => {
  const page = buildProposalsPage(b1Fixture(), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const ids = page.data.map((s) => s.id);
  // The 4 actionable subtracts come first (weight DESC), then the non-actionable add.
  assert.deepEqual(ids, [
    'subtract-dead-guidance:supervisor:s0',
    'subtract-dead-guidance:supervisor:s1',
    'subtract-dead-guidance:supervisor:s2',
    'subtract-dead-guidance:supervisor:s3',
    'add-cluster:worker:command_family:git commit',
  ]);
  // The still-hidden lane-only subtract (weight 1000) never appears despite its weight.
  assert.equal(ids.includes('subtract-dead-guidance:worker:lane-only'), false);
});

ok('B1 (c) unverifiedSuppressedCount excludes the now-visible material subtracts', () => {
  const page = buildProposalsPage(b1Fixture(), {});
  assert.equal(page.ok, true);
  // Only the still-hidden non-material suppressed subtract is counted (not the 4 material).
  assert.equal(page.ok && page.meta.unverifiedSuppressedCount, 1);
});

ok('B1 (c) includeUnverified:true still returns everything', () => {
  const all = buildProposalsPage(b1Fixture(), { includeUnverified: true });
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.data.length, 6, 'all 6 proposals returned under includeUnverified');
});

ok('B1 (d) 3-tuple cursor round-trip returns a correct, non-overlapping page 2', () => {
  const res = b1Fixture();
  const p1 = buildProposalsPage(res, { limit: 2 });
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  assert.deepEqual(p1.data.map((s) => s.id),
    ['subtract-dead-guidance:supervisor:s0', 'subtract-dead-guidance:supervisor:s1']);
  assert.equal(p1.page?.hasMore, true);
  const cur = p1.page?.nextCursor as string;
  const p2 = buildProposalsPage(res, { limit: 2, cursor: cur });
  assert.equal(p2.ok, true);
  if (!p2.ok) return;
  assert.deepEqual(p2.data.map((s) => s.id),
    ['subtract-dead-guidance:supervisor:s2', 'subtract-dead-guidance:supervisor:s3'], 'page 2 continues');
  // Non-overlapping across the two pages.
  const overlap = p1.data.map((s) => s.id).filter((id) => p2.data.some((s) => s.id === id));
  assert.equal(overlap.length, 0, 'no id appears on both pages');
  // Page 3 continues to the non-actionable add, then stops.
  const cur2 = p2.page?.nextCursor as string;
  const p3 = buildProposalsPage(res, { limit: 2, cursor: cur2 });
  assert.equal(p3.ok && p3.data.map((s) => s.id).join(','), 'add-cluster:worker:command_family:git commit');
  assert.equal(p3.ok && p3.page?.hasMore, false);
});

ok('B1 cursor contract: an old-format (prior PROPOSALS_SORT, 2-tuple) cursor is CURSOR_INVALID', () => {
  const res = b1Fixture();
  const generationId = computeGenerationId({
    proposalIds: [...new Map(res.proposals.map((p) => [p.id, p])).values()].map((p) => p.id),
    fileHeatHashes: res.fileHeat.map((f) => f.pathHash),
  });
  const filtersHash = computeFiltersHash({
    lane: null, kind: null, minTier: null, includeUnverified: false, levers: null,
  });
  // A cursor issued under the OLD sort string with the OLD 2-tuple lastSortKey.
  const stale = encodeCursor({
    v: 1, route: 'get_context_optimizer_proposals', filtersHash,
    sort: 'tokenTurnsWeight DESC, id ASC',
    lastSortKey: [900, 'subtract-dead-guidance:supervisor:s0'],
    generationId, issuedAtMs: 0,
  });
  const replayed = buildProposalsPage(res, { limit: 2, cursor: stale });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.ok === false && replayed.error.code, 'CURSOR_INVALID');
});

ok('B1 parity: the DTO default-visible set equals the shared-helper default-surfaced set', () => {
  const res = b1Fixture();
  const page = buildProposalsPage(res, { limit: 50 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  // The panel filters result.proposals by the SAME shared predicate — parity by construction.
  const panelSet = res.proposals.filter(isProposalDefaultSurfaced).map((p) => p.id).sort();
  const dtoSet = page.data.map((s) => s.id).sort();
  assert.deepEqual(dtoSet, panelSet, 'MCP default page == panel default-visible set');
});

// ── WP-B2: hash-only cluster rollups surface as ≤ 1 row per (lane, dimension) ────

/** A hash-only cluster rollup row (target.rollup present). Default-surfaced by policy
 *  because `proposalIsHashOnly` exempts a `target.rollup` row from hash-only noise. */
function rollupProp(id: string, weight: number, count: number,
  dimension: 'input_shape_hash' | 'search_signature_hash', lane: 'worker' | 'supervisor'): ContextOptimizerProposal {
  return prop({
    id, weight, kind: 'add-improvisation-support', lever: 'add',
    title: `${count} improvisation clusters, hash-only — drill for exemplars`,
    target: { lane, mutable: 'scaffold-managed', rollup: { count, dimension } },
    residentTokenDelta: { estimate: 0, basis: 'add-resident' },
    occurrence: 'occurs', suppressedFromAgentSurface: false,
  });
}

ok('B2 (a) a hash-only cluster surfaces as exactly one rollup row, default-visible', () => {
  const res = makeResult([
    materialSubtract(0, 900),
    rollupProp('add-cluster-rollup:worker:input_shape_hash', 3, 12, 'input_shape_hash', 'worker'),
  ]);
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const rollups = page.data.filter((s) => s.id.startsWith('add-cluster-rollup:'));
  assert.equal(rollups.length, 1, 'exactly one rollup row per hash cluster');
  // A target.rollup row is exempt from hash-only noise, so it is default-surfaced.
  assert.ok(res.proposals.filter(isProposalDefaultSurfaced).some((p) => p.id === rollups[0].id));
});

ok('B2 (b) page-1 default row count stays small (≤ ~20) with folded hash clusters', () => {
  // 40 + 15 raw hash clusters would flood page 1 pre-B2; folded upstream they are just
  // two rollup rows alongside a few material subtracts.
  const res = makeResult([
    materialSubtract(0, 900), materialSubtract(1, 800), materialSubtract(2, 700),
    rollupProp('add-cluster-rollup:worker:input_shape_hash', 2, 40, 'input_shape_hash', 'worker'),
    rollupProp('add-cluster-rollup:supervisor:search_signature_hash', 1, 15, 'search_signature_hash', 'supervisor'),
  ]);
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.ok(page.data.length <= 20, `page 1 has ${page.data.length} rows (≤ 20)`);
  const rollups = page.data.filter((s) => s.id.startsWith('add-cluster-rollup:'));
  assert.equal(rollups.length, 2, 'one rollup per (lane, hash dimension) — not one per cluster');
});

// ── WP-1C: honest metadata (insufficientExposureCount), analysisHealth, scopeMeta ──

/** A result carrying `notAnalyzable` entries: two insufficient-exposure + one unmatchable. */
function resultWithNotAnalyzable(proposals: ContextOptimizerProposal[]): ContextOptimizerResult {
  const base = makeResult(proposals);
  return {
    ...base,
    modelStats: {
      ...base.modelStats,
      behaviorEvents: 42,
      notAnalyzable: [
        { absPath: '/ws/a.md', line: 1, label: 'insufficient-exposure', lane: 'worker' },
        { absPath: '/ws/b.md', line: 2, label: 'insufficient-exposure', lane: 'supervisor' },
        { absPath: '/ws/c.md', line: 3, label: 'unmatchable', lane: 'worker' },
      ],
    },
  };
}

ok('1C insufficientExposureCount reflects the engine count, not a hard-coded 0', () => {
  const res = resultWithNotAnalyzable([prop({ id: 'a', weight: 100 })]);
  const list = buildProposalsPage(res, {});
  assert.equal(list.ok && list.meta.insufficientExposureCount, 2, 'list: 2 insufficient-exposure');
  const detail = buildProposalDetail(res, 'a');
  assert.equal(detail.ok && detail.meta.insufficientExposureCount, 2, 'detail: 2 insufficient-exposure');
  const heatPage = buildFileHeatPage(res, ROOTS, {});
  assert.equal(heatPage.ok && heatPage.meta.insufficientExposureCount, 2, 'heat: 2 insufficient-exposure');
  // Sanity: still 0 when there are none (no false positives).
  const none = buildProposalsPage(makeResult([prop({ id: 'a', weight: 1 })]), {});
  assert.equal(none.ok && none.meta.insufficientExposureCount, 0);
});

// ── R2 WP-4C: analyzability meta + capped detail route ──────────────────────────

/** A diagnostic fixture with a chosen trapped cost + lanes + reason codes. */
function diag(over: Partial<AnalyzabilityDiagnostic> & { sectionKey: string; absPath: string }): AnalyzabilityDiagnostic {
  const { absPath, sectionKey, ...rest } = over;
  return {
    sectionKey,
    source: { absPath, lineStart: 1, lineEnd: 1 },
    lanes: ['worker'],
    residentTokens: 100,
    exposureTurns: 10,
    actionCount: 1,
    reasons: [{ code: 'pure-prose', count: 1, suggestedDetector: 'imperative-prose-detector' }],
    ...rest,
  };
}

function resultWithAnalyzability(diags: AnalyzabilityDiagnostic[]): ContextOptimizerResult {
  const base = makeResult([]);
  return { ...base, modelStats: { ...base.modelStats, analyzability: diags } };
}

ok('4C analyzabilityCodeMeta: byReasonCode histogram + section/action counts on every surface', () => {
  const res = resultWithAnalyzability([
    diag({ sectionKey: 's1', absPath: 'C:/Users/turke/Projects/AgentDashboard/a.md',
      reasons: [{ code: 'pure-prose', count: 2 }, { code: 'exposure-low', count: 1 }], actionCount: 3 }),
    diag({ sectionKey: 's2', absPath: 'C:/Users/turke/Projects/AgentDashboard/b.md',
      reasons: [{ code: 'pure-prose', count: 1 }], actionCount: 1 }),
  ]);
  const page = buildProposalsPage(res, {});
  assert.ok(page.ok);
  if (!page.ok) return;
  assert.deepEqual(page.meta.notAnalyzableByReasonCode, { 'pure-prose': 3, 'exposure-low': 1 });
  assert.equal(page.meta.notAnalyzableSectionCount, 2, 'two distinct sections');
  assert.equal(page.meta.notAnalyzableActionCount, 4, 'four rejected actions across them');
});

ok('4C buildAnalyzabilityPage: sorted by residentTokens×exposureTurns DESC, redacted, capped', () => {
  const res = resultWithAnalyzability([
    diag({ sectionKey: 'lo', absPath: 'C:/Users/turke/Projects/AgentDashboard/lo.md', residentTokens: 10, exposureTurns: 2 }),   // 20
    diag({ sectionKey: 'hi', absPath: 'C:/Users/turke/Projects/AgentDashboard/hi.md', residentTokens: 500, exposureTurns: 8 }),  // 4000
    diag({ sectionKey: 'mid', absPath: 'C:/Users/turke/Projects/AgentDashboard/mid.md', residentTokens: 100, exposureTurns: 5 }), // 500
  ]);
  const page = buildAnalyzabilityPage(res, ROOTS, {});
  assert.ok(page.ok);
  if (!page.ok) return;
  assert.deepEqual(page.data.map((r) => r.trappedCostWeight), [4000, 500, 20], 'trapped-cost DESC');
  // Redaction: workspace-scoped display, never the raw drive/user path.
  for (const r of page.data) {
    assert.match(r.source.pathDisplay, /^\$WORKSPACE\//);
    assert.equal(r.source.absPath, undefined, 'no raw absPath on the agent surface');
    assert.equal(typeof r.sectionId, 'string');
  }
});

ok('4C buildAnalyzabilityPage: cap honored + cursor pages the remainder in order', () => {
  const diags = Array.from({ length: 5 }, (_, i) =>
    diag({ sectionKey: `s${i}`, absPath: `C:/Users/turke/Projects/AgentDashboard/s${i}.md`,
      residentTokens: (i + 1) * 100, exposureTurns: 1 }));   // weights 100..500
  const res = resultWithAnalyzability(diags);
  const p1 = buildAnalyzabilityPage(res, ROOTS, { limit: 2 });
  assert.ok(p1.ok);
  if (!p1.ok) return;
  assert.equal(p1.data.length, 2);
  assert.deepEqual(p1.data.map((r) => r.trappedCostWeight), [500, 400]);
  assert.ok(p1.page);
  assert.equal(p1.page.hasMore, true);
  assert.ok(p1.page.nextCursor);
  const p2 = buildAnalyzabilityPage(res, ROOTS, { limit: 2, cursor: p1.page.nextCursor });
  assert.ok(p2.ok);
  if (!p2.ok) return;
  assert.deepEqual(p2.data.map((r) => r.trappedCostWeight), [300, 200], 'cursor continues in order');
});

ok('4C buildAnalyzabilityPage: lane filter keeps only sections under that lane; empty when none', () => {
  const res = resultWithAnalyzability([
    diag({ sectionKey: 'sup', absPath: 'C:/Users/turke/Projects/AgentDashboard/sup.md', lanes: ['supervisor'] }),
    diag({ sectionKey: 'wrk', absPath: 'C:/Users/turke/Projects/AgentDashboard/wrk.md', lanes: ['worker'] }),
  ]);
  const only = buildAnalyzabilityPage(res, ROOTS, { lane: 'worker' });
  assert.ok(only.ok && only.data.length === 1 && only.data[0].lanes.includes('worker'));
  const none = buildAnalyzabilityPage(makeResult([]), ROOTS, {});
  assert.ok(none.ok && none.data.length === 0 && none.meta.dataState === 'empty');
});

ok('1C analysisHealth is present on page 1 + detail, absent on cursor-paged responses', () => {
  const res = resultWithNotAnalyzable([300, 200, 100].map((w, i) => prop({ id: `p${i}`, weight: w })));
  const p1 = buildProposalsPage(res, { limit: 2 });
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  assert.ok(p1.meta.analysisHealth, 'page 1 carries analysisHealth');
  const cur = p1.page?.nextCursor as string;
  const p2 = buildProposalsPage(res, { limit: 2, cursor: cur });
  assert.equal(p2.ok, true);
  if (!p2.ok) return;
  assert.equal(p2.meta.analysisHealth, undefined, 'paged (cursor) response omits analysisHealth to stay lean');
  const detail = buildProposalDetail(res, 'p0');
  assert.equal(detail.ok, true);
  if (detail.ok) assert.ok(detail.meta.analysisHealth, 'detail carries analysisHealth');
});

ok('1C analysisHealth is HONEST: unmeasurable components are null with a reason key, never fabricated', () => {
  const res = resultWithNotAnalyzable([prop({ id: 'a', weight: 100 })]); // no fileHeat
  const p1 = buildProposalsPage(res, {});
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  const h = p1.meta.analysisHealth!;
  // Two components have no honest denominator today → null + reason flag.
  assert.equal(h.workspaceCoveragePct, null);
  assert.equal(h.diagnostics.workspaceCoverageUnmeasured, 1);
  assert.equal(h.analyzableResidentTokenPct, null);
  assert.equal(h.diagnostics.analyzableResidentTokenUnmeasured, 1);
  // No fileHeat → captureCoveragePct also null with its reason.
  assert.equal(h.captureCoveragePct, null);
  assert.equal(h.diagnostics.captureCoverageUnmeasured, 1);
  // Honest raw counts ride in diagnostics.
  assert.equal(h.diagnostics.insufficientExposure, 2);
  assert.equal(h.diagnostics.notAnalyzable, 3);
  assert.equal(h.diagnostics.behaviorEvents, 42);
  // Versions are populated (identity contract), not empty.
  assert.equal(typeof h.policyVersion, 'string');
  assert.ok(h.policyVersion.length > 0);
  assert.equal(typeof h.matcherVersion, 'string');
  assert.ok(h.matcherVersion.length > 0);
});

ok('1C captureCoveragePct IS measured (and honest) when file-heat exists', () => {
  const res = makeResult([], [
    heat({ pathDisplay: 'c:/x/a.ts', pathHash: 'h1', uncovered: false }),
    heat({ pathDisplay: 'c:/x/b.ts', pathHash: 'h2', uncovered: false }),
    heat({ pathDisplay: 'c:/x/c.ts', pathHash: 'h3', uncovered: true }),
    heat({ pathDisplay: 'c:/x/d.ts', pathHash: 'h4', uncovered: true }),
  ]);
  const p1 = buildProposalsPage(res, {});
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  const h = p1.meta.analysisHealth!;
  assert.equal(h.captureCoveragePct, 50, '2 of 4 hot files covered → 50%');
  assert.equal(h.diagnostics.captureCoverageUnmeasured, undefined, 'no unmeasured flag when measured');
  assert.equal(h.diagnostics.fileHeatRows, 4);
  assert.equal(h.diagnostics.fileHeatUncovered, 2);
});

ok('1C scopeMeta discloses population before/after the query filter on the proposals list', () => {
  const res = makeResult([
    prop({ id: 'w1', weight: 300, target: { lane: 'worker', mutable: 'user-owned' } }),
    prop({ id: 'w2', weight: 200, target: { lane: 'worker', mutable: 'user-owned' } }),
    prop({ id: 's1', weight: 100, target: { lane: 'supervisor', mutable: 'user-owned' },
      attribution: { lane: 'supervisor', streamIds: ['s'], sharedCwdRisk: 'none' } }),
  ]);
  const all = buildProposalsPage(res, {});
  assert.equal(all.ok, true);
  if (all.ok) {
    assert.equal(all.meta.scopeMeta?.appliedLane, null);
    assert.equal(all.meta.scopeMeta?.populationBeforeScope, 3);
    assert.equal(all.meta.scopeMeta?.populationAfterScope, 3);
  }
  const scoped = buildProposalsPage(res, { lane: 'worker' });
  assert.equal(scoped.ok, true);
  if (scoped.ok) {
    assert.equal(scoped.meta.scopeMeta?.appliedLane, 'worker');
    assert.equal(scoped.meta.scopeMeta?.populationBeforeScope, 3, 'full generation before filter');
    assert.equal(scoped.meta.scopeMeta?.populationAfterScope, 2, 'only the 2 worker proposals after filter');
  }
});

ok('1C file-heat scopeMeta is honest that heat is lane-scoped, NOT workspace-scoped', () => {
  const res = makeResult([], [
    heat({ pathDisplay: 'c:/x/a.ts', pathHash: 'h1', lane: 'worker' }),
    heat({ pathDisplay: 'c:/x/b.ts', pathHash: 'h2', lane: 'supervisor' }),
  ]);
  const page = buildFileHeatPage(res, ROOTS, { lane: 'worker' });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.meta.scopeMeta?.workspaceScoped, false, 'heat corpus is lane-global today');
  assert.equal(page.meta.scopeMeta?.appliedLane, 'worker');
  assert.equal(page.meta.scopeMeta?.populationBeforeScope, 2);
  assert.equal(page.meta.scopeMeta?.populationAfterScope, 1);
});

// ── WP-1A (Priority 0): behaviorEvidence / evidenceState surfacing ─────────────

/** An evidence DTO with `n` denominator/numerator samples (identifiers only). */
function mkEvidenceDTO(n: number): NonNullable<ContextOptimizerProposal['behaviorEvidence']> {
  return {
    predicate: { kind: 'toolset-usage', toolset: 'orchestration' },
    matcherVersion: '7',
    normalizedMatcher: { kind: 'toolset-usage', toolset: 'orchestration' },
    epoch: { id: 'epoch-1', confidence: 'high' },
    denominator: {
      turns: 100, streams: n, slugs: 1,
      sampledStreams: Array.from({ length: n }, (_, i) => ({ streamId: `s${i}`, turns: 20, lane: 'worker' })),
    },
    numerator: {
      occurrences: 0, streams: 0,
      sampledEvents: Array.from({ length: n }, (_, i) => ({ streamId: `s${i}`, entryUuid: `u${i}`, blockIndex: i, byteOffset: i * 10 })),
    },
    captureCoverage: { providers: { orchestration: { streams: 3, pathEventsSupported: true } }, unknownToolEvents: 0, unresolvedPathEvents: 0 },
    exclusions: { subagents: false, reasons: [] },
  };
}

/** A `never` subtract carrying an auditable non-occurrence audit trail. */
function auditableProp(id: string, weight: number, samples = 2): ContextOptimizerProposal {
  return prop({
    id, weight, occurrence: 'never', evidenceState: 'auditable', evidenceRef: id,
    behaviorEvidence: mkEvidenceDTO(samples),
  });
}

ok('WP-1A summary carries evidenceState + evidenceRef', () => {
  const page = buildProposalsPage(makeResult([auditableProp('e1', 100)]), {});
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.data[0].evidenceState, 'auditable');
    assert.equal(page.data[0].evidenceRef, 'e1');
    // Lean row must NOT embed the full evidence object.
    assert.equal((page.data[0] as unknown as Record<string, unknown>).behaviorEvidence, undefined);
  }
});

ok('WP-1A detail caps behaviorEvidence sample arrays at evidenceSamplesMax', () => {
  const cap = AGENT_DTO_CAPS.context_optimizer_proposals.evidenceSamplesMax; // 10
  const res = makeResult([auditableProp('big', 100, cap + 5)]);
  const detail = buildProposalDetail(res, 'big');
  assert.equal(detail.ok, true);
  if (detail.ok) {
    assert.equal(detail.data.behaviorEvidence?.denominator.sampledStreams.length, cap);
    assert.equal(detail.data.behaviorEvidence?.numerator.sampledEvents.length, cap);
    assert.equal(detail.meta.parserVersion, AGENT_DTO_PARSER_VERSION); // v2 bump
    assert.equal(AGENT_DTO_PARSER_VERSION, 2);
  }
});

ok('WP-1A buildProposalEvidence returns the capped evidence for a valid id', () => {
  const cap = AGENT_DTO_CAPS.context_optimizer_proposals.evidenceSamplesMax;
  const res = makeResult([auditableProp('e1', 100, cap + 3)]);
  const ev = buildProposalEvidence(res, 'e1');
  assert.equal(ev.ok, true);
  if (ev.ok) {
    assert.equal(ev.data.denominator.sampledStreams.length, cap, 'capped');
    assert.equal(ev.data.predicate.kind, 'toolset-usage');
    assert.equal(ev.meta.parserVersion, AGENT_DTO_PARSER_VERSION);
    // No raw path text anywhere in the payload — identifiers + counts only.
    const payload = JSON.stringify(ev.data);
    assert.ok(!/[a-z]:[\\/]/i.test(payload), 'no drive-letter paths');
    assert.ok(!payload.includes('\\'), 'no backslash path separators');
    assert.ok(!/\.(ts|md|py|js)\b/.test(payload), 'no file-name text');
  }
});

ok('WP-1A buildProposalEvidence → INVALID_ARGUMENT for a missing id or an unavailable proposal', () => {
  const res = makeResult([
    auditableProp('has-ev', 100),
    prop({ id: 'no-ev', weight: 50 }), // default fixture → evidenceState unavailable, no behaviorEvidence
  ]);
  const missing = buildProposalEvidence(res, 'nope');
  assert.equal(missing.ok === false && missing.error.code, 'INVALID_ARGUMENT');
  const unavailable = buildProposalEvidence(res, 'no-ev');
  assert.equal(unavailable.ok === false && unavailable.error.code, 'INVALID_ARGUMENT');
});

// ── WP-2A: grant-mismatch diagnostic projection onto list + detail meta ─────────

ok('WP-2A list meta carries diagnosticCounts histogram + capped grantMismatchEvaluations', () => {
  const res: ContextOptimizerResult = {
    ...makeResult([prop({ id: 'drift:x', weight: 300, kind: 'subtract-grant-mismatch' })]),
    diagnostics: [
      { kind: 'grant-mismatch-evaluation', lane: 'supervisor', detail: 'emitted', grantMismatchVerdict: 'emitted', toolset: 'teams', resolvedToolset: 'teams', tokenEstimate: 300, relatedProposalId: 'drift:x' },
      { kind: 'grant-mismatch-evaluation', lane: 'worker', detail: 'suppressed', grantMismatchVerdict: 'section-not-resident', toolset: 'notebooks', tokenEstimate: 0, relatedProposalId: 'drift:y' },
      { kind: 'grant-mismatch-evaluation', lane: 'worker', detail: 'ambiguous', grantMismatchVerdict: 'ambiguous-toolset', toolset: 'create_team', mentionedToolName: 'create_team', candidateToolsets: ['teams', 'orchestration'], relatedProposalId: 'drift:z' },
      { kind: 'grant-mismatch-contradiction', lane: 'supervisor', detail: 'contra', relatedProposalId: 'drift:x', capabilityFamily: 'plans-read', counterEvidenceCalls: 5 },
    ],
  };
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const counts = page.meta.diagnosticCounts!;
  assert.ok(counts, 'diagnosticCounts present on page 1');
  assert.equal(counts['grant-mismatch-evaluation'], 3);
  assert.equal(counts['grant-mismatch-contradiction'], 1);
  assert.equal(counts['evaluation:emitted'], 1);
  assert.equal(counts['evaluation:section-not-resident'], 1);
  assert.equal(counts['evaluation:ambiguous-toolset'], 1);
  const evals = page.meta.grantMismatchEvaluations!;
  assert.equal(evals.length, 3, 'all three evaluation summaries (< cap)');
  const emitted = evals.find((e) => e.verdict === 'emitted')!;
  assert.equal(emitted.resolvedToolset, 'teams');
  assert.equal(emitted.tokenEstimate, 300);
  const amb = evals.find((e) => e.verdict === 'ambiguous-toolset')!;
  assert.deepEqual(amb.candidateToolsets, ['teams', 'orchestration']);
  assert.equal(amb.mentionedToolName, 'create_team');
});

ok('WP-2A "0 candidates" ⇒ no diagnostic meta fields (lean); page-2 cursor omits them too', () => {
  const clean = buildProposalsPage(makeResult([prop({ id: 'a', weight: 1 })]), {});
  assert.equal(clean.ok, true);
  if (clean.ok) {
    assert.equal(clean.meta.diagnosticCounts, undefined, '0 diagnostics ⇒ no histogram (distinguishes from "N suppressed")');
    assert.equal(clean.meta.grantMismatchEvaluations, undefined);
  }
});

ok('WP-2A detail meta scopes diagnosticCounts + evaluations to the proposal relatedProposalId', () => {
  const res: ContextOptimizerResult = {
    ...makeResult([prop({ id: 'drift:x', weight: 300, kind: 'subtract-grant-mismatch' })]),
    diagnostics: [
      { kind: 'grant-mismatch-evaluation', lane: 'supervisor', detail: 'mine', grantMismatchVerdict: 'emitted', toolset: 'teams', relatedProposalId: 'drift:x' },
      { kind: 'grant-mismatch-evaluation', lane: 'worker', detail: 'other', grantMismatchVerdict: 'ambiguous-toolset', toolset: 'x', relatedProposalId: 'drift:OTHER' },
    ],
  };
  const detail = buildProposalDetail(res, 'drift:x');
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.meta.diagnosticCounts!['grant-mismatch-evaluation'], 1, 'scoped to this proposal only');
  assert.equal(detail.meta.grantMismatchEvaluations!.length, 1);
  assert.equal(detail.meta.grantMismatchEvaluations![0].detail, 'mine');
});

// ── R2 WP-4B (Step 3): buildClusterExemplars drill + diagnostic split ────────────

/** A drillable hash-only cluster ROLLUP proposal fixture (the drill target). */
function drillRollupProp(over: Partial<ContextOptimizerProposal> = {}): ContextOptimizerProposal {
  return prop({
    id: 'add-cluster-rollup:worker:input_shape_hash',
    weight: 0,
    kind: 'add-improvisation-support',
    lever: 'add',
    occurrence: 'occurs',
    confidence: 'inferred',
    clusterExemplarRef: 'add-cluster-rollup:worker:input_shape_hash',
    target: {
      lane: 'worker', mutable: 'scaffold-managed',
      rollup: { count: 3, dimension: 'input_shape_hash', memberRefs: ['h1', 'h2'],
                topMembers: [{ ref: 'h1', count: 5, distinctStreams: 3 }],
                totalOccurrences: 9, distinctStreams: 4, hasDrillableMembers: true },
    },
    ...over,
  });
}

const EXEMPLARS: ClusterExemplar[] = [
  { ref: 'h1', toolShortName: 'read_agent_chat', inputKeys: ['agentId', 'limit'], count: 5, distinctStreams: 3, eventRefs: [] },
  { ref: 'h2', toolShortName: 'read_agent_log', inputKeys: ['agentId'], count: 4, distinctStreams: 2, eventRefs: [] },
];

ok('WP-4B buildClusterExemplars: a drillable rollup → ok with dimension/rollup/exemplars + threaded nextCursor', () => {
  const res = makeResult([drillRollupProp()]);
  const calls: Array<{ lane: string; dimension: string; cursor?: string; limit?: number }> = [];
  const store = {
    clusterExemplars(lane: string, dimension: string, opts: { cursor?: string; limit?: number }) {
      calls.push({ lane, dimension, ...opts });
      return { exemplars: EXEMPLARS, nextCursor: 'c' };
    },
  };
  const out = buildClusterExemplars(res, store as never, 'add-cluster-rollup:worker:input_shape_hash', { cursor: 'c0', limit: 5 });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.dimension, 'input_shape_hash');
  assert.equal(out.data.lane, 'worker');
  assert.equal(out.data.rollup.count, 3);
  assert.equal(out.data.rollup.totalOccurrences, 9);
  assert.equal(out.data.rollup.distinctStreams, 4);
  assert.deepEqual(out.data.exemplars, EXEMPLARS);
  assert.equal(out.page?.hasMore, true, 'nextCursor ⇒ hasMore');
  assert.equal(out.page?.nextCursor, 'c');
  assert.equal(out.page?.returned, 2);
  // the drill ran off the rollup's lane + dimension, with the request cursor/limit threaded.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { lane: 'worker', dimension: 'input_shape_hash', cursor: 'c0', limit: 5 });
  // structural exemplars only — never a raw prompt/value.
  const payload = JSON.stringify(out.data);
  assert.ok(!/[a-z]:[\\/]/i.test(payload), 'no drive-letter paths');
});

ok('WP-4B buildClusterExemplars: unknown id → INVALID_ARGUMENT', () => {
  const res = makeResult([drillRollupProp()]);
  const store = { clusterExemplars: () => ({ exemplars: [] as ClusterExemplar[] }) };
  const out = buildClusterExemplars(res, store as never, 'nope', {});
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error.code, 'INVALID_ARGUMENT');
});

ok('WP-4B buildClusterExemplars: a non-rollup OR non-drillable id → INVALID_ARGUMENT (not a drillable cluster rollup)', () => {
  const nonRollup = prop({ id: 'plain', weight: 100 });             // no target.rollup at all
  const notDrillable = drillRollupProp({
    id: 'add-cluster-rollup:worker:not-drillable',
    target: { lane: 'worker', mutable: 'scaffold-managed',
      rollup: { count: 3, dimension: 'input_shape_hash', memberRefs: [], topMembers: [],
                totalOccurrences: 9, distinctStreams: 4, hasDrillableMembers: false } },
  });
  const res = makeResult([nonRollup, notDrillable]);
  const store = { clusterExemplars: () => ({ exemplars: [] as ClusterExemplar[] }) };

  const a = buildClusterExemplars(res, store as never, 'plain', {});
  assert.equal(a.ok === false && a.error.code, 'INVALID_ARGUMENT');
  assert.match(a.ok === false ? a.error.message : '', /not a drillable cluster rollup/);

  const b = buildClusterExemplars(res, store as never, 'add-cluster-rollup:worker:not-drillable', {});
  assert.equal(b.ok === false && b.error.code, 'INVALID_ARGUMENT');
  assert.match(b.ok === false ? b.error.message : '', /not a drillable cluster rollup/);
});

ok('WP-4B diagnostic split: a config-completeness diagnostic is counted in page-1 meta.diagnosticCounts', () => {
  const res: ContextOptimizerResult = {
    ...makeResult([prop({ id: 'a', weight: 100 })]),
    diagnostics: [
      { kind: 'config-completeness', lane: 'supervisor', detail: '2 undocumented, no behavioral need',
        undocumentedCount: 2, undocumentedToolsets: [{ toolset: 'foo', detail: 'x' }, { toolset: 'bar', detail: 'y' }] },
    ],
  };
  const page = buildProposalsPage(res, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.meta.diagnosticCounts!['config-completeness'], 1,
    'config-completeness surfaced in the histogram, separate from proposal rows');
});

// ── WP-4A (Phase 4): file-heat role/score projection, view split, scope disclosure ─

/** A result whose file-heat carries an honest workspace-scope disclosure (as the
 *  scoped query layer now produces). Test 475 above keeps the no-scope path honest
 *  (workspaceScoped:false); this exercises the scoped-true path. */
function makeScopedResult(
  fileHeat: FileHeatRollupEntry[],
  scope: Partial<FileHeatScopeMeta> = {},
): ContextOptimizerResult {
  const base = makeResult([], fileHeat);
  return {
    ...base,
    meta: {
      ...base.meta,
      fileHeatScope: {
        workspaceScoped: true,
        appliedScopeMode: 'strict',
        workspaceKeyIsSlugProxy: false,
        droppedUnattributedTouches: 2,
        proxyIncludedTouches: 0,
        workspaceAttribution: {
          'workspace-explicit': 0,
          'workspace-from-launch-session': 0,
          'workspace-from-root': 3,
          'workspace-slug-proxy': 0,
          'workspace-unattributed': 2,
        },
        ...scope,
      },
    },
  };
}

ok('WP-4A file-heat rows project role/roleReason/score/scoreComponents/gap/noise', () => {
  const res = makeResult([], [
    heat({
      pathDisplay: 'c:/x/a.ts', pathHash: 'h1', reads: 3, distinctStreams: 2, uncovered: true,
      role: 'guidance-or-config', roleReason: 'a .md guidance/config file',
      score: 3, scoreComponents: { reads: 3, writes: 0, executes: 0, distinctStreams: 2 },
      guidanceGapCandidate: true, operationalNoise: false,
    }),
  ]);
  const page = buildFileHeatPage(res, ROOTS, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const row = page.data[0];
  assert.equal(row.role, 'guidance-or-config');
  assert.equal(row.roleReason, 'a .md guidance/config file');
  assert.equal(row.score, 3);
  assert.deepEqual(row.scoreComponents, { reads: 3, writes: 0, executes: 0, distinctStreams: 2 });
  assert.equal(row.guidanceGapCandidate, true);
  assert.equal(row.operationalNoise, false);
});

ok('WP-4A view=guidance-gaps returns only guidance-gap candidates + counts them in meta', () => {
  const res = makeResult([], [
    heat({ pathDisplay: 'c:/x/gap.md', pathHash: 'g1', reads: 4, uncovered: true,
      role: 'guidance-or-config', score: 4, guidanceGapCandidate: true }),
    heat({ pathDisplay: 'c:/x/src.ts', pathHash: 's1', reads: 9,
      role: 'product-source', score: 9, guidanceGapCandidate: false }),
  ]);
  const hot = buildFileHeatPage(res, ROOTS, {});
  assert.equal(hot.ok && hot.data.length, 2, 'hot view shows both');
  const gaps = buildFileHeatPage(res, ROOTS, { view: 'guidance-gaps' });
  assert.equal(gaps.ok, true);
  if (!gaps.ok) return;
  assert.equal(gaps.data.length, 1, 'guidance-gaps view keeps only the candidate');
  assert.equal(gaps.data[0].pathHash, 'g1');
  assert.equal(gaps.meta.fileHeatView?.view, 'guidance-gaps');
  assert.equal(gaps.meta.fileHeatView?.guidanceGapCandidates, 1, 'candidate count disclosed regardless of view');
});

ok('WP-4A hot view hides operational-noise rows + warns; includeOperationalNoise reveals them', () => {
  const res = makeResult([], [
    heat({ pathDisplay: 'c:/x/keep.ts', pathHash: 'k1', reads: 5, role: 'product-source', score: 5, operationalNoise: false }),
    heat({ pathDisplay: 'c:/x/dist.js', pathHash: 'd1', reads: 9, role: 'build-generated', score: 9, operationalNoise: true }),
  ]);
  const hot = buildFileHeatPage(res, ROOTS, {});
  assert.equal(hot.ok, true);
  if (!hot.ok) return;
  assert.deepEqual(hot.data.map((r) => r.pathHash), ['k1'], 'noise row hidden from the default hot view');
  assert.equal(hot.meta.fileHeatView?.operationalNoiseExcluded, 1);
  const warn = hot.warnings.find((w) => w.code === 'OPERATIONAL_NOISE_EXCLUDED');
  assert.ok(warn, 'exclusion disclosed as a warning (never silently dropped)');
  assert.equal((warn?.details as { excluded?: number } | undefined)?.excluded, 1);
  const withNoise = buildFileHeatPage(res, ROOTS, { includeOperationalNoise: true });
  assert.equal(withNoise.ok, true);
  if (!withNoise.ok) return;
  assert.equal(withNoise.data.length, 2, 'noise row included on opt-in');
  assert.equal(withNoise.meta.fileHeatView?.operationalNoiseExcluded, 0);
  assert.equal(withNoise.warnings.find((w) => w.code === 'OPERATIONAL_NOISE_EXCLUDED'), undefined, 'no warning when nothing excluded');
});

ok('WP-4A scopeMeta.workspaceScoped + meta.fileHeatScope reflect the scoped-query disclosure', () => {
  const res = makeScopedResult([
    heat({ pathDisplay: 'c:/x/a.ts', pathHash: 'h1', reads: 3, role: 'product-source', score: 3 }),
  ]);
  const page = buildFileHeatPage(res, ROOTS, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.meta.scopeMeta?.workspaceScoped, true, 'honest workspace-scoped flag (no longer a hardcoded false)');
  assert.equal(page.meta.fileHeatScope?.appliedScopeMode, 'strict');
  assert.equal(page.meta.fileHeatScope?.droppedUnattributedTouches, 2, 'dropped-row disclosure rides meta');
  assert.equal(page.meta.scopeMeta?.populationBeforeScope, 1);
  assert.equal(page.meta.scopeMeta?.populationAfterScope, 1);
  assert.equal(page.meta.fileHeatView?.view, 'hot', 'default view is hot');
});

console.log(`\nagent-dto-build.test.ts: ${passed} assertions passed`);
