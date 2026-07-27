// WP8 (G8) — surface provenance + comparability keys.
//   npm run build:main
//   node dist/main/main/analytics-export/surface-provenance.test.js
//
// Plan §WP8 tests: provenance presence per surface; anchor-stability (every
// builder receives the identical anchor); downgrade tests (identical keys →
// advisory, same dates / different population → blocking); --window applied
// against the anchor with true-window honesty for surfaces that cannot honor
// it; the 'surface-provenance' capability; WP3 evidence comparabilityKey stamp;
// snapshotId clock-independence; golden snapshot refresh.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import type {
  AgentContextOverhead, AgentKnowledgeGraph, ContextOptimizerProposal,
  ContextOptimizerResult, McpToolUsageResult, OverheadModel,
  SkillUsageResult, TokenEstimate, Workspace,
} from '../../shared/types';
import {
  captureAnalyticsSnapshot, writeAnalyticsSnapshot, readSnapshotFrom,
  buildSurfaceProvenances, stampRecommendationEvidenceComparability,
  snapshotCapabilities,
  type ExporterDeps,
} from './analytics-exporter';
import {
  ALL_RECORDED_HISTORY_START, SURFACE_KEYS, buildSurfaceProvenance,
  computeComparabilityKey,
  type AnalyticsSnapshotV2, type SurfaceKey, type SurfaceProvenanceV1,
} from './analytics-types';
import {
  buildCaveats, comparabilityKeysIdentical, ALWAYS_BLOCKING_CAVEAT_IDS,
  type CaveatConditions,
} from './analytics-caveats';
import { renderSummaryMarkdown } from './analytics-render';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── capture fixtures (trimmed from analytics-exporter.test.ts) ────────────────

const WS_ROOT = 'C:\\Users\\zqfixtureuser\\Projects\\Demo';
const WORKSPACE: Workspace = {
  id: 'ws-1', title: 'Demo', path: WS_ROOT, pathType: 'windows',
  description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
};

function est(tokens: number): TokenEstimate {
  return { tokens, bytes: tokens * 4, chars: tokens * 4, method: 'tiktoken-approx', approximate: true };
}

function overheadAgent(id: string): AgentContextOverhead {
  return {
    id, name: `agent-${id}`, kind: 'builtin-worker', lane: 'worker',
    workingDir: `${WS_ROOT}\\.dashboard\\workers\\claude`, pathType: 'windows',
    sidecarPath: undefined, inheritanceChain: [], mcpServers: [], flatSources: [],
    total: est(1000), totalHeaderView: est(800), residentTotal: est(700), onDemandTotal: est(300),
    exactness: 'estimated', warnings: [],
  } as AgentContextOverhead;
}

function overheadModel(): OverheadModel {
  return {
    workspaceId: 'ws-1', workspaceRoot: WS_ROOT, pathType: 'windows',
    generatedAt: '2026-07-19T18:44:55.123Z', estimatorMethod: 'tiktoken-approx',
    systemBaseline: undefined, agents: [overheadAgent('a1')], globalWarnings: [],
  } as OverheadModel;
}

function proposal(id: string): ContextOptimizerProposal {
  return {
    id, kind: 'add-missing-guidance', lever: 'add', title: `t-${id}`,
    rationale: 'r',
    target: { absPath: `${WS_ROOT}\\CLAUDE.md`, lineStart: 10, lineEnd: 12, lane: 'worker', mutable: 'user-owned' },
    attribution: { lane: 'worker', streamIds: ['s'], slug: 'slug', sharedCwdRisk: 'none' },
    exposure: { turns: 10, streams: 4, slugs: 3 },
    residentTokenDelta: { estimate: 100, basis: 'add-resident' },
    tokenTurnsWeight: 100, occurrence: 'observed', confidence: 'inferred', epochConfidence: 'high',
    citations: [{ source: 'staticOverheadModel' }],
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false, suppressedFromAgentSurface: false,
    // WP3 draft — same-surface (optimizer) evidence only; WP8 stamps the key.
    recommendationDraft: {
      target: { unresolved: true, reason: 'test' },
      claim: 'A file was touched.',
      evidence: [{ kind: 'file-heat', rowIds: ['row-1'], generationId: 'gen-1' }],
      humanReviewRequired: true,
    },
  } as unknown as ContextOptimizerProposal;
}

function optimizerResult(): ContextOptimizerResult {
  return {
    generatedAtIso: '2026-07-19T18:44:55.123Z',
    proposals: [proposal('p1')],
    fileHeat: [],
    modelStats: { residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [] },
    meta: { tierGroups: [], unverifiedSuppressedCount: 0 },
  } as unknown as ContextOptimizerResult;
}

/** Echoes the applied window into scopeMeta, exactly like the production query. */
function skillResult(q?: { sinceMs?: number; untilMs?: number }): SkillUsageResult {
  return {
    mostUsed: [{ skill: 'alpha', count: 5, avgEffectiveness: 0.8, lastUsedMs: 100 }],
    timeline: [], timelineTruncated: false,
    byWorkspace: [], byAgentType: [], byAgentDir: [], byInvoker: [],
    contextSamples: [], effectiveness: [], cost: [], totalInvocations: 5,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true,
      windowSinceMs: q?.sinceMs ?? null, windowUntilMs: q?.untilMs ?? null,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: 'ws-1', droppedUnattributedCount: 0, hasAnyInvocations: true,
    },
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as unknown as SkillUsageResult;
}

function mcpResult(q?: { sinceMs?: number; untilMs?: number }): McpToolUsageResult {
  return {
    byTool: [{
      toolName: 'mcp__agent-dashboard__read_agent_chat', toolShort: 'read_agent_chat',
      toolset: 'observability', count: 471, distinctStreams: 5, lastTsMs: 10,
    }],
    byToolset: [], byAgent: [], bySession: [], byWorkspace: [], byLane: [], byToolLane: [],
    tierBreakdown: {
      'agent-attributed': 471, 'lane-attributed-explicit': 0,
      'lane-inferred-from-current-grant': 0, unattributed: 0,
    },
    attributedCount: 471, unattributedCount: 0, attributionCoveragePct: 100,
    timeline: [], timelineTruncated: false, totalCalls: 471, attributedCalls: 471,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, attributionIsSessionBased: true,
      droppedUnattributedCalls: 0, appliedLane: null, appliedSlug: null,
      appliedAgentId: null, windowSinceMs: q?.sinceMs ?? null, windowUntilMs: q?.untilMs ?? null,
    },
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as unknown as McpToolUsageResult;
}

function knowledgeGraph(agentId: string): AgentKnowledgeGraph {
  return {
    agentId, agentName: `agent-${agentId}`, nodes: [], sourceFiles: [],
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as unknown as AgentKnowledgeGraph;
}

function fakeDb(): unknown {
  return {
    prepare() {
      return {
        get: () => undefined, all: () => [],
        run: () => { throw new Error('attempt to write a readonly database'); },
      };
    },
  };
}

interface QuerySpy {
  skillQueries: Array<Record<string, unknown>>;
  mcpQueries: Array<Record<string, unknown>>;
}

function makeDeps(over: Partial<ExporterDeps> = {}): { deps: Partial<ExporterDeps>; spy: QuerySpy } {
  const spy: QuerySpy = { skillQueries: [], mcpQueries: [] };
  const model = overheadModel();
  const deps: Partial<ExporterDeps> = {
    getDb: () => fakeDb(),
    getWorkspaces: () => [WORKSPACE],
    getPlans: () => [],
    runOverheadScan: () => model,
    runLiveOptimizerAnalyze: () => optimizerResult(),
    runKnowledgeExtract: (_ws, agentId) => knowledgeGraph(agentId),
    // Echo the applied window like the production queries do (queries.ts:158,
    // mcp-tool-usage-queries) — the exporter reads it back off scopeMeta.
    querySkillUsage: ((_db: unknown, q: { sinceMs?: number; untilMs?: number }) => {
      spy.skillQueries.push({ ...q }); return skillResult(q);
    }) as unknown as ExporterDeps['querySkillUsage'],
    queryMcpToolUsage: ((_db: unknown, q: { sinceMs?: number; untilMs?: number }) => {
      spy.mcpQueries.push({ ...q }); return mcpResult(q);
    }) as unknown as ExporterDeps['queryMcpToolUsage'],
    resolvePlanProjection: (async () => null) as unknown as ExporterDeps['resolvePlanProjection'],
    buildPlanActivityProjection: (() => ({})) as unknown as ExporterDeps['buildPlanActivityProjection'],
    isEpochsBackfilled: () => true,
    skillIndexComplete: () => true,
    gitInfo: async () => ({ sha: 'abc123', branch: 'master', dirty: false }),
    appVersion: () => '0.0.0-test',
    repoDir: () => WS_ROOT,
    closeDatabase: () => {},
    ...over,
  };
  return { deps, spy };
}

const ANCHOR = '2026-07-19T18:44:55.123Z';
const BASE_OPTS = {
  workspace: 'ws-1', keep: 10, prune: false, allowCold: false,
  now: () => new Date(ANCHOR),
};

function baseConditions(over: Partial<CaveatConditions> = {}): CaveatConditions {
  return {
    epochsBackfilled: true, skillIndexComplete: true,
    estimatorMethod: 'tiktoken-approx', gitShaAvailable: true,
    clusterRollupProposalIds: [], unverifiedProposalIds: [],
    foreignStreamIdsDropped: 0, agentsMdSourcesWithoutCompleteCoverage: 0,
    ...over,
  };
}

// ── step 1: provenance presence + anchor stability ────────────────────────────

test('every surface exports full provenance; every builder received the IDENTICAL anchor', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });

  for (const k of SURFACE_KEYS) {
    const p = snap.surfaces[k].provenance;
    assert.ok(p, `surface ${k} carries no provenance`);
    assert.equal(p.workspaceScope.workspaceId, 'ws-1');
    assert.equal(p.workspaceScope.scopeMode, 'strict-workspace', `${k}: strict workspace scope must be explicit`);
    for (const field of ['lanes', 'providers', 'captureSources', 'filters'] as const) {
      assert.ok(Array.isArray(p.population[field]), `${k}: population.${field} missing`);
    }
    assert.ok(typeof p.windowStart === 'string' && p.windowStart.length > 0, `${k}: windowStart`);
    assert.ok(typeof p.windowEnd === 'string' && p.windowEnd.length > 0, `${k}: windowEnd`);
    // Anchor-stability: computed ONCE at export start — no drifting "now"s.
    assert.equal(p.snapshotAnchor, ANCHOR, `${k}: drifted anchor`);
    assert.ok(p.comparabilityKey.length === 64, `${k}: comparabilityKey is not a sha256 hex`);
  }
  assert.equal(snap.provenance.snapshotAnchor, ANCHOR);
  assert.equal(snap.provenance.requestedWindowDays, null, 'no --window given → disclosed as null');
});

test('the strict-workspace MCP scope is explicit on the mcpToolUsage population', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const filters = snap.surfaces.mcpToolUsage.provenance!.population.filters;
  assert.ok(filters.includes('mcpScope:strict-workspace'), `filters were: ${filters.join(', ')}`);
});

test('comparability is decidable from the surface JSON alone: the key recomputes from the provenance fields', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  for (const k of SURFACE_KEYS) {
    const { comparabilityKey, ...rest } = snap.surfaces[k].provenance!;
    assert.equal(computeComparabilityKey(rest), comparabilityKey,
      `${k}: the key does not recompute from the surface's own JSON`);
  }
});

test("the 'surface-provenance' capability is declared iff every surface is populated", async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  assert.ok(snap.capabilities?.includes('surface-provenance'));
  // Withheld without provenances (older model / partial map) — populated, not possible.
  assert.equal(snapshotCapabilities(overheadModel()).includes('surface-provenance'), false);
  const partial = buildSurfaceProvenances({ anchorIso: ANCHOR, workspaceId: 'ws-1' });
  const missingOne = { ...partial, plans: undefined } as unknown as Record<SurfaceKey, SurfaceProvenanceV1>;
  assert.equal(
    snapshotCapabilities(overheadModel(), undefined, missingOne).includes('surface-provenance'),
    false, 'a partial provenance map must honestly withhold the capability');
});

// ── step 2: --window against the anchor; true windows for the rest ────────────

test('--window is applied against the anchor; surfaces that cannot honor it export their TRUE window → different key', async () => {
  const { deps, spy } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, windowDays: 7, deps });

  const anchorMs = Date.parse(ANCHOR);
  const wantSince = anchorMs - 7 * 86_400_000;
  // Uniform application: both time-filterable queries got the same anchor-derived window.
  assert.equal(spy.skillQueries[0].sinceMs, wantSince);
  assert.equal(spy.skillQueries[0].untilMs, anchorMs);
  assert.equal(spy.mcpQueries[0].sinceMs, wantSince);
  assert.equal(spy.mcpQueries[0].untilMs, anchorMs);
  assert.equal(snap.provenance.requestedWindowDays, 7);

  // The windowed surfaces export the applied window (inclusive-start/exclusive-end).
  const skill = snap.surfaces.skillUsage.provenance!;
  assert.equal(skill.windowStart, new Date(wantSince).toISOString());
  assert.equal(skill.windowEnd, ANCHOR);
  // The optimizer CANNOT honor it — true all-history window, therefore a
  // different comparabilityKey than any windowed surface.
  const opt = snap.surfaces.optimizer.provenance!;
  assert.equal(opt.windowStart, ALL_RECORDED_HISTORY_START);
  assert.equal(opt.windowEnd, ANCHOR);
  assert.notEqual(opt.comparabilityKey, skill.comparabilityKey);
});

test('a query that IGNORES the requested window exports its true (all-history) window — server-witnessed, not flag-assumed', async () => {
  // This spy never echoes the window into scopeMeta — like a query without the filter.
  const { deps } = makeDeps({
    querySkillUsage: (() => skillResult()) as unknown as ExporterDeps['querySkillUsage'],
  });
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, windowDays: 7, deps });
  const skill = snap.surfaces.skillUsage.provenance!;
  assert.equal(skill.windowStart, ALL_RECORDED_HISTORY_START,
    'an unapplied window must NOT be pretended on the provenance');
  assert.equal(skill.windowEnd, ANCHOR);
});

test('point-in-time surfaces export windowStart = windowEnd = anchor', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  for (const k of ['contextOverhead', 'agentKnowledge', 'plans'] as SurfaceKey[]) {
    const p = snap.surfaces[k].provenance!;
    assert.equal(p.windowStart, ANCHOR, `${k}: windowStart`);
    assert.equal(p.windowEnd, ANCHOR, `${k}: windowEnd`);
  }
});

// ── the downgrade: computed from the keys, never hardcoded ────────────────────

function keysWith(optKey: string, mcpKey: string): Partial<Record<SurfaceKey, string>> {
  return { optimizer: optKey, mcpToolUsage: mcpKey };
}

test('CROSS_SURFACE_COUNTS_NOT_COMPARABLE: identical keys → advisory + observed:false', () => {
  const c = buildCaveats(baseConditions({ surfaceComparabilityKeys: keysWith('k1', 'k1') }))
    .find((x) => x.id === 'CROSS_SURFACE_COUNTS_NOT_COMPARABLE')!;
  assert.ok(c, 'the caveat is still emitted — downgraded, never removed');
  assert.equal(c.severity, 'advisory');
  assert.equal(c.observed, false);
});

test('CROSS_SURFACE_COUNTS_NOT_COMPARABLE: differing or absent keys → blocking + observed:true', () => {
  for (const keys of [keysWith('k1', 'k2'), undefined, { optimizer: 'k1' } as Partial<Record<SurfaceKey, string>>]) {
    const c = buildCaveats(baseConditions({ surfaceComparabilityKeys: keys }))
      .find((x) => x.id === 'CROSS_SURFACE_COUNTS_NOT_COMPARABLE')!;
    assert.equal(c.severity, 'blocking', `keys=${JSON.stringify(keys)} must stay blocking (fail-closed)`);
    assert.equal(c.observed, true);
  }
});

test('date coincidence can NEVER lift the caveat: same window dates, different population → different keys → blocking', () => {
  const common = {
    workspaceScope: { workspaceId: 'ws-1', scopeMode: 'strict-workspace' as const },
    windowStart: ALL_RECORDED_HISTORY_START, windowEnd: ANCHOR, snapshotAnchor: ANCHOR,
  };
  const a = buildSurfaceProvenance({
    ...common,
    population: { lanes: ['worker'], providers: ['claude'], captureSources: ['behavior-events-sqlite'], filters: [] },
  });
  const b = buildSurfaceProvenance({
    ...common,
    population: { lanes: ['worker'], providers: ['claude'], captureSources: ['mcp-tool-events-index'], filters: [] },
  });
  assert.notEqual(a.comparabilityKey, b.comparabilityKey,
    'the key must hash the population, not just the dates');
  const c = buildCaveats(baseConditions({
    surfaceComparabilityKeys: keysWith(a.comparabilityKey, b.comparabilityKey),
  })).find((x) => x.id === 'CROSS_SURFACE_COUNTS_NOT_COMPARABLE')!;
  assert.equal(c.severity, 'blocking');
});

test('a REAL capture keeps the caveat blocking (the six populations genuinely differ)', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const c = snap.caveats.find((x) => x.id === 'CROSS_SURFACE_COUNTS_NOT_COMPARABLE')!;
  assert.equal(c.severity, 'blocking');
  assert.equal(c.observed, true);
  // The downgrade moved this id OUT of the unconditional list — but the three
  // remaining unconditional ids are untouched.
  assert.equal(ALWAYS_BLOCKING_CAVEAT_IDS.includes('CROSS_SURFACE_COUNTS_NOT_COMPARABLE' as never), false);
  assert.equal(ALWAYS_BLOCKING_CAVEAT_IDS.length, 3);
});

test('comparabilityKeysIdentical: fail-closed on empty/missing/mismatched', () => {
  assert.equal(comparabilityKeysIdentical(undefined, ['optimizer', 'mcpToolUsage']), false);
  assert.equal(comparabilityKeysIdentical({}, ['optimizer', 'mcpToolUsage']), false);
  assert.equal(comparabilityKeysIdentical({ optimizer: 'k', mcpToolUsage: '' }, ['optimizer', 'mcpToolUsage']), false);
  assert.equal(comparabilityKeysIdentical({ optimizer: 'k', mcpToolUsage: 'k' }, []), false);
  assert.equal(comparabilityKeysIdentical({ optimizer: 'k', mcpToolUsage: 'k' }, ['optimizer', 'mcpToolUsage']), true);
});

// ── WP3 evidence stamp ────────────────────────────────────────────────────────

test('stampRecommendationEvidenceComparability stamps draft evidence entries and nothing else', () => {
  const input = {
    proposals: [{
      id: 'p1',
      recommendationDraft: {
        target: { unresolved: true, reason: 'x' }, claim: 'c',
        evidence: [{ kind: 'file-heat', rowIds: ['r1'], generationId: 'g1' }],
        humanReviewRequired: true,
      },
      other: { evidence: [{ kind: 'not-a-draft' }] },
    }],
  };
  const out = stampRecommendationEvidenceComparability(input, 'KEY') as typeof input & {
    proposals: Array<{ recommendationDraft: { evidence: Array<{ comparabilityKey?: string }> };
      other: { evidence: Array<{ comparabilityKey?: string }> } }>;
  };
  assert.equal(out.proposals[0].recommendationDraft.evidence[0].comparabilityKey, 'KEY');
  assert.equal(out.proposals[0].other.evidence[0].comparabilityKey, undefined,
    'only recommendationDraft.evidence entries are stamped');
  // Non-mutating.
  assert.equal((input.proposals[0].recommendationDraft.evidence[0] as { comparabilityKey?: string }).comparabilityKey, undefined);
});

test('a captured draft carries the OPTIMIZER surface key on its evidence entries', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const proposals = (snap.surfaces.optimizer.data?.proposals ?? []) as Array<{
    recommendationDraft?: { evidence: Array<{ comparabilityKey?: string }> };
  }>;
  const draft = proposals.find((p) => p.recommendationDraft)?.recommendationDraft;
  assert.ok(draft, 'fixture proposal carries a draft');
  assert.equal(draft.evidence[0].comparabilityKey,
    snap.surfaces.optimizer.provenance!.comparabilityKey);
});

// ── snapshotId clock-independence ────────────────────────────────────────────

test('an unchanged corpus at a DIFFERENT anchor still hashes to the same snapshotId', async () => {
  const { deps: d1 } = makeDeps();
  const { deps: d2 } = makeDeps();
  const s1 = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps: d1 });
  const s2 = await captureAnalyticsSnapshot({
    ...BASE_OPTS, deps: d2, now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  assert.notEqual(s1.provenance.snapshotAnchor, s2.provenance.snapshotAnchor);
  assert.notEqual(
    s1.surfaces.optimizer.provenance!.comparabilityKey,
    s2.surfaces.optimizer.provenance!.comparabilityKey,
    'the key moves with the anchor by design');
  assert.equal(s1.snapshotId, s2.snapshotId,
    'anchor/window/key are clock stamps and must be stripped from the id');
});

// ── golden snapshot refresh + SUMMARY table ───────────────────────────────────

test('golden refresh: provenance survives publication; SUMMARY gains the provenance table', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp8-golden-'));
  try {
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir) as AnalyticsSnapshotV2;
    assert.ok(back.capabilities?.includes('surface-provenance'),
      'the WP8 capability is asserted present in the golden snapshot');
    for (const k of SURFACE_KEYS) {
      assert.ok(back.surfaces[k].provenance?.comparabilityKey, `${k}: provenance lost in round-trip`);
      // Per-surface JSON alone suffices for the comparability decision.
      const sf = JSON.parse(fs.readFileSync(nodePath.join(dir, 'surfaces', `${k}.json`), 'utf8'));
      assert.ok(sf.provenance?.comparabilityKey, `${k}: surfaces/${k}.json carries no provenance`);
    }
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.capabilities.includes('surface-provenance'));
    assert.equal(manifest.provenance.snapshotAnchor, ANCHOR);

    const summary = fs.readFileSync(nodePath.join(dir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /## Surface provenance \(comparability\)/);
    assert.match(summary, /snapshot anchor/);
    assert.match(summary, /comparabilityKey/);
    assert.match(summary, /mcpScope:strict-workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a snapshot WITHOUT surface provenance renders no provenance table (older v2 stays valid)', () => {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) {
    (surfaces as Record<SurfaceKey, unknown>)[k] =
      { status: 'empty', generationId: 'g1', data: null, errors: [], caveatIds: [] };
  }
  const s: AnalyticsSnapshotV2 = {
    schemaVersion: 2, capabilities: [], snapshotId: 'x',
    captureStartedAtIso: ANCHOR, captureCompletedAtIso: ANCHOR,
    provenance: {
      workspace: { id: 'ws-1', root: '$WORKSPACE', pathType: 'windows' },
      workspaceGitSha: null, workspaceGitBranch: null, workspaceGitDirty: null,
      appVersion: '0', exporterVersion: 1,
      databaseMode: 'readonly-query-only', backfillMode: 'skip', scopeMode: 'strict',
      redactionPolicy: 'agent-safe-v1',
      laneGrantMatrix: {
        supervisor: { toolsets: [], strictMcp: false }, worker: { toolsets: [], strictMcp: true },
        researcher: { toolsets: [], strictMcp: true }, legacy: { toolsets: [], strictMcp: true },
      },
      indexState: { epochsBackfilled: true, skillIndexComplete: true },
      generationIds: {},
    },
    caveats: [], surfaces,
  };
  assert.doesNotMatch(renderSummaryMarkdown(s), /## Surface provenance/);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
