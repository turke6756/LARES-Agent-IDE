// agent-dto-acceptance.test — WP7 §7 acceptance tests at the builder level:
//   28  empty-while-indexing → dataState:'indexing' (+ progress), not 'empty'
//   30  MCP privacy: default detail = aggregate gap terms + counts; NO raw snippets ever
//   Task 1b  improvement-proposals = ADD/TUNE/RELOCATE levers only (leverFor), cursor-isolated
//   npm run build:main
//   node dist/main/main/context-optimizer/agent-dto-acceptance.test.js

import assert from 'node:assert/strict';
import type { ContextOptimizerProposal, ContextOptimizerResult } from '../../shared/types';
import { buildProposalsPage, buildProposalDetail, IMPROVEMENT_LEVERS } from './agent-dto-build';
import { isSensitive } from './agent-dto';

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

function makeResult(proposals: ContextOptimizerProposal[]): ContextOptimizerResult {
  return {
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    proposals, fileHeat: [],
    modelStats: { residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [] },
    meta: { tierGroups: [], unverifiedSuppressedCount: proposals.filter((p) => p.suppressedFromAgentSurface).length },
  };
}

// ── Test 28: empty while indexing ─────────────────────────────────────────────────
ok('28 empty page WHILE indexing → dataState:indexing + progress, not empty', () => {
  const empty = makeResult([]);
  const indexing = buildProposalsPage(empty, {}, { indexing: { ready: false, progress: { filesDone: 2, filesTotal: 10 } } });
  assert.equal(indexing.ok, true);
  if (indexing.ok) {
    assert.equal(indexing.meta.dataState, 'indexing');
    assert.deepEqual(indexing.meta.indexing, { ready: false, progress: { filesDone: 2, filesTotal: 10 } });
  }
  // Same empty result, indexing DONE → honest 'empty'.
  const done = buildProposalsPage(empty, {}, { indexing: { ready: true } });
  assert.equal(done.ok && done.meta.dataState, 'empty');
  // No indexing signal at all → 'empty' (back-compat with worker #1's callers).
  const noSignal = buildProposalsPage(empty, {});
  assert.equal(noSignal.ok && noSignal.meta.dataState, 'empty');
});

ok('28 a NON-empty page is never downgraded to indexing', () => {
  const res = makeResult([prop({ id: 'a', weight: 100 })]);
  const page = buildProposalsPage(res, {}, { indexing: { ready: false, progress: { filesDone: 1, filesTotal: 9 } } });
  assert.equal(page.ok, true);
  assert.notEqual(page.ok && page.meta.dataState, 'indexing');
});

// ── Test 30: privacy — no raw snippets, aggregate gap terms + counts only ────────
ok('30 default detail = aggregate gap terms + counts; NO raw snippet field anywhere', () => {
  const withGap = prop({
    id: 'g', weight: 200, kind: 'tune-skill-trigger', lever: 'tune',
    phraseGap: { terms: [
      { term: 'comments', bypassCount: 20, invocationCount: 1, gapBps: 1900, liftBps: 500 },
      { term: 'notes', bypassCount: 7, invocationCount: 2, gapBps: 500, liftBps: 200 },
    ] },
    proposedEdit: { summary: 'tune it', patch: 'diff --git a b' },
  });
  const detail = buildProposalDetail(makeResult([withGap]), 'g');
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  // Aggregate terms + counts present.
  assert.equal(detail.data.phraseGap?.terms[0].term, 'comments');
  assert.equal(detail.data.phraseGap?.terms[0].bypassCount, 20);
  // Patch omitted by default (opt-in only).
  assert.equal(detail.data.proposedEdit?.patch, undefined);
  // No raw snippet field anywhere in the serialized detail (sensitive text never rides MCP).
  const json = JSON.stringify(detail.data).toLowerCase();
  assert.equal(json.includes('"snippet"'), false);
  assert.equal(json.includes('"snippets"'), false);
});

ok('30 includePatch=true opts the diff back in (non-sensitive by construction)', () => {
  const withGap = prop({ id: 'g', weight: 1, proposedEdit: { summary: 's', patch: 'PATCH' } });
  const d = buildProposalDetail(makeResult([withGap]), 'g', { includePatch: true });
  assert.equal(d.ok && d.data.proposedEdit?.patch, 'PATCH');
});

ok('30 isSensitive classifies the three exposure-boundary source kinds', () => {
  assert.equal(isSensitive('user_message'), true);
  assert.equal(isSensitive('supervisor_brief'), true);
  assert.equal(isSensitive('subagent_brief'), true);
  assert.equal(isSensitive('command_args'), false);
  assert.equal(isSensitive(undefined), false);
});

// ── Task 1b: improvement-proposals = ADD/TUNE/RELOCATE only, cursor-isolated ─────
ok('1b improvement list keeps ADD/TUNE/RELOCATE, drops SUBTRACT', () => {
  const res = makeResult([
    prop({ id: 'sub', weight: 500, kind: 'subtract-unused-toolset', lever: 'subtract' }),
    prop({ id: 'add', weight: 400, kind: 'add-missing-guidance', lever: 'add' }),
    prop({ id: 'tune', weight: 300, kind: 'tune-skill-trigger', lever: 'tune' }),
    prop({ id: 'rel', weight: 200, kind: 'relocate-to-progressive-disclosure', lever: 'relocate' }),
  ]);
  const improve = buildProposalsPage(res, {}, { route: 'get_improvement_proposals', levers: IMPROVEMENT_LEVERS });
  assert.equal(improve.ok, true);
  if (improve.ok) assert.deepEqual(improve.data.map((s) => s.id), ['add', 'tune', 'rel'], 'subtract excluded');
  // All-levers surface still carries the subtract proposal.
  const all = buildProposalsPage(res, {});
  assert.equal(all.ok && all.data.some((s) => s.id === 'sub'), true);
});

ok('1b an improvement cursor is INVALID against the all-levers route', () => {
  const res = makeResult([
    prop({ id: 'add', weight: 400, kind: 'add-missing-guidance', lever: 'add' }),
    prop({ id: 'tune', weight: 300, kind: 'tune-skill-trigger', lever: 'tune' }),
  ]);
  const p1 = buildProposalsPage(res, { limit: 1 }, { route: 'get_improvement_proposals', levers: IMPROVEMENT_LEVERS });
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  assert.equal(typeof cur, 'string');
  // Replaying that cursor against the default all-levers route must not silently page.
  const crossed = buildProposalsPage(res, { limit: 1, cursor: cur });
  assert.equal(crossed.ok === false && crossed.error.code, 'CURSOR_INVALID');
});

console.log(`\nagent-dto-acceptance: ${passed} passed`);
