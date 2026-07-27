// analytics-exporter.test — plan §6 tests 1-3, 6, 7, 9, 10, 11.
//   npm run build:main
//   node dist/main/main/analytics-export/analytics-exporter.test.js
//
// Test 4 (redaction) and test 5 (generationId stability) live in
// context-overhead/overhead-dto.test.ts, where the redaction fixture already is.
//
// Every dependency that touches the database, the filesystem scan, or the plan
// layer is injected through `ExporterDeps`, so the suite runs under plain node
// with no Electron, no dashboard.db, and no workspace.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import type {
  AgentContextOverhead, AgentKnowledgeGraph, ContextOptimizerProposal,
  ContextOptimizerResult, McpToolUsageResult, OverheadModel, OverheadSource,
  SkillUsageResult, TokenEstimate, Workspace,
} from '../../shared/types';
import {
  captureAnalyticsSnapshot, writeAnalyticsSnapshot, snapshotHasPartialFailure,
  snapshotDirName, sanitizeMessage, resolveWorkspace, ExporterError,
  COLD_START_MESSAGE, hashProjectSlug, claudeProjectSlug, isForeignStreamId,
  type ExporterDeps,
} from './analytics-exporter';
import {
  planPrune, planTmpSweep, SURFACE_KEYS, canonicalJson,
  type AnalyticsSnapshotV2, type DirEntry,
} from './analytics-types';
import { CAVEAT_IDS, ALWAYS_BLOCKING_CAVEAT_IDS } from './analytics-caveats';
import { renderSummaryMarkdown, renderSummaryTables, IMPROV_DIAGNOSTIC_KEY } from './analytics-render';
import { diffAnalyticsSnapshots, SnapshotDiffError } from './analytics-diff';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── fixtures ──────────────────────────────────────────────────────────────────

const USER = 'zqfixtureuser';
const WS_ROOT = `C:\\Users\\${USER}\\Projects\\Demo`;
// A WSL-hosted agent's stream id is a UNC path — neither drive-letter nor
// `/home/...` shaped. The first fixture to carry one; without it the belt's
// regex gap was invisible and raw `\\wsl.localhost\...` reached the artifact.
const UNC_STREAM = `\\\\wsl.localhost\\Ubuntu\\home\\${USER}\\.claude\\projects\\p\\s.jsonl`;

// ── slug vectors ─────────────────────────────────────────────────────────────
// A Claude project slug is `cwd.replace(/[/\\:_.]/g, '-')` (claude-jsonl-reader.ts:51)
// — a LOSSLESS encoding of an absolute working directory that `redactFileHeatPath`
// cannot see as a path. The earlier fixture had none (`streamIds: ['s']`, `flatSources:
// []`, `contextSamples: []`), so the leak vector never appeared and the belt could
// claim a green it had not earned.
const LOCAL_SLUG = `C--Users-${USER}-Projects-Demo--dashboard-workers-claude`;
// Another project on the SAME machine. `Demo` vs `Other` — not under this workspace,
// so its ids identify an unrelated tree and must not survive into the artifact.
const FOREIGN_SLUG = `C--Users-${USER}-Projects-Other--dashboard-supervisor`;
// `DemoOld` starts with the local prefix `C--Users-…-Projects-Demo` but is a DIFFERENT
// project — the prefix test must not accept it.
const PREFIXY_FOREIGN_SLUG = `C--Users-${USER}-Projects-DemoOld--dashboard-supervisor`;

/** A stream id as the optimizer really emits it once `redactFileHeatPath` has scoped
 *  it to `~`: the slug segment is intact and lowercased. Built under the REAL homedir
 *  so the production redaction chain (home-scope → `~/…`) actually runs on it. */
function streamId(slug: string, uuid: string): string {
  return nodePath.join(os.homedir(), '.claude', 'projects', slug.toLowerCase(), `${uuid}.jsonl`);
}
const LOCAL_STREAM = streamId(LOCAL_SLUG, '11111111-1111-1111-1111-111111111111');
const FOREIGN_STREAM = streamId(FOREIGN_SLUG, '22222222-2222-2222-2222-222222222222');
const PREFIXY_FOREIGN_STREAM = streamId(PREFIXY_FOREIGN_SLUG, '33333333-3333-3333-3333-333333333333');

const WORKSPACE: Workspace = {
  id: 'ws-1', title: 'Demo', path: WS_ROOT, pathType: 'windows',
  description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
};

function est(tokens: number): TokenEstimate {
  return { tokens, bytes: tokens * 4, chars: tokens * 4, method: 'tiktoken-approx', approximate: true };
}

/** One inherited CLAUDE.md, shaped as the analyzer emits it: `id` and
 *  `dedupeKey` are the absolute path, `id` suffixed with the source kind. */
function overheadSource(): OverheadSource {
  const abs = `${WS_ROOT}\\CLAUDE.md`;
  return {
    id: `${abs}#agent-claude`, kind: 'agent-claude', label: 'CLAUDE.md',
    resolvedPath: abs, dedupeKey: abs, sourceScope: 'agent',
    openable: true, exists: true, inherited: false, mutable: 'user-owned',
    estimate: est(120), origin: 'walk-up',
  };
}

function overheadAgent(id: string, lane: AgentContextOverhead['lane'] = 'worker'): AgentContextOverhead {
  return {
    id, name: `agent-${id}`, kind: 'builtin-worker', lane,
    workingDir: `${WS_ROOT}\\.dashboard\\workers\\claude`,
    pathType: 'windows',
    sidecarPath: undefined,
    // `redactOverheadModel` rewrites the display paths but leaves `id` — the
    // route's `<absPath>#<kind>` join key — absolute. A fixture with no sources
    // at all could never catch that, so seed one.
    inheritanceChain: [{
      dir: `${WS_ROOT}\\.dashboard`, scope: 'agent', distanceFromAgentCwd: 0,
      included: true, sources: [overheadSource()],
    }],
    mcpServers: [], flatSources: [overheadSource()],
    total: est(1000), totalHeaderView: est(800), residentTotal: est(700), onDemandTotal: est(300),
    configWeight: { sections: [], tokensByClass: {
      live: 0, dead: 0, 'structurally-broken': 0,
      'insufficient-evidence': 0, unobservable: 0, 'not-analyzed': 0,
    } },
    exactness: 'estimated',
    warnings: [],
  };
}

/** ≥3 agents, as plan §6 test 3 requires (so an N+1 scan count is detectable). */
function overheadModel(): OverheadModel {
  return {
    workspaceId: 'ws-1',
    workspaceRoot: WS_ROOT,
    pathType: 'windows',
    generatedAt: '2026-07-19T18:44:55.123Z',
    estimatorMethod: 'tiktoken-approx',
    systemBaseline: undefined,
    agents: [overheadAgent('a1'), overheadAgent('a2', 'supervisor'), overheadAgent('a3', 'researcher')],
    workspaceConfigWeight: { sections: [], tokensByClass: {
      live: 0, dead: 0, 'structurally-broken': 0,
      'insufficient-evidence': 0, unobservable: 0, 'not-analyzed': 0,
    } },
    globalWarnings: [],
  };
}

function proposal(id: string, over: Partial<ContextOptimizerProposal> = {}): ContextOptimizerProposal {
  return {
    id, kind: 'subtract-dead-guidance', lever: 'subtract', title: `t-${id}`,
    // The UNC vector also lives on a SCALAR field, not only in `streamIds`. A WSL
    // stream id is foreign to this Windows workspace by construction, so the
    // foreign-id drop would remove it from the array and silently retire the
    // regression guard for ABS_PATH_TOKEN's UNC arm. Here it cannot be dropped —
    // only redacted — so that arm stays under test.
    rationale: `r — observed in ${UNC_STREAM}`,
    target: { absPath: `${WS_ROOT}\\CLAUDE.md`, lineStart: 10, lineEnd: 12, lane: 'worker', mutable: 'user-owned' },
    residentTokenDelta: { estimate: 100, basis: 'remove-resident' },
    tokenTurnsWeight: 100, occurrence: 'never', confidence: 'observed', epochConfidence: 'high',
    attribution: {
      lane: 'worker',
      // One local id, one foreign, one prefix-lookalike, plus the WSL/UNC form.
      streamIds: ['s', LOCAL_STREAM, FOREIGN_STREAM, PREFIXY_FOREIGN_STREAM, UNC_STREAM],
      slug: LOCAL_SLUG,
      sharedCwdRisk: 'none',
    },
    // Aggregates. These are computed upstream of the samples and must survive the
    // foreign-id drop UNCHANGED — `streams: 4` while only 2 sampled ids remain is
    // exactly the disclosed shortfall, not a distorted statistic.
    exposure: { turns: 10, streams: 4, slugs: 3 },
    behaviorEvidence: {
      predicate: { kind: 'command-family', family: 'powershell' },
      matcherVersion: '1',
      normalizedMatcher: { kind: 'command-family', family: 'powershell' },
      epoch: { confidence: 'unknown' },
      denominator: {
        turns: 10, streams: 4, slugs: 3,
        sampledStreams: [
          { streamId: LOCAL_STREAM, turns: 6, lane: 'worker' },
          { streamId: FOREIGN_STREAM, turns: 3, lane: 'worker' },
          { streamId: PREFIXY_FOREIGN_STREAM, turns: 1, lane: 'worker' },
        ],
      },
      numerator: {
        occurrences: 0, streams: 0,
        sampledEvents: [{ streamId: FOREIGN_STREAM, entryUuid: 'e', blockIndex: 0, byteOffset: 0 }],
      },
      captureCoverage: { providers: {}, unknownToolEvents: 0, unresolvedPathEvents: 0 },
      exclusions: { subagents: true, reasons: [] },
    },
    citations: [{ source: 'staticOverheadModel' }],
    // The derivation gate hard-returns verified:false for every lane
    // (optimizer-assemble.ts:140-147) — the fixture mirrors reality, not a wish.
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false, suppressedFromAgentSurface: false,
    ...over,
  } as ContextOptimizerProposal;
}

/** ≥5 proposals, as plan §6 test 3 requires. */
function optimizerResult(): ContextOptimizerResult {
  return {
    generatedAtIso: '2026-07-19T18:44:55.123Z',
    // `p5` mirrors a REAL proposal id, which embeds its target's absolute path.
    // proposalDetails/proposalEvidence are maps KEYED by proposal id, so a
    // path-bearing id is the only fixture that exercises key redaction — with
    // `p1`-style ids the keys were leak-free by accident.
    proposals: ['p1', 'p2', 'p3', 'p4',
      `subtract-dead-guidance:worker:markdown_section:${WS_ROOT}\\CLAUDE.md:h:sec`,
    ].map((id) => proposal(id)),
    fileHeat: [],
    modelStats: {
      residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [],
    },
    meta: { tierGroups: [], unverifiedSuppressedCount: 0 },
  };
}

function skillResult(): SkillUsageResult {
  return {
    mostUsed: [{ skill: 'alpha', count: 5, avgEffectiveness: 0.8, lastUsedMs: 100 }],
    // `slug` / `workspaceKey` carry the RAW-CASED slug — a leak vector with no path
    // shape at all, which the shared redactor passes through untouched.
    timeline: [{
      skill: 'alpha', tsMs: 100, lane: 'worker', detector: 'tool_use', id: 'inv-1',
      slug: LOCAL_SLUG, workspaceKey: LOCAL_SLUG, jsonlPath: LOCAL_STREAM,
    }],
    timelineTruncated: false,
    byWorkspace: [{ key: LOCAL_SLUG, count: 5 }],
    byAgentType: [], byAgentDir: [], byInvoker: [],
    contextSamples: [{
      skill: 'alpha', tsMs: 100, slug: LOCAL_SLUG, workingDir: null,
      lane: 'worker', detector: 'tool_use', args: 'a',
    }],
    effectiveness: [], cost: [],
    totalInvocations: 5,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: null, droppedUnattributedCount: 0, hasAnyInvocations: true,
    },
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as SkillUsageResult;
}

function mcpResult(): McpToolUsageResult {
  return {
    byTool: [{
      toolName: 'mcp__agent-dashboard__read_agent_chat', toolShort: 'read_agent_chat',
      toolset: 'observability', count: 471, distinctStreams: 5, lastTsMs: 10,
    }],
    byToolset: [], byAgent: [], bySession: [], byWorkspace: [],
    byLane: [], byToolLane: [],
    tierBreakdown: {
      'agent-attributed': 471, 'lane-attributed-explicit': 0,
      'lane-inferred-from-current-grant': 0, unattributed: 0,
    },
    attributedCount: 471, unattributedCount: 0, attributionCoveragePct: 100,
    timeline: [], timelineTruncated: false, totalCalls: 471, attributedCalls: 471,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, attributionIsSessionBased: true,
      droppedUnattributedCalls: 0, appliedLane: null, appliedSlug: null,
      appliedAgentId: null, windowSinceMs: null, windowUntilMs: null,
    },
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as McpToolUsageResult;
}

function knowledgeGraph(agentId: string): AgentKnowledgeGraph {
  return {
    agentId, agentName: `agent-${agentId}`,
    nodes: [{
      type: 'capability', label: 'Can do X',
      source: { absPath: `${WS_ROOT}\\CLAUDE.md`, lineStart: 10, lineEnd: 10 },
      sourceScope: 'workspace-ancestor', sourceRole: 'workspace-claude',
    }],
    sourceFiles: [],
    generatedAtIso: '2026-07-19T18:44:55.123Z',
  } as AgentKnowledgeGraph;
}

/** A `db` stand-in. BehaviorStore only calls `.prepare()` lazily, and the
 *  exporter must never write, so every statement here is a read that returns
 *  nothing — and `run()` throws, which is exactly what query_only would do. */
function fakeDb(): unknown {
  return {
    prepare() {
      return {
        get: () => undefined,
        all: () => [],
        run: () => { throw new Error('attempt to write a readonly database'); },
      };
    },
  };
}

interface Spy {
  overheadScans: number;
  optimizerAnalyses: number;
  knowledgeCalls: Array<{ agentId: string; preScannedIsSameObject: boolean }>;
  backfillModes: Array<string | undefined>;
  scopeModes: Array<string | undefined>;
  closed: number;
}

function makeDeps(over: Partial<ExporterDeps> = {}): { deps: Partial<ExporterDeps>; spy: Spy } {
  const spy: Spy = {
    overheadScans: 0, optimizerAnalyses: 0, knowledgeCalls: [],
    backfillModes: [], scopeModes: [], closed: 0,
  };
  const model = overheadModel();
  const deps: Partial<ExporterDeps> = {
    getDb: () => fakeDb(),
    getWorkspaces: () => [WORKSPACE],
    getPlans: () => [],
    runOverheadScan: () => { spy.overheadScans += 1; return model; },
    runLiveOptimizerAnalyze: (d) => {
      spy.optimizerAnalyses += 1;
      spy.backfillModes.push((d as { backfillMode?: string }).backfillMode);
      spy.scopeModes.push(d.query?.scopeMode);
      return optimizerResult();
    },
    runKnowledgeExtract: (_ws, agentId, preScanned) => {
      spy.knowledgeCalls.push({ agentId, preScannedIsSameObject: preScanned === model });
      return knowledgeGraph(agentId);
    },
    querySkillUsage: (() => skillResult()) as ExporterDeps['querySkillUsage'],
    queryMcpToolUsage: (() => mcpResult()) as ExporterDeps['queryMcpToolUsage'],
    resolvePlanProjection: (async () => null) as unknown as ExporterDeps['resolvePlanProjection'],
    buildPlanActivityProjection: (() => ({})) as unknown as ExporterDeps['buildPlanActivityProjection'],
    isEpochsBackfilled: () => true,
    skillIndexComplete: () => true,
    gitInfo: async () => ({ sha: 'abc123', branch: 'master', dirty: false }),
    appVersion: () => '0.0.0-test',
    repoDir: () => WS_ROOT,
    closeDatabase: () => { spy.closed += 1; },
    ...over,
  };
  return { deps, spy };
}

const BASE_OPTS = {
  workspace: 'ws-1', keep: 10, prune: true, allowCold: false,
  now: () => new Date('2026-07-19T18:44:55.123Z'),
};

function tmpRoot(label: string): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), `analytics-${label}-`));
  return dir;
}

// ── test 3: exactly one scan, exactly one analysis ───────────────────────────

test('EXACTLY one overhead scan and one optimizer analysis, for 3 agents and 5 proposals', async () => {
  const { deps, spy } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });

  assert.equal(spy.overheadScans, 1, 'the overhead scan must run exactly once');
  assert.equal(spy.optimizerAnalyses, 1, 'the optimizer analysis must run exactly once');
  // Without §2.5's preScanned parameter this would be 1 + 3 = 4 scans.
  assert.equal(spy.knowledgeCalls.length, 3, 'one knowledge extract per scanned agent');
  for (const c of spy.knowledgeCalls) {
    assert.equal(c.preScannedIsSameObject, true,
      `agent ${c.agentId} was extracted from a DIFFERENT scan than the snapshot's`);
  }
  assert.equal(snap.surfaces.agentKnowledge.data?.length, 3);
});

test('the analyze is called with backfillMode:skip and strict scope, and the DB is closed', async () => {
  const { deps, spy } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  assert.deepEqual(spy.backfillModes, ['skip'], "backfillMode must be 'skip' — it is the only writer on that path");
  assert.deepEqual(spy.scopeModes, ['strict']);
  assert.equal(spy.closed, 1, 'the database is closed before any filesystem publication');
  assert.equal(snap.provenance.backfillMode, 'skip');
  assert.equal(snap.provenance.databaseMode, 'readonly-query-only');
});

test('every optimizer surface carries ONE generationId; a mismatch fails capture', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const gid = snap.surfaces.optimizer.generationId;
  assert.ok(gid && gid.length > 0);
  assert.equal(snap.provenance.generationIds.optimizer, gid);

  // Inject a mismatch: a second analyze result whose content (and therefore
  // generationId) differs from the first. The capture must ABORT, not caveat.
  let n = 0;
  const { deps: bad } = makeDeps({
    runLiveOptimizerAnalyze: () => {
      n += 1;
      const r = optimizerResult();
      // Mutating fileHeat between projections is what real drift looks like.
      if (n > 0) r.proposals = r.proposals.slice(0, 4 + (n % 2));
      return r;
    },
  });
  // A single analyze cannot self-disagree, so drive the mismatch through a
  // result whose proposals mutate as the DTO builders read it.
  const drifting = optimizerResult();
  let reads = 0;
  Object.defineProperty(drifting, 'proposals', {
    get() {
      reads += 1;
      return ['p1', 'p2', 'p3', 'p4', 'p5'].slice(0, reads > 2 ? 3 : 5).map((id) => proposal(id));
    },
  });
  void bad;
  const { deps: driftDeps } = makeDeps({ runLiveOptimizerAnalyze: () => drifting });
  await assert.rejects(
    () => captureAnalyticsSnapshot({ ...BASE_OPTS, deps: driftDeps }),
    (e: unknown) => e instanceof ExporterError && e.exitCode === 1
      && /generationId|did not exhaust/.test((e as Error).message),
    'a drifting corpus must fail the capture rather than publish a fake-frozen snapshot',
  );
});

// ── test 2: cold-state gate ──────────────────────────────────────────────────

test('cold DB + allowCold:false → exit 4, nothing published, message names the remedy', async () => {
  for (const cold of [{ isEpochsBackfilled: () => false }, { skillIndexComplete: () => false }]) {
    const { deps } = makeDeps(cold);
    await assert.rejects(
      () => captureAnalyticsSnapshot({ ...BASE_OPTS, deps }),
      (e: unknown) => e instanceof ExporterError && e.exitCode === 4,
    );
  }
  assert.match(COLD_START_MESSAGE, /--allow-cold/);
  assert.match(COLD_START_MESSAGE, /Open the dashboard once/);
});

test('cold DB + allowCold:true → published, surfaces degraded, index caveats blocking', async () => {
  const { deps } = makeDeps({ isEpochsBackfilled: () => false, skillIndexComplete: () => false });
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, allowCold: true, deps });

  assert.equal(snap.surfaces.optimizer.status, 'degraded');
  assert.equal(snap.surfaces.skillUsage.status, 'degraded');
  assert.equal(snap.surfaces.mcpToolUsage.status, 'degraded');
  assert.equal(snap.provenance.indexState.epochsBackfilled, false);

  const sev = (id: string) => snap.caveats.find((c) => c.id === id)?.severity;
  assert.equal(sev('INDEX_BACKFILL_SKIPPED_READ_ONLY'), 'blocking', 'promoted when epochs are not backfilled');
  assert.equal(sev('INDEX_INCOMPLETE'), 'blocking', 'promoted when the skill index is incomplete');

  // §4.4 — a degraded snapshot says so at the TOP of SUMMARY.md, not only in a field.
  const md = renderSummaryMarkdown(snap);
  const head = md.slice(0, md.indexOf('\n## ', 200) === -1 ? md.length : md.indexOf('\n## ', 200));
  assert.match(head, /DEGRADED/i, 'SUMMARY.md must lead with the degradation');
});

// ── test 6: caveat integrity ─────────────────────────────────────────────────

test('all registry caveats are present on EVERY snapshot, including a zero-row one', async () => {
  const { deps } = makeDeps({
    runLiveOptimizerAnalyze: () => ({ ...optimizerResult(), proposals: [] }),
    querySkillUsage: (() => ({ ...skillResult(), mostUsed: [], totalInvocations: 0 })) as ExporterDeps['querySkillUsage'],
  });
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });

  const ids = snap.caveats.map((c) => c.id).sort();
  assert.deepEqual(ids, [...CAVEAT_IDS].sort(),
    'an empty surface needs the warning MOST — no caveat may be conditional on rows existing');

  for (const c of snap.caveats) {
    assert.ok(c.statement.trim().length > 0, `${c.id} has an empty statement`);
    assert.ok(c.evidence.length > 0, `${c.id} has no evidence`);
    for (const e of c.evidence) assert.ok(e.file.trim().length > 0, `${c.id} evidence has no file`);
  }
  for (const id of ALWAYS_BLOCKING_CAVEAT_IDS) {
    assert.equal(snap.caveats.find((c) => c.id === id)?.severity, 'blocking',
      `${id} must be blocking unconditionally`);
  }
  // Every caveatIds reference on a surface resolves to a registry entry.
  const known = new Set(snap.caveats.map((c) => c.id));
  for (const k of SURFACE_KEYS) {
    for (const id of snap.surfaces[k].caveatIds) {
      assert.ok(known.has(id), `surface ${k} references unknown caveat ${id}`);
    }
  }
});

test('verified:false survives verbatim and is never rewritten to a confidence word', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  assert.match(canonicalJson(snap.surfaces.optimizer), /"verified":false/,
    'the raw wiring state must survive into the snapshot');

  // The caveat registry QUOTES the forbidden phrasings in order to forbid them, so
  // the scan covers everything EXCEPT caveat prose — where a hit is the warning
  // itself, not a laundered number.
  const emitted = canonicalJson({ ...snap, caveats: [] }).toLowerCase();
  for (const word of ['low confidence', 'medium confidence', 'unverified (pending)', 'likely valid']) {
    assert.equal(emitted.includes(word), false,
      `verified:false was laundered into the gradable phrase "${word}"`);
  }
  for (const [name, csv] of Object.entries(renderSummaryTables(snap))) {
    for (const word of ['low confidence', 'medium confidence', 'likely valid']) {
      assert.equal(csv.toLowerCase().includes(word), false, `${name} grades verified:false as "${word}"`);
    }
  }
});

// ── test 7: §4 shape guarantees ──────────────────────────────────────────────

test('improvisation occurrence counts appear ONLY under diagnostic_only_routine_tool_shapes', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });

  const csvs = renderSummaryTables(snap);
  assert.equal(IMPROV_DIAGNOSTIC_KEY, 'diagnostic_only_routine_tool_shapes');

  // A caveat CODE naming the defect is required (§3.3: every table carries a
  // caveat_codes column). What is forbidden is a COLUMN carrying the occurrence
  // count under any other name. So: scan headers, not cell text.
  for (const [name, csv] of Object.entries(csvs)) {
    const header = csv.split(/\r?\n/)[0].toLowerCase();
    const suspicious = header.split(',').filter(
      (c) => /improvis|cluster.*(count|occurrence)|occurrence/.test(c) && c !== IMPROV_DIAGNOSTIC_KEY);
    assert.deepEqual(suspicious, [],
      `${name} exposes an improvisation occurrence count outside ${IMPROV_DIAGNOSTIC_KEY}`);
  }

  // SUMMARY.md may DISCUSS the defect (the blocking caveat is printed in full),
  // but no headline/table row may carry the number.
  for (const line of renderSummaryMarkdown(snap).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    if (!/improvis/i.test(line)) continue;
    assert.equal(/\d/.test(line), false,
      `a SUMMARY.md table row pairs "improvisation" with a number: ${line}`);
  }
});

test('no summary or CSV row combines a cluster-exemplar count with an MCP-usage count', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const csvs = renderSummaryTables(snap);

  // The prohibition is structural: the MCP table is the ONLY table that may carry
  // an mcp tool count, and it may not also carry a cluster/exemplar column.
  for (const [name, csv] of Object.entries(csvs)) {
    const header = csv.split(/\r?\n/)[0].toLowerCase();
    const hasMcp = /mcp|tool_name|calls/.test(header);
    const hasCluster = /cluster|exemplar|occurrences/.test(header);
    assert.equal(hasMcp && hasCluster, false,
      `${name} joins cluster-exemplar and MCP-usage counts in one row — the two surfaces `
      + 'disagree on the same verb and neither declares its scope');
  }
});

test('every CSV is comment-free and defuses spreadsheet formula injection', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  for (const [name, csv] of Object.entries(renderSummaryTables(snap))) {
    for (const line of csv.split(/\r?\n/)) {
      assert.equal(line.startsWith('#'), false, `${name} contains a comment row`);
    }
    assert.match(csv.split(/\r?\n/)[0], /caveat_codes/, `${name} lacks a caveat_codes column`);
    for (const cell of csv.split(/\r?\n/).slice(1).flatMap((l) => l.split(','))) {
      assert.equal(/^[=+@]/.test(cell), false, `${name} has an unescaped formula cell: ${cell}`);
    }
  }
});

// ── test 9: full-scope capture + per-item failure ────────────────────────────

test('every schema surface exists and every scanned agent has a knowledge entry', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  for (const k of SURFACE_KEYS) {
    assert.ok(snap.surfaces[k], `missing surface ${k}`);
    assert.ok(snap.provenance.generationIds[k], `missing generationId for ${k}`);
  }
  assert.deepEqual(
    (snap.surfaces.agentKnowledge.data ?? []).map((e) => e.agentId).sort(),
    ['a1', 'a2', 'a3'],
  );
  assert.equal(snapshotHasPartialFailure(snap), false);
  // The authoritative grant comes from the grant functions, for all four lanes.
  assert.deepEqual(Object.keys(snap.provenance.laneGrantMatrix).sort(),
    ['legacy', 'researcher', 'supervisor', 'worker']);
});

test('one agent extraction throwing → agentKnowledge partial, typed error, snapshot still published', async () => {
  const { deps } = makeDeps({
    runKnowledgeExtract: (_ws, agentId) => {
      if (agentId === 'a2') throw new Error(`cannot read ${WS_ROOT}\\broken.md`);
      return knowledgeGraph(agentId);
    },
  });
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  assert.equal(snap.surfaces.agentKnowledge.status, 'partial');
  assert.equal(snap.surfaces.agentKnowledge.errors.length, 1);
  const err = snap.surfaces.agentKnowledge.errors[0];
  assert.equal(err.code, 'KNOWLEDGE_EXTRACT_FAILED');
  assert.equal(err.itemId, 'a2');
  assert.equal(/[A-Za-z]:[\\/]/.test(err.message), false, 'a per-item error leaked an absolute path');
  assert.equal(snapshotHasPartialFailure(snap), true, 'this is the exit-2 condition');
});

test('the optimizer analysis throwing → nothing published, exit 1, no path in the message', async () => {
  const { deps } = makeDeps({
    runLiveOptimizerAnalyze: () => { throw new Error(`corpus at ${WS_ROOT}\\.dashboard is unreadable`); },
  });
  await assert.rejects(
    () => captureAnalyticsSnapshot({ ...BASE_OPTS, deps }),
    (e: unknown) => e instanceof ExporterError && e.exitCode === 1
      && !/[A-Za-z]:[\\/]/.test((e as Error).message),
  );
});

test('sanitizeMessage strips Windows, POSIX, and WSL absolute paths', () => {
  assert.equal(sanitizeMessage(`open ${WS_ROOT}\\CLAUDE.md failed`), 'open <path> failed');
  assert.equal(sanitizeMessage('open /home/zq/x.md failed'), 'open <path> failed');
  assert.equal(sanitizeMessage('open /mnt/c/Users/zq/x.md failed'), 'open <path> failed');
  assert.equal(sanitizeMessage('nothing to strip'), 'nothing to strip');
});

test('workspace resolution: exact id, exact path, unknown, ambiguous', () => {
  assert.equal(resolveWorkspace([WORKSPACE], 'ws-1').id, 'ws-1');
  assert.equal(resolveWorkspace([WORKSPACE], WS_ROOT.replace(/\\/g, '/')).id, 'ws-1');
  assert.throws(() => resolveWorkspace([WORKSPACE], 'nope'),
    (e: unknown) => e instanceof ExporterError && e.exitCode === 1);
  assert.throws(() => resolveWorkspace([WORKSPACE, { ...WORKSPACE }], 'ws-1'),
    (e: unknown) => e instanceof ExporterError && e.exitCode === 1);
});

// ── redaction belt over the WHOLE emitted artifact set ───────────────────────

test('no emitted artifact contains a drive prefix, the workspace root, or the username', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const emitted = canonicalJson(snap) + '\n' + renderSummaryMarkdown(snap) + '\n'
    + Object.values(renderSummaryTables(snap)).join('\n');

  const at = emitted.indexOf(USER);
  assert.equal(at, -1,
    `the fixture username survived at …${emitted.slice(Math.max(0, at - 160), at + 80)}…`);
  assert.equal(emitted.includes(WS_ROOT), false, 'the absolute workspace root survived');
  assert.equal(/[A-Za-z]:[\\/]/.test(emitted), false, 'a drive prefix survived');
  assert.equal(snap.provenance.workspace.root, '$WORKSPACE');

  // The UNC arm, still proven: the WSL id rides a SCALAR field the foreign-id drop
  // cannot reach, so its disappearance is redaction and not deletion.
  assert.equal(emitted.includes('wsl.localhost'), false, 'a UNC host survived');
  assert.ok(emitted.includes('external/s.jsonl'),
    'the UNC stream id should be REDACTED to its external display form, not removed');

  // No slug in any casing survives — neither the in-path form nor a bare value.
  for (const slug of [LOCAL_SLUG, FOREIGN_SLUG, PREFIXY_FOREIGN_SLUG]) {
    assert.equal(emitted.toLowerCase().includes(slug.toLowerCase()), false,
      `the project slug ${slug} survived — it encodes the absolute workspace root`);
  }
  // …and what replaced it is the STABLE digest, not a blanket mask: a snapshot that
  // cannot tell two projects apart is useless for diffing.
  assert.ok(emitted.includes(hashProjectSlug(LOCAL_SLUG)), 'the local slug digest is missing');
  assert.notEqual(hashProjectSlug(LOCAL_SLUG), hashProjectSlug(FOREIGN_SLUG),
    'distinct projects must hash to distinct tokens');
  assert.equal(hashProjectSlug(LOCAL_SLUG), hashProjectSlug(LOCAL_SLUG.toLowerCase()),
    'the raw-cased workspaceKey and the lowercased in-path slug must still join');
});

test('foreign-workspace stream ids are dropped; the aggregates beside them are not', async () => {
  const { deps } = makeDeps();
  const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  // `proposals[]` is the lean ProposalSummaryDTO; the full proposal — with the
  // attribution and evidence sample lists — is in `proposalDetails`, keyed by id.
  const opt = snap.surfaces.optimizer.data as {
    proposalDetails: Record<string, {
      attribution: { streamIds: string[] };
      exposure: { turns: number; streams: number; slugs: number };
      behaviorEvidence: {
        denominator: { turns: number; streams: number; slugs: number; sampledStreams: unknown[] };
        numerator: { occurrences: number; streams: number; sampledEvents: unknown[] };
      };
    }>;
  };
  const p = opt.proposalDetails.p1;
  assert.ok(p, 'the p1 detail must be present');

  // 5 ids in → 'a' non-path id, the local one, and nothing else. The two foreign
  // project ids and the UNC id are gone.
  assert.deepEqual(p.attribution.streamIds,
    ['s', `~/.claude/projects/${hashProjectSlug(LOCAL_SLUG)}/11111111-1111-1111-1111-111111111111.jsonl`],
    'exactly the local (hashed) id and the non-path token should remain');
  assert.equal(p.behaviorEvidence.denominator.sampledStreams.length, 1,
    'both foreign sampledStreams should be dropped');
  assert.equal(p.behaviorEvidence.numerator.sampledEvents.length, 0,
    'a foreign sampledEvent should be dropped');

  // The whole point of the trade-off: NO statistic moved.
  assert.deepEqual(p.exposure, { turns: 10, streams: 4, slugs: 3 });
  assert.equal(p.behaviorEvidence.denominator.turns, 10);
  assert.equal(p.behaviorEvidence.denominator.streams, 4);
  assert.equal(p.behaviorEvidence.denominator.slugs, 3);
  assert.equal(p.behaviorEvidence.numerator.occurrences, 0);

  // …and the shortfall is DISCLOSED, not silent.
  const cav = snap.caveats.find((c) => c.id === 'FOREIGN_WORKSPACE_STREAM_IDS_DROPPED');
  assert.ok(cav, 'FOREIGN_WORKSPACE_STREAM_IDS_DROPPED must be in the registry');
  assert.equal(cav.observed, true, 'the caveat must be observed when ids were dropped');

  // A per-workspace breakdown ROW is a statistic, not an identifier list — the drop
  // must not reach it (its key is hashed, but the row and its count stay).
  const skill = snap.surfaces.skillUsage.data as { rows: unknown[] };
  assert.equal(skill.rows.length, 1, 'the skill row must survive the belt');
});

test('isForeignStreamId accepts only ids under the workspace slug prefix', () => {
  const prefix = claudeProjectSlug(WS_ROOT);
  assert.equal(prefix, `C--Users-${USER}-Projects-Demo`);
  assert.equal(isForeignStreamId(LOCAL_STREAM, prefix), false);
  assert.equal(isForeignStreamId(FOREIGN_STREAM, prefix), true);
  // The boundary: a longer project name that merely STARTS with the prefix.
  assert.equal(isForeignStreamId(PREFIXY_FOREIGN_STREAM, prefix), true);
  // A string that is not a project-scoped id at all is never foreign.
  assert.equal(isForeignStreamId('s', prefix), false);
  assert.equal(isForeignStreamId('$WORKSPACE/CLAUDE.md', prefix), false);
});

// ── test 10: atomic publication + guarded pruning ────────────────────────────

test('publication is atomic: files land under a single sorted directory with a manifest', async () => {
  const root = tmpRoot('publish');
  try {
    const { deps } = makeDeps();
    const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
    const dir = await writeAnalyticsSnapshot(snap, { ...BASE_OPTS, outputRoot: root, deps });

    assert.equal(nodePath.basename(dir), snapshotDirName(snap));
    assert.match(nodePath.basename(dir), /^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    for (const f of ['snapshot.json', 'manifest.json', 'SUMMARY.md']) {
      assert.ok(fs.existsSync(nodePath.join(dir, f)), `missing ${f}`);
    }
    for (const k of SURFACE_KEYS) {
      assert.ok(fs.existsSync(nodePath.join(dir, 'surfaces', `${k}.json`)), `missing surfaces/${k}.json`);
    }
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'analytics-snapshot');
    assert.equal(manifest.snapshotId, snap.snapshotId);
    // No .tmp-* survives a successful run.
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.tmp-')), []);
    // snapshot.json round-trips to the same document.
    const readBack = JSON.parse(fs.readFileSync(nodePath.join(dir, 'snapshot.json'), 'utf8'));
    assert.equal(readBack.snapshotId, snap.snapshotId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write failure mid-capture leaves no final directory', async () => {
  const root = tmpRoot('failwrite');
  try {
    const { deps } = makeDeps();
    const snap = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
    // Fail INSIDE publication, after the tmp directory exists: an unserializable
    // value makes canonicalJson throw part-way through the file writes.
    const broken = {
      ...snap,
      provenance: { ...snap.provenance, appVersion: BigInt(1) as unknown as string },
    } as AnalyticsSnapshotV2;
    await assert.rejects(
      () => writeAnalyticsSnapshot(broken, { ...BASE_OPTS, outputRoot: root, deps }),
      (e: unknown) => e instanceof ExporterError && e.exitCode === 1
        && /nothing was published/.test((e as Error).message),
    );
    assert.deepEqual(
      fs.readdirSync(root).filter((n) => n.startsWith('.tmp-')), [],
      'a failed publication must clean up its .tmp- directory',
    );
    assert.deepEqual(
      fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{8}T/.test(e.name)).map((e) => e.name), [],
      'a failed publication must leave NO final directory',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planPrune keeps the newest N and can only ever select snapshots it wrote', () => {
  const snapDir = (name: string, valid = true): DirEntry => ({
    name, isDirectory: true, hasValidManifest: valid,
  });
  const entries: DirEntry[] = [
    snapDir('20260719T184455123Z-aaaaaaaa'),
    snapDir('20260718T184455123Z-bbbbbbbb'),
    snapDir('20260717T184455123Z-cccccccc'),
    snapDir('20260716T184455123Z-dddddddd'),
    snapDir('20260715T184455123Z-eeeeeeee', false),   // no manifest → never selected
    { name: 'not-a-snapshot', isDirectory: true, hasValidManifest: true },
    { name: 'README.md', isDirectory: false, hasValidManifest: false },
    { name: '.tmp-123-abcdef01', isDirectory: true, hasValidManifest: false },
  ];
  const doomed = planPrune(entries, 2, '20260719T184455123Z-aaaaaaaa');

  assert.deepEqual(doomed.sort(), ['20260716T184455123Z-dddddddd', '20260717T184455123Z-cccccccc']);
  for (const forbidden of ['20260719T184455123Z-aaaaaaaa', '20260715T184455123Z-eeeeeeee',
    'not-a-snapshot', 'README.md', '.tmp-123-abcdef01']) {
    assert.equal(doomed.includes(forbidden), false, `pruner selected ${forbidden}`);
  }
  assert.deepEqual(planPrune(entries, 100, '20260719T184455123Z-aaaaaaaa'), [],
    'keep larger than the population deletes nothing');
});

test('planTmpSweep removes only exporter .tmp-* directories older than 24h', () => {
  const now = 1_800_000_000_000;
  const old = now - 25 * 60 * 60 * 1000;
  const entries: DirEntry[] = [
    { name: '.tmp-123-abcdef01', isDirectory: true, hasValidManifest: false, mtimeMs: old },
    { name: '.tmp-124-abcdef02', isDirectory: true, hasValidManifest: false, mtimeMs: now - 1000 },
    { name: '.tmp-not-ours', isDirectory: true, hasValidManifest: false, mtimeMs: old },
    { name: '20260719T184455123Z-aaaaaaaa', isDirectory: true, hasValidManifest: true, mtimeMs: old },
  ];
  assert.deepEqual(planTmpSweep(entries, now), ['.tmp-123-abcdef01']);
});

// ── test 11: diff ────────────────────────────────────────────────────────────

async function twoSnapshots(): Promise<[AnalyticsSnapshotV2, AnalyticsSnapshotV2]> {
  const { deps: d1 } = makeDeps();
  const before = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps: d1 });
  const { deps: d2 } = makeDeps({
    runOverheadScan: () => {
      const m = overheadModel();
      m.agents[0].total = est(1500);
      m.agents[0].residentTotal = est(1100);
      m.agents.push(overheadAgent('a4'));
      return m;
    },
    runLiveOptimizerAnalyze: () => {
      const r = optimizerResult();
      r.proposals = [...r.proposals.slice(1), proposal('p9')];
      return r;
    },
  });
  const after = await captureAnalyticsSnapshot({
    ...BASE_OPTS, deps: d2, now: () => new Date('2026-07-20T18:44:55.123Z'),
  });
  return [before, after];
}

test('diff is keyed by entity: added, removed, and changed are reported per surface', async () => {
  const [before, after] = await twoSnapshots();
  const d = diffAnalyticsSnapshots(before, after);

  // Overhead is keyed by agent id and reported as its own delta table (§5.2).
  const ids = d.overheadDeltas.map((o) => o.agentId).sort();
  assert.deepEqual(ids, ['a1', 'a2', 'a3', 'a4'], 'overhead deltas are keyed by agent id');
  const a1 = d.overheadDeltas.find((o) => o.agentId === 'a1');
  assert.equal(a1?.total.before, 1000);
  assert.equal(a1?.total.after, 1500);
  assert.equal(a1?.total.delta, 500);

  const opt = d.surfaces.find((s) => s.surface === 'optimizer.proposals');
  assert.ok(opt, 'no optimizer.proposals diff section');
  assert.deepEqual(opt.added.map((a) => a.key), ['p9'], 'proposals are keyed by proposal id');
  assert.deepEqual(opt.removed.map((r) => r.key), ['p1']);
});

test('diff: array reorder alone produces no diff', async () => {
  const { deps } = makeDeps();
  const before = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps });
  const { deps: reordered } = makeDeps({
    runOverheadScan: () => {
      const m = overheadModel();
      m.agents.reverse();
      return m;
    },
  });
  const after = await captureAnalyticsSnapshot({ ...BASE_OPTS, deps: reordered });
  const d = diffAnalyticsSnapshots(before, after);

  for (const o of d.overheadDeltas) {
    assert.equal(o.total.delta, 0, `reordering changed ${o.agentId}`);
    assert.equal(o.resident.delta, 0);
  }
  for (const s of d.surfaces) {
    assert.deepEqual(s.added, [], `${s.surface} reported an addition for a pure reorder`);
    assert.deepEqual(s.removed, [], `${s.surface} reported a removal for a pure reorder`);
    assert.deepEqual(s.changed, [], `${s.surface} reported a change for a pure reorder`);
  }
});

test('diff: caveats and generationIds propagate; schemaVersion mismatch refuses', async () => {
  const [before, after] = await twoSnapshots();
  const d = diffAnalyticsSnapshots(before, after);

  assert.ok(d.caveats.all.length >= CAVEAT_IDS.length,
    'all caveats from both snapshots propagate into the diff');
  assert.deepEqual(Object.keys(d.provenance.generationIds).sort(), [...SURFACE_KEYS].sort());
  assert.equal(d.provenance.generationIds.optimizer.equal, false,
    'a changed optimizer corpus must be disclosed as a generationId change');
  assert.equal(d.provenance.beforeSnapshotId, before.snapshotId);
  assert.ok(d.provenance.interpretation.length > 0, 'the diff must say what its deltas can mean');

  // WP-S: v1 and v2 are both accepted now; an UNKNOWN future version refuses.
  const wrong = { ...after, schemaVersion: 3 } as unknown as AnalyticsSnapshotV2;
  assert.throws(() => diffAnalyticsSnapshots(before, wrong),
    (e: unknown) => e instanceof SnapshotDiffError && e.exitCode === 1);
});

test('diff carries no percentage or recommendation for a diagnostic-only cluster delta', async () => {
  const [before, after] = await twoSnapshots();
  const d = diffAnalyticsSnapshots(before, after);
  const json = canonicalJson(d);

  for (const s of d.surfaces) {
    for (const c of s.changed) {
      for (const f of c.changes) {
        if (/cluster|improvis|occurrence/i.test(f.field) || /cluster|improvis/i.test(c.key)) {
          assert.equal(f.diagnosticOnly, true,
            `${s.surface}.${c.key}.${f.field} is an improvisation-cluster delta and must be diagnosticOnly`);
        }
      }
    }
  }
  // Scanned WITHOUT caveat prose: the caveats deliberately talk about percentages
  // in order to forbid them.
  const body = canonicalJson({ ...d, caveats: { newInAfter: [], severityChanged: [], all: [] } });
  assert.equal(/improvis[^"]*(pct|percent|%)/i.test(body), false,
    'an improvisation delta was converted into a percentage');
  void json;
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL  ${t.name}\n`, e); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
