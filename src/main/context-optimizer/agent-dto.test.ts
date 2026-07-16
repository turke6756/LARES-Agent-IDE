// agent-dto pure unit tests (WP7 §7 tests 25–27, 30–32 — the pure slices).
// Pure — system-Node runner, no DB:
//   npm run build:main
//   node dist/main/main/context-optimizer/agent-dto.test.js
//
// Route/MCP-level slices of the acceptance list (test 28 indexing-state end-to-end,
// test 29 read-only audit + POST→405, and the MCP privacy-suppression path) live in
// the observability MCP tool test — this file proves the pure DTO mechanics they build on.

import assert from 'node:assert/strict';
import type { ContextOptimizerProposal, FileHeatRollupEntry } from '../../shared/types';
import {
  AGENT_DTO_CAPS,
  computeGenerationId,
  clampLimit,
  computeApproxTokens,
  computeFiltersHash,
  decodeCursor,
  degradePayload,
  encodeCursor,
  errResponse,
  isSensitive,
  okResponse,
  redactFileHeatPath,
  redactRollupEntry,
  toProposalSummary,
  validateCursor,
  type CursorV1,
} from './agent-dto';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ── fixture ─────────────────────────────────────────────────────────────────────
function makeProposal(over: Partial<ContextOptimizerProposal> = {}): ContextOptimizerProposal {
  return {
    id: 'p1',
    kind: 'subtract-dead-guidance',
    lever: 'subtract',
    title: 'Remove dead guidance section',
    rationale: 'never observed across the epoch',
    target: { absPath: 'c:/users/turke/projects/agentdashboard/claude.md', lineStart: 1, lineEnd: 4,
              lane: 'worker', mutable: 'user-owned' },
    residentTokenDelta: { estimate: 120, basis: 'remove-resident' },
    tokenTurnsWeight: 4200,
    occurrence: 'never',
    evidenceState: 'unavailable',
    confidence: 'observed',
    epochConfidence: 'high',
    attribution: { lane: 'worker', slug: 'slug1', streamIds: ['s1', 's2'], sharedCwdRisk: 'none' },
    exposure: { turns: 42, streams: 5, slugs: 2 },
    citations: [
      { source: 'staticOverheadModel', absPath: 'c:/x/claude.md', line: 1 },
      { source: 'historicalChatLogAnalytics', streamId: 's1' },
    ],
    proposedEdit: { summary: 'delete lines 1-4', patch: '--- a\n+++ b\n@@ -1,4 +0,0 @@\n-x' },
    phraseGap: { terms: [{ term: 'notes', bypassCount: 20, invocationCount: 1, gapBps: 9500, liftBps: 100 }] },
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified',
    derivationVerified: false,
    suppressedFromAgentSurface: true,
    ...over,
  };
}

// ── Test 25: summary-vs-detail split ─────────────────────────────────────────────
ok('25 toProposalSummary carries no citations/patch/snippets/fileHeat', () => {
  const s = toProposalSummary(makeProposal());
  assert.equal(s.id, 'p1');
  assert.equal(s.citationCount, 2);
  assert.equal(s.hasPatch, true);
  assert.equal(s.hasPhraseGap, true);
  assert.equal(s.requiresDerivationGate, true);
  assert.equal(s.residentTokenDelta.estimate, 120);
  assert.deepEqual(s.exposure, { turns: 42, streams: 5, slugs: 2 });
  // No heavy fields projected.
  const bag = s as unknown as Record<string, unknown>;
  assert.equal(bag.citations, undefined);
  assert.equal(bag.proposedEdit, undefined);
  assert.equal(bag.phraseGap, undefined);
  assert.equal(bag.fileHeat, undefined);
});

ok('25 hasPatch/hasPhraseGap false when absent', () => {
  const s = toProposalSummary(makeProposal({ proposedEdit: undefined, phraseGap: { terms: [] } }));
  assert.equal(s.hasPatch, false);
  assert.equal(s.hasPhraseGap, false);
});

// ── R2 WP-4B (Step 5): improve-lever projection onto the lean summary ─────────────
ok('WP-4B toProposalSummary projects benefitModel / clusterExemplarRef / rollup verbatim (opaque, drillable)', () => {
  const rollup = {
    count: 3, dimension: 'input_shape_hash' as const, memberRefs: ['h1', 'h2'],
    topMembers: [{ ref: 'h1', count: 5, distinctStreams: 3 }], totalOccurrences: 9,
    distinctStreams: 4, hasDrillableMembers: true,
  };
  const s = toProposalSummary(makeProposal({
    id: 'add-cluster-rollup:worker:input_shape_hash',
    kind: 'add-improvisation-support', lever: 'add', occurrence: 'occurs',
    benefitModel: { kind: 'repeated-cost-avoided', magnitude: 9, basis: '9 occurrences' },
    clusterExemplarRef: 'add-cluster-rollup:worker:input_shape_hash',
    target: { lane: 'worker', mutable: 'scaffold-managed', rollup },
  }));
  assert.deepEqual(s.benefitModel, { kind: 'repeated-cost-avoided', magnitude: 9, basis: '9 occurrences' });
  assert.equal(s.clusterExemplarRef, 'add-cluster-rollup:worker:input_shape_hash');
  assert.deepEqual(s.rollup, rollup);          // copied straight from target.rollup, not redactRollupEntry
  assert.equal(s.hasActionableContent, true);  // a drillable rollup IS actionable
});

ok('WP-4B toProposalSummary omits benefitModel / clusterExemplarRef / rollup when absent (lean row unchanged)', () => {
  const s = toProposalSummary(makeProposal());   // default subtract fixture carries none of the three
  const bag = s as unknown as Record<string, unknown>;
  assert.equal(bag.benefitModel, undefined);
  assert.equal(bag.clusterExemplarRef, undefined);
  assert.equal(bag.rollup, undefined);
});

// ── Test 26: cursor stability / stale / invalid ──────────────────────────────────
ok('26 cursor is stable within a generationId', () => {
  const filtersHash = computeFiltersHash({ lane: 'worker', kind: null, minTier: null, includeUnverified: false });
  const cur: CursorV1 = { v: 1, route: 'get_context_optimizer_proposals', filtersHash,
    sort: 'tokenTurnsWeight DESC, id ASC', lastSortKey: [4200, 'p1'], generationId: 'gen-A', issuedAtMs: 1000 };
  const enc = encodeCursor(cur);
  const dec = decodeCursor(enc);
  assert.deepEqual(dec, cur);
  const v = validateCursor(enc, { route: cur.route, filtersHash, sort: cur.sort, generationId: 'gen-A' });
  assert.equal(v.ok, true);
});

ok('26 CURSOR_STALE after regeneration', () => {
  const filtersHash = computeFiltersHash({ lane: 'worker' });
  const cur: CursorV1 = { v: 1, route: 'r', filtersHash, sort: 'id ASC', lastSortKey: ['p1'],
    generationId: 'gen-A', issuedAtMs: 1 };
  const v = validateCursor(encodeCursor(cur), { route: 'r', filtersHash, sort: 'id ASC', generationId: 'gen-B' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.error.code, 'CURSOR_STALE');
});

ok('26 CURSOR_INVALID on filter change', () => {
  const cur: CursorV1 = { v: 1, route: 'r', filtersHash: computeFiltersHash({ lane: 'worker' }),
    sort: 'id ASC', lastSortKey: ['p1'], generationId: 'gen-A', issuedAtMs: 1 };
  const v = validateCursor(encodeCursor(cur), {
    route: 'r', filtersHash: computeFiltersHash({ lane: 'supervisor' }), sort: 'id ASC', generationId: 'gen-A' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.error.code, 'CURSOR_INVALID');
});

ok('26 malformed cursor → CURSOR_INVALID, decode null', () => {
  assert.equal(decodeCursor('!!!not-base64url-json'), null);
  const v = validateCursor('garbage', { route: 'r', filtersHash: 'x', sort: 'id ASC', generationId: 'g' });
  assert.equal(v.ok === false && v.error.code, 'CURSOR_INVALID');
});

ok('26 sort always ends with id ASC (stability contract)', () => {
  // The route composes sort keys; the contract we hold here is that a cursor whose
  // sort differs is rejected — proving sort is part of the opaque identity.
  const cur: CursorV1 = { v: 1, route: 'r', filtersHash: 'f', sort: 'tokenTurnsWeight DESC, id ASC',
    lastSortKey: [1, 'p1'], generationId: 'g', issuedAtMs: 1 };
  const v = validateCursor(encodeCursor(cur), { route: 'r', filtersHash: 'f', sort: 'confidence DESC, id ASC', generationId: 'g' });
  assert.equal(v.ok === false && v.error.code, 'CURSOR_INVALID');
});

ok('26 generationId is content-derived (stable on identical re-run, changes on regen)', () => {
  const a = computeGenerationId({ proposalIds: ['p1', 'p2'], fileHeatHashes: ['h1'] });
  const aAgain = computeGenerationId({ proposalIds: ['p1', 'p2'], fileHeatHashes: ['h1'] });
  const regen = computeGenerationId({ proposalIds: ['p1', 'p2', 'p3'], fileHeatHashes: ['h1'] });
  assert.equal(a, aAgain, 'identical corpus → identical generationId (cursor stays valid)');
  assert.notEqual(a, regen, 'changed proposal set → new generationId (CURSOR_STALE)');
  // Order is part of identity (sort is stable, ends id ASC).
  assert.notEqual(a, computeGenerationId({ proposalIds: ['p2', 'p1'], fileHeatHashes: ['h1'] }));
});

// ── Test 27: byte-cap degradation ────────────────────────────────────────────────
ok('27 degradation trims snippets→patches→citations→fileHeat then shrinks limit', () => {
  const big = 'x'.repeat(2000);
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, title: 'row',
    snippet: big, patch: big, citations: [{ a: big }, { b: big }],
  }));
  const fileHeatTail = Array.from({ length: 5 }, (_, i) => ({ p: `f${i}`, blob: big }));
  // Cap chosen so snippets+patches+citations+fileHeat all must go and some items drop.
  const res = degradePayload({ items, fileHeatTail, maxBytes: 1500, minLimit: 1 });
  assert.equal(res.ok, true);
  if (res.ok) {
    // Ordered application.
    assert.deepEqual(res.appliedSteps.slice(0, 4), ['snippets', 'patches', 'citations', 'fileHeatTail']);
    assert.equal(res.fileHeatTail.length, 0);
    for (const it of res.items) {
      assert.equal((it as Record<string, unknown>).snippet, undefined);
      assert.equal((it as Record<string, unknown>).patch, undefined);
      assert.deepEqual((it as Record<string, unknown>).citations ?? [], []);
    }
    // Never a mid-list hole: returned ids are a prefix p0..p{n-1}.
    res.items.forEach((it, i) => assert.equal((it as Record<string, unknown>).id, `p${i}`));
  }
});

ok('27 single oversized item → PAYLOAD_TOO_LARGE with suggestedLimit', () => {
  const huge = 'y'.repeat(5000);
  const res = degradePayload({ items: [{ id: 'p0', blob: huge }], maxBytes: 1000, minLimit: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(res.ok === false && (res.error.details?.suggestedLimit as number), 1);
});

ok('27 fits untouched → no steps applied', () => {
  const res = degradePayload({ items: [{ id: 'p0' }], maxBytes: 100000 });
  assert.equal(res.ok === true && res.appliedSteps.length, 0);
});

// ── Test 30 (pure slice): sensitivity derived from source_kind ───────────────────
ok('30 isSensitive covers the three sources and nothing else', () => {
  assert.equal(isSensitive('user_message'), true);
  assert.equal(isSensitive('supervisor_brief'), true);
  assert.equal(isSensitive('subagent_brief'), true);
  assert.equal(isSensitive('assistant_message'), false);
  assert.equal(isSensitive('command_args'), false);
  assert.equal(isSensitive(undefined), false);
  assert.equal(isSensitive(null), false);
});

// ── Test 31: fileHeat path redaction + scopes ────────────────────────────────────
const ROOTS = {
  workspaceRoot: 'C:/Users/turke/Projects/AgentDashboard',
  dashboardRoot: 'C:/Users/turke/Projects/AgentDashboard/.dashboard',
  homeDir: 'C:/Users/turke',
  skillRoots: [{ root: 'C:/Users/turke/Projects/AgentDashboard/.claude/skills/read-comments', skillName: 'read-comments' }],
};

ok('31 workspace / dashboard / skill scope prefixes, no username or drive', () => {
  const ws = redactFileHeatPath('C:/Users/turke/Projects/AgentDashboard/src/main/index.ts', ROOTS);
  assert.equal(ws.pathDisplay, '$WORKSPACE/src/main/index.ts');
  assert.equal(ws.pathScope, 'workspace');

  const dash = redactFileHeatPath('C:/Users/turke/Projects/AgentDashboard/.dashboard/workers/claude/behavioral.md', ROOTS);
  assert.equal(dash.pathDisplay, '$DASHBOARD/workers/claude/behavioral.md');
  assert.equal(dash.pathScope, 'dashboard');

  const skill = redactFileHeatPath('C:/Users/turke/Projects/AgentDashboard/.claude/skills/read-comments/run.py', ROOTS);
  assert.equal(skill.pathDisplay, '$SKILL/read-comments/run.py');
  assert.equal(skill.pathScope, 'skill');

  for (const r of [ws, dash, skill]) {
    assert.ok(!/turke/i.test(r.pathDisplay), 'no username');
    assert.ok(!/^[a-z]:/i.test(r.pathDisplay), 'no drive');
  }
});

ok('31 home + sensitive-dir collapse', () => {
  const home = redactFileHeatPath('C:/Users/turke/notes/todo.md', ROOTS);
  assert.equal(home.pathDisplay, '~/notes/todo.md');
  assert.equal(home.pathScope, 'home');

  const ssh = redactFileHeatPath('C:/Users/turke/.ssh/id_rsa', ROOTS);
  assert.equal(ssh.pathDisplay, '~/.ssh/id_rsa');
  assert.equal(ssh.pathScope, 'home');
  const aws = redactFileHeatPath('C:/Users/turke/.aws/credentials', ROOTS);
  assert.equal(aws.pathDisplay, '~/.aws/credentials');
});

ok('31 external drops drive + username → basename only', () => {
  const ext = redactFileHeatPath('D:/secret-vault/passwords.kdbx', ROOTS);
  assert.equal(ext.pathDisplay, 'external/passwords.kdbx');
  assert.equal(ext.pathScope, 'external');
  assert.ok(!/secret-vault/.test(ext.pathDisplay));
  assert.ok(!/^[a-z]:/i.test(ext.pathDisplay));
});

ok('31 redactRollupEntry reuses the entry pathHash', () => {
  const entry: FileHeatRollupEntry = {
    lane: 'worker', pathDisplay: 'c:/users/turke/projects/agentdashboard/src/x.ts',
    pathHash: 'deadbeef', coverage: 'covered', reads: 3, writes: 0, executes: 0,
    distinctStreams: 2, uncovered: false,
  };
  const r = redactRollupEntry(entry, ROOTS);
  assert.equal(r.pathHash, 'deadbeef');
  assert.equal(r.pathDisplay, '$WORKSPACE/src/x.ts');
});

// ── Test 32: unverifiedSuppressedCount disclosed in meta even when list hides ────
ok('32 meta always discloses unverifiedSuppressedCount', () => {
  const resp = okResponse([toProposalSummary(makeProposal())], {
    meta: {
      generatedAtIso: '2026-07-06T00:00:00.000Z', generationId: 'gen-A', parserVersion: 1,
      dataState: 'ready',
      parityStatus: { verified: false, state: 'unverified-no-reference' },
      insufficientExposureCount: 12, notAnalyzableCount: 3, unverifiedSuppressedCount: 7,
    },
  });
  assert.equal(resp.ok, true);
  if (resp.ok) {
    assert.equal(resp.meta.unverifiedSuppressedCount, 7);
    assert.equal(resp.meta.insufficientExposureCount, 12);
    assert.equal(resp.meta.notAnalyzableCount, 3);
    assert.equal(resp.meta.parityStatus.verified, false);
    // approxTokens auto-derived = chars/4.
    assert.equal(resp.meta.approxTokens, computeApproxTokens(resp.data));
  }
});

// ── misc invariants ──────────────────────────────────────────────────────────────
ok('clampLimit respects default and max', () => {
  assert.equal(clampLimit(undefined, 20, 50), 20);
  assert.equal(clampLimit(999, 20, 50), 50);
  assert.equal(clampLimit(0, 20, 50), 1);
  assert.equal(clampLimit(NaN, 20, 50), 20);
});

ok('caps table matches §5.3', () => {
  assert.equal(AGENT_DTO_CAPS.context_optimizer_proposals.listDefault, 20);
  assert.equal(AGENT_DTO_CAPS.context_optimizer_proposals.listMax, 50);
  assert.equal(AGENT_DTO_CAPS.context_optimizer_proposals.citationsMax, 5);
  assert.equal(AGENT_DTO_CAPS.file_heat.listMax, 100);
});

ok('errResponse shape', () => {
  const e = errResponse({ code: 'INDEXING', message: 'still indexing', retriable: true });
  assert.equal(e.ok, false);
  assert.equal(e.ok === false && e.error.code, 'INDEXING');
});

console.log(`\nagent-dto.test.ts: ${passed} assertions passed`);
