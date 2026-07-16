// api-server-optimizer-routes.test — WP-A (P0): the two optimizer DETAIL routes
// (`get_context_optimizer_proposal`, `get_improvement_proposal`) must decode a URL-
// encoded id BEFORE resolving it, so an id containing `:` (e.g.
// `subtract-dead-guidance:supervisor:<hash>`) — which the MCP client sends as `%3A` —
// round-trips. The two already-correct detail routes (skill-usage :742, agent-knowledge
// :763) are LOCKED against a "helpful" second decode.
//
// Real HTTP against an ApiServer whose run* helpers are stubbed to return fixtures, so
// no DB / live-analyze is touched (mirrors agent-dto-routes.test / api-identity.test).
//   npm run build:main
//   node dist/main/main/api-server-optimizer-routes.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';
import type {
  AgentKnowledgeGraph,
  ContextOptimizerProposal,
  ContextOptimizerProposalKind,
  ContextOptimizerResult,
  SkillUsageResult,
} from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const stubSupervisor = {
  getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
} as unknown as AgentSupervisor;

// ── fixtures ──────────────────────────────────────────────────────────────────────

function prop(over: Partial<ContextOptimizerProposal> & {
  id: string; weight: number; kind?: ContextOptimizerProposalKind;
}): ContextOptimizerProposal {
  const { weight, id, kind, ...rest } = over;
  return {
    id, kind: kind ?? 'subtract-dead-guidance', lever: 'subtract', title: `t-${id}`,
    rationale: 'r', target: { lane: 'worker', mutable: 'user-owned' },
    residentTokenDelta: { estimate: 100, basis: 'remove-resident' },
    tokenTurnsWeight: weight, occurrence: 'never', confidence: 'observed', epochConfidence: 'high',
    attribution: { lane: 'worker', streamIds: ['s'], sharedCwdRisk: 'none' },
    exposure: { turns: 10, streams: 2, slugs: 1 },
    citations: [{ source: 'staticOverheadModel' }],
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false, suppressedFromAgentSurface: false,
    ...rest,
  } as ContextOptimizerProposal;
}

// Ids deliberately carry `:` — the exact class the MCP client percent-encodes and the
// broken routes failed to resolve. `add-missing-guidance` maps to the `add` lever so it
// is the improvement-proposals route's first (and only) row. The proposal with `%3A`
// literally in its id is the double-decode canary.
const OPT_RESULT: ContextOptimizerResult = {
  generatedAtIso: '2026-07-06T00:00:00.000Z',
  proposals: [
    prop({
      id: 'subtract-dead-guidance:supervisor:abc123', weight: 500,
      citations: Array.from({ length: 7 }, () => ({ source: 'staticOverheadModel' as const })),
    }),
    prop({ id: 'add-missing-guidance:worker:def456', weight: 300, kind: 'add-missing-guidance', lever: 'add' }),
    // literal percent-sequence id: server receives it as `proposal%253Aid`, one decode
    // → `proposal%3Aid` (resolves); a SECOND decode → `proposal:id` (would 404).
    prop({ id: 'proposal%3Aid', weight: 100 }),
    // WP-1A: an auditable `never` toolset subtract carrying a non-occurrence audit
    // trail → the ONLY proposal the evidence drill route resolves.
    prop({
      id: 'subtract-unused-toolset:supervisor:withev', weight: 400,
      kind: 'subtract-unused-toolset', evidenceState: 'auditable',
      evidenceRef: 'subtract-unused-toolset:supervisor:withev',
      behaviorEvidence: {
        predicate: { kind: 'toolset-usage', toolset: 'orchestration' },
        matcherVersion: '7', normalizedMatcher: { kind: 'toolset-usage', toolset: 'orchestration' },
        epoch: { id: 'epoch-1', confidence: 'high' },
        denominator: { turns: 100, streams: 2, slugs: 1, sampledStreams: [{ streamId: 's1', turns: 20, lane: 'supervisor' }] },
        numerator: { occurrences: 0, streams: 0, sampledEvents: [] },
        captureCoverage: { providers: { orchestration: { streams: 3, pathEventsSupported: true } }, unknownToolEvents: 0, unresolvedPathEvents: 0 },
        exclusions: { subagents: false, reasons: [] },
      },
    }),
  ],
  fileHeat: [],
  modelStats: {
    residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [],
    // R2 WP-4C — two section-level diagnostics; the route ranks by residentTokens×exposureTurns.
    analyzability: [
      { sectionKey: 'sec:hi', source: { absPath: 'C:/ws/CLAUDE.md', lineStart: 1, lineEnd: 1 },
        lanes: ['supervisor', 'worker'], residentTokens: 500, exposureTurns: 8, actionCount: 2,
        reasons: [{ code: 'pure-prose', count: 2, suggestedDetector: 'imperative-prose-detector' }] },
      { sectionKey: 'sec:lo', source: { absPath: 'C:/ws/.dashboard/workers/claude/CLAUDE.md', lineStart: 5, lineEnd: 5 },
        lanes: ['worker'], residentTokens: 40, exposureTurns: 2, actionCount: 1,
        reasons: [{ code: 'exposure-low', count: 1 }] },
    ],
  },
  meta: { tierGroups: [], unverifiedSuppressedCount: 0 },
} as unknown as ContextOptimizerResult;

const SKILL_RESULT: SkillUsageResult = {
  mostUsed: [
    { skill: 'deep:research', count: 10, avgEffectiveness: 0.5, lastUsedMs: 100 },
    // literal percent-sequence id → locks the already-decode skill-usage route (:742)
    // against a second decode exactly as the proposal canary locks the fixed routes.
    { skill: 'skill%3Aname', count: 5, avgEffectiveness: null, lastUsedMs: 50 },
  ],
  timeline: [
    { tsMs: 100, skill: 'deep:research', slug: 's', lane: 'worker', workspaceKey: 's', detector: 'tool_use', id: 'a', jsonlPath: null },
  ],
  timelineTruncated: false,
  byWorkspace: [], byAgentType: [], byAgentDir: [], byInvoker: [],
  contextSamples: [],
  effectiveness: [],
  cost: [],
  totalInvocations: 15,
  scopeMeta: {
    workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null,
    appliedLane: null, appliedSlug: null,
  },
  generatedAtIso: '2026-07-06T00:00:00.000Z',
} as unknown as SkillUsageResult;

const KNOWLEDGE_GRAPH: AgentKnowledgeGraph = {
  agentId: 'ag-1', agentName: 'Worker',
  nodes: [
    { type: 'capability', label: 'Can do X', detail: 'x'.repeat(400), source: { absPath: 'C:/ws/CLAUDE.md', lineStart: 10, lineEnd: 10 }, sourceScope: 'workspace-ancestor', sourceRole: 'workspace-claude' },
    { type: 'tool', label: 'Bash', detail: 'run commands', source: { absPath: 'C:/ws/.dashboard/workers/claude/CLAUDE.md', lineStart: 5, lineEnd: 5 }, sourceRole: 'agent-claude' },
  ],
  sourceFiles: [{ absPath: 'C:/ws/CLAUDE.md', scope: 'workspace-ancestor', kind: 'inherited-claude', label: 'CLAUDE.md', nodeCount: 1 }],
  generatedAtIso: '2026-07-06T00:00:00.000Z',
} as unknown as AgentKnowledgeGraph;

// ── HTTP harness ────────────────────────────────────────────────────────────────────

interface Res { status: number; body: string; }
function request(port: number, method: string, path: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const AUTH = { Authorization: `Bearer ${getApiToken()}` };

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  // Stub the run* helpers on the instance so `route` runs the REAL page/detail
  // builders (incl. the decodeURIComponent under test) over fixtures — no DB.
  const s = server as unknown as Record<string, unknown>;
  s.runOptimizerForRequest = () => OPT_RESULT;
  s.runSkillUsageForRequest = () => ({ usage: SKILL_RESULT, indexing: false });
  s.runAgentKnowledgeForRequest = () => KNOWLEDGE_GRAPH;
  // Redaction roots come from a DB workspace record in production; under the FakeDb
  // bootstrap there is none, so the real helper yields `workspaceRoot: undefined` and
  // every fixture path (`C:/ws/…`) redacts to `external/<basename>`. Stub it to the
  // fixtures' synthetic root so the route exercises the REAL redaction into `$WORKSPACE/…`.
  s.buildRedactionRoots = () => ({ workspaceRoot: 'C:/ws', dashboardRoot: 'C:/ws/.dashboard', homeDir: 'C:/Users/test' });
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

const OPT = '/api/context-optimizer';
function parse(body: string): any { return JSON.parse(body); }

// GET a list route, return its first id verbatim (the server's own id, un-mangled).
async function firstListId(port: number, listPath: string, pick: (data: any) => string): Promise<string> {
  const res = await request(port, 'GET', listPath, AUTH);
  assert.equal(res.status, 200, `${listPath} expected 200, got ${res.status}`);
  const env = parse(res.body);
  assert.equal(env.ok, true, `${listPath} envelope not ok: ${res.body}`);
  return pick(env.data);
}

// ── Four-surface round-trip: list id (verbatim) → matching detail route → ok ─────────

test('round-trip: proposals detail resolves a `:`-bearing id (the P0 fix)', () =>
  withServer(async (port) => {
    const id = await firstListId(port, `${OPT}/proposals`, (d) => d[0].id);
    assert.equal(id, 'subtract-dead-guidance:supervisor:abc123', 'list returns the raw server id');
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent(id)}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `detail must resolve the encoded id, got: ${res.body}`);
    assert.equal(env.data.rationale, 'r', 'rationale resolved');
    assert.equal(env.data.citations.length, 5, 'citations capped at 5');
  }));

test('round-trip: improvement-proposals detail resolves a `:`-bearing id (the P0 fix)', () =>
  withServer(async (port) => {
    const id = await firstListId(port, `${OPT}/improvement-proposals`, (d) => d[0].id);
    assert.equal(id, 'add-missing-guidance:worker:def456', 'improvement list returns the raw server id');
    const res = await request(port, 'GET', `${OPT}/improvement-proposals/${encodeURIComponent(id)}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `improvement detail must resolve the encoded id, got: ${res.body}`);
    assert.equal(env.data.rationale, 'r', 'rationale resolved');
    assert.equal(env.data.citations.length, 1, 'citations present (capped ≤ 5)');
  }));

test('round-trip: skill-usage detail resolves the first listed id', () =>
  withServer(async (port) => {
    const id = await firstListId(port, `${OPT}/skill-usage`, (d) => d.skills[0].id);
    assert.equal(id, 'deep:research', 'skill id === skill name, verbatim');
    const res = await request(port, 'GET', `${OPT}/skill-usage/${encodeURIComponent(id)}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `skill detail must resolve, got: ${res.body}`);
    assert.equal(env.data.skill, 'deep:research');
  }));

test('round-trip: agent-knowledge detail resolves the first listed node id', () =>
  withServer(async (port) => {
    const id = await firstListId(port, `${OPT}/agent-knowledge`, (d) => d.nodes[0].id);
    const res = await request(port, 'GET', `${OPT}/agent-knowledge/${encodeURIComponent(id)}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `knowledge detail must resolve, got: ${res.body}`);
    assert.equal(env.data.id, id, 'node id round-trips');
  }));

// ── Double-decode guard ─────────────────────────────────────────────────────────────
// A single decode is correct; a second would corrupt a literal `%25` sequence. A bare
// `foo:bar` id can NOT catch this (it has no percent to over-decode), so these fixtures
// carry a literal percent sequence in the server id.

test('proposals: single-decode resolves `proposal%3Aid` (a 2nd decode would 404)', () =>
  withServer(async (port) => {
    // server id === `proposal%3Aid`; over HTTP as `proposal%253Aid`.
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent('proposal%3Aid')}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, 'exactly one decode must resolve the literal-percent id');
    assert.equal(env.data.id, 'proposal%3Aid');
  }));

test('LOCK :742 — skill-usage still single-decodes its own `%25` fixture', () =>
  withServer(async (port) => {
    // server id === `skill%3Aname`; over HTTP as `skill%253Aname`. If a worker adds a
    // second decode here it becomes `skill:name` → INVALID_ARGUMENT and this fails.
    const res = await request(port, 'GET', `${OPT}/skill-usage/${encodeURIComponent('skill%3Aname')}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, 'skill-usage must NOT gain a second decode');
    assert.equal(env.data.skill, 'skill%3Aname');
  }));

test('LOCK :763 — agent-knowledge detail resolves its verbatim (hash) id', () =>
  withServer(async (port) => {
    // Knowledge node ids are content-hashed hex, so a literal `%25` fixture is not
    // constructible here (a hex id survives any number of decodes unchanged). The
    // guard we CAN assert is the verbatim round-trip: :763 uses the identical
    // `decodeURIComponent(match[1])` idiom the skill-usage LOCK above already fences,
    // so that canary covers the shared "helpful second decode" regression for both.
    const id = await firstListId(port, `${OPT}/agent-knowledge`, (d) => d.nodes[0].id);
    const res = await request(port, 'GET', `${OPT}/agent-knowledge/${encodeURIComponent(id)}`, AUTH);
    assert.equal(res.status, 200);
    assert.equal(parse(res.body).ok, true, 'knowledge detail must keep resolving its own id');
  }));

// ── Bad id: INVALID_ARGUMENT envelope, never a raw 404/500 ──────────────────────────

test('bad id → ok:false INVALID_ARGUMENT envelope on HTTP 200 (not a 404/500)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent('no-such:id:zzz')}`, AUTH);
    assert.equal(res.status, 200, 'the envelope rides a 200, not an HTTP error status');
    const env = parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ARGUMENT');
  }));

test('bad id → same INVALID_ARGUMENT envelope on the improvement route', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${OPT}/improvement-proposals/${encodeURIComponent('no-such:id:zzz')}`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ARGUMENT');
  }));

// ── WP-1A (P0): the evidence drill route ────────────────────────────────────────

test('GET /proposals/:id/evidence returns the OccurrenceEvidence envelope for an auditable never', () =>
  withServer(async (port) => {
    const id = 'subtract-unused-toolset:supervisor:withev';
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent(id)}/evidence`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `evidence envelope not ok: ${res.body}`);
    assert.equal(env.data.predicate.kind, 'toolset-usage');
    assert.equal(env.data.denominator.sampledStreams[0].streamId, 's1');
    assert.equal(env.meta.parserVersion, 2, 'v2 parser bump on the meta');
  }));

test('non-GET to /proposals/:id/evidence → 405 (read-only audit)', () =>
  withServer(async (port) => {
    const id = 'subtract-unused-toolset:supervisor:withev';
    const res = await request(port, 'POST', `${OPT}/proposals/${encodeURIComponent(id)}/evidence`, AUTH);
    assert.equal(res.status, 405, 'a mutating method to a read-only route 405s');
  }));

test('evidence route: an id with no behavior evidence → INVALID_ARGUMENT envelope', () =>
  withServer(async (port) => {
    // A `never` proposal that carries no non-occurrence audit trail (evidenceState unavailable).
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent('subtract-dead-guidance:supervisor:abc123')}/evidence`, AUTH);
    assert.equal(res.status, 200, 'envelope rides a 200');
    const env = parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ARGUMENT');
  }));

test('evidence route: an unknown id → INVALID_ARGUMENT envelope', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent('no-such:id:zzz')}/evidence`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ARGUMENT');
  }));

// ── R2 WP-4B (Step 3): the cluster-exemplars drill route ─────────────────────────
const CLUSTER_EXEMPLARS = [
  { ref: 'h1', toolShortName: 'read_agent_chat', inputKeys: ['agentId', 'limit'], count: 5, distinctStreams: 3, eventRefs: [] },
];
// A dedicated result (NOT the shared OPT_RESULT) with a drillable + a non-drillable rollup.
const ROLLUP_RESULT: ContextOptimizerResult = {
  generatedAtIso: '2026-07-06T00:00:00.000Z',
  proposals: [
    prop({ id: 'add-cluster-rollup:supervisor:input_shape_hash', weight: 0,
      kind: 'add-improvisation-support', lever: 'add', occurrence: 'occurs', confidence: 'inferred',
      clusterExemplarRef: 'add-cluster-rollup:supervisor:input_shape_hash',
      target: { lane: 'supervisor', mutable: 'scaffold-managed',
        rollup: { count: 3, dimension: 'input_shape_hash', memberRefs: ['h1', 'h2'],
                  topMembers: [{ ref: 'h1', count: 5, distinctStreams: 3 }],
                  totalOccurrences: 9, distinctStreams: 4, hasDrillableMembers: true } } }),
    prop({ id: 'add-cluster-rollup:worker:not-drillable', weight: 0,
      kind: 'add-improvisation-support', lever: 'add', occurrence: 'occurs', confidence: 'inferred',
      target: { lane: 'worker', mutable: 'scaffold-managed',
        rollup: { count: 2, dimension: 'input_shape_hash', memberRefs: [], topMembers: [],
                  totalOccurrences: 4, distinctStreams: 2, hasDrillableMembers: false } } }),
  ],
  fileHeat: [],
  modelStats: { residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [] },
  meta: { tierGroups: [], unverifiedSuppressedCount: 0 },
} as unknown as ContextOptimizerResult;

async function withClusterServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const s = server as unknown as Record<string, unknown>;
  s.runOptimizerForRequest = () => ROLLUP_RESULT;
  s.buildClusterExemplarStore = () => ({ clusterExemplars: () => ({ exemplars: CLUSTER_EXEMPLARS, nextCursor: 'c' }) });
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

test('GET /proposals/:id/cluster-exemplars returns the redacted exemplar page for a drillable rollup', () =>
  withClusterServer(async (port) => {
    const id = 'add-cluster-rollup:supervisor:input_shape_hash';
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent(id)}/cluster-exemplars`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `cluster-exemplars envelope not ok: ${res.body}`);
    assert.equal(env.data.dimension, 'input_shape_hash');
    assert.equal(env.data.exemplars[0].toolShortName, 'read_agent_chat');
    assert.equal(env.data.exemplars[0].ref, 'h1');
    assert.equal(env.page.nextCursor, 'c');
    assert.equal(env.meta.parserVersion, 2);
  }));

test('non-GET to /proposals/:id/cluster-exemplars → 405 (read-only drill)', () =>
  withClusterServer(async (port) => {
    const id = 'add-cluster-rollup:supervisor:input_shape_hash';
    const res = await request(port, 'POST', `${OPT}/proposals/${encodeURIComponent(id)}/cluster-exemplars`, AUTH);
    assert.equal(res.status, 405);
  }));

// ── R2 WP-4C: the analyzability detail route ────────────────────────────────────

test('GET /analyzability returns the trapped-cost-sorted, redacted section diagnostics', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', `${OPT}/analyzability`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, true, `analyzability envelope not ok: ${res.body}`);
    // Sorted by residentTokens×exposureTurns DESC: sec:hi (4000) before sec:lo (80).
    assert.deepEqual(env.data.map((r: any) => r.trappedCostWeight), [4000, 80]);
    assert.deepEqual(env.data[0].lanes.slice().sort(), ['supervisor', 'worker'], 'cross-lane section carries BOTH lanes');
    assert.equal(env.data[0].reasons[0].code, 'pure-prose');
    // Redacted: workspace-scoped display, never a raw drive/absPath on the agent surface.
    assert.match(env.data[0].source.pathDisplay, /^\$WORKSPACE\//);
    assert.equal(env.data[0].source.absPath, undefined);
    // Meta carries the reason-code histogram + section/action counts.
    assert.deepEqual(env.meta.notAnalyzableByReasonCode, { 'pure-prose': 2, 'exposure-low': 1 });
    assert.equal(env.meta.notAnalyzableSectionCount, 2);
    assert.equal(env.meta.notAnalyzableActionCount, 3);
  }));

test('non-GET to /analyzability → 405 (read-only surface)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', `${OPT}/analyzability`, AUTH);
    assert.equal(res.status, 405);
  }));

test('cluster-exemplars route: a non-drillable rollup id → ok:false INVALID_ARGUMENT', () =>
  withClusterServer(async (port) => {
    const id = 'add-cluster-rollup:worker:not-drillable';
    const res = await request(port, 'GET', `${OPT}/proposals/${encodeURIComponent(id)}/cluster-exemplars`, AUTH);
    assert.equal(res.status, 200);
    const env = parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ARGUMENT');
  }));

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok - ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL - ${t.name}\n`, e); }
  }
  console.log(`\napi-server-optimizer-routes: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
