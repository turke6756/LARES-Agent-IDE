// WP2 provenance spine — plan-events unit test (pure, no DB).
//
// Exercises the R2 §2.5 resolution ladder VERBATIM (every rung + every mismatch
// reason), the tolerant sentinel scrape / claimed-anchor shape validation
// (amendments §F-D), and composePlanEvent over stub deps (no-plan skip; claimed
// anchor mirrored to the row yet EXCLUDED from the resolver inputs).
//
//   npm run build:main
//   node dist/main/main/plans/plan-events.test.js

import assert from 'node:assert/strict';
import type {
  PlanSectionTouchRow,
  PlanSectionChangeRow,
  InsertPlanEventInput,
} from '../database';
import {
  resolveTargetAnchor,
  scrapePlanEventSentinel,
  validateClaimedAnchor,
  composePlanEvent,
  planEventTurnKey,
  TurnComposeGuard,
  type ResolveInputs,
  type IntentAnchor,
  type ComposePlanEventDeps,
} from './plan-events';
import { PENDING_EDIT_ANCHOR, ORIENTATION_ANCHOR } from './plan-touch-tracker';
import type { FileActivity } from '../../shared/types';
import { parseRepoActivityEvidence, formatRepoDigest } from './repo-activity';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function resolve(partial: Partial<ResolveInputs>) {
  return resolveTargetAnchor({
    editTargets: partial.editTargets ?? [],
    changed: partial.changed ?? [],
    intent: partial.intent ?? [],
    dispatched: partial.dispatched ?? null,
  });
}
const intent = (anchor: string, strong = false): IntentAnchor => ({ anchor, strong });

// ── Ladder rung 1: edit-target single ────────────────────────────────────────

test('rung 1 — single edit-target → edit-target / high', () => {
  const r = resolve({ editTargets: ['sec_aaa111'], dispatched: 'sec_aaa111' });
  assert.equal(r.observedSectionAnchor, 'sec_aaa111');
  assert.equal(r.observedVia, 'edit-target');
  assert.equal(r.attributionConfidence, 'high');
  assert.equal(r.editTargetAnchor, 'sec_aaa111');
  assert.equal(r.sectionMismatch, false);
  assert.equal(r.mismatchReason, null);
});

test('rung 1 wins even when fs-diff signal is also present', () => {
  const r = resolve({ editTargets: ['sec_aaa111'], changed: ['sec_bbb222', 'sec_ccc333'] });
  assert.equal(r.observedVia, 'edit-target');
  assert.equal(r.observedSectionAnchor, 'sec_aaa111');
});

// ── Ladder rung 2: fs-diff single (± corroboration) ──────────────────────────

test('rung 2 — single changed, no corroboration → fs-diff / medium', () => {
  const r = resolve({ changed: ['sec_bbb222'] });
  assert.equal(r.observedSectionAnchor, 'sec_bbb222');
  assert.equal(r.observedVia, 'fs-diff');
  assert.equal(r.attributionConfidence, 'medium');
});

test('rung 2 — single changed corroborated by intent on same anchor → high', () => {
  const r = resolve({ changed: ['sec_bbb222'], intent: [intent('sec_bbb222')] });
  assert.equal(r.observedVia, 'fs-diff');
  assert.equal(r.attributionConfidence, 'high');
  assert.equal(r.mismatchReason, null, 'intent==effect → no divergence');
});

test('rung 2 — single changed corroborated by a (≥2) edit-target set → high', () => {
  // editTargets has 2 anchors (so rung 1 does not fire) and includes the changed one.
  const r = resolve({ editTargets: ['sec_bbb222', 'sec_zzz999'], changed: ['sec_bbb222'] });
  assert.equal(r.observedVia, 'fs-diff');
  assert.equal(r.attributionConfidence, 'high');
});

// ── Ladder rung 3: changed>1 ─────────────────────────────────────────────────

test('rung 3 — changed>1 with exactly one diff∩intent → diff∩intent / medium', () => {
  const r = resolve({ changed: ['sec_bbb222', 'sec_ccc333'], intent: [intent('sec_ccc333')] });
  assert.equal(r.observedSectionAnchor, 'sec_ccc333');
  assert.equal(r.observedVia, 'diff∩intent');
  assert.equal(r.attributionConfidence, 'medium');
});

test('rung 3 — changed>1, no single intersection → multi-section / low, picks most-recent changed', () => {
  const r = resolve({ changed: ['sec_bbb222', 'sec_ccc333'] });
  assert.equal(r.observedSectionAnchor, 'sec_ccc333', 'most-recent (last) changed');
  assert.equal(r.observedVia, 'multi-section');
  assert.equal(r.attributionConfidence, 'low');
  assert.equal(r.mismatchReason, 'multi-section');
});

test('rung 3 — changed>1 multi-section prefers editTargets[0] when present', () => {
  // editTargets has 2 (rung 1 skipped); intersection with changed is 0 → multi-section.
  const r = resolve({
    editTargets: ['sec_ddd444', 'sec_eee555'],
    changed: ['sec_bbb222', 'sec_ccc333'],
  });
  assert.equal(r.observedVia, 'multi-section');
  assert.equal(r.observedSectionAnchor, 'sec_ddd444', 'editTargets[0] wins the tiebreak');
  assert.equal(r.mismatchReason, 'multi-section');
});

test('rung 3 — changed>1 with TWO diff∩intent members falls through to multi-section', () => {
  const r = resolve({
    changed: ['sec_bbb222', 'sec_ccc333'],
    intent: [intent('sec_bbb222'), intent('sec_ccc333')],
  });
  assert.equal(r.observedVia, 'multi-section');
  assert.equal(r.attributionConfidence, 'low');
});

// ── Ladder rung 4: intent-only ───────────────────────────────────────────────

test('rung 4 — no effect signal → intent-only / low (strong intent outranks plain)', () => {
  const r = resolve({ intent: [intent('sec_weak00'), intent('sec_strng0', true)] });
  assert.equal(r.observedSectionAnchor, 'sec_strng0', 'raw+editWindow read outranks plain read');
  assert.equal(r.observedVia, 'intent-only');
  assert.equal(r.attributionConfidence, 'low');
  assert.equal(r.readIntentAnchor, 'sec_strng0');
});

// ── Ladder rung 5: dispatched-fallback ───────────────────────────────────────

test('rung 5 — nothing observed → dispatched-fallback / low', () => {
  const r = resolve({ dispatched: 'sec_disp00' });
  assert.equal(r.observedSectionAnchor, 'sec_disp00');
  assert.equal(r.observedVia, 'dispatched-fallback');
  assert.equal(r.attributionConfidence, 'low');
  assert.equal(r.sectionMismatch, false, 'observed==dispatched → no mismatch');
});

test('rung 5 — nothing at all → all-null result', () => {
  const r = resolve({});
  assert.equal(r.observedSectionAnchor, null);
  assert.equal(r.observedVia, 'dispatched-fallback');
  assert.equal(r.sectionMismatch, false);
  assert.equal(r.mismatchReason, null);
});

// ── Mismatch reasons ─────────────────────────────────────────────────────────

test('intent-effect divergence — fetched scaffold for A, edited B → attribute B, flag divergence', () => {
  const r = resolve({ editTargets: ['sec_bbb222'], intent: [intent('sec_aaa111', true)] });
  assert.equal(r.observedSectionAnchor, 'sec_bbb222', 'the change (B) wins, intent never overrides');
  assert.equal(r.observedVia, 'edit-target');
  assert.equal(r.readIntentAnchor, 'sec_aaa111');
  assert.equal(r.mismatchReason, 'intent-effect-divergence');
});

test('intent-effect divergence fires on fs-diff-derived observation too', () => {
  const r = resolve({ changed: ['sec_bbb222'], intent: [intent('sec_aaa111')] });
  // changed corroborated? intent is on a DIFFERENT anchor → not corroborated → medium.
  assert.equal(r.observedVia, 'fs-diff');
  assert.equal(r.attributionConfidence, 'medium');
  assert.equal(r.mismatchReason, 'intent-effect-divergence');
});

test('dispatch-drift — observed diverges from dispatched with no intent conflict', () => {
  const r = resolve({ editTargets: ['sec_bbb222'], dispatched: 'sec_disp00' });
  assert.equal(r.observedSectionAnchor, 'sec_bbb222');
  assert.equal(r.sectionMismatch, true);
  assert.equal(r.mismatchReason, 'dispatch-drift', 'no intent → dispatch-drift, not divergence');
});

test('multi-section reason takes precedence over dispatch-drift', () => {
  const r = resolve({ changed: ['sec_bbb222', 'sec_ccc333'], dispatched: 'sec_disp00' });
  assert.equal(r.observedVia, 'multi-section');
  assert.equal(r.sectionMismatch, true);
  assert.equal(r.mismatchReason, 'multi-section');
});

test('observedCandidates records every considered anchor, de-duplicated & ordered', () => {
  const r = resolve({
    editTargets: ['sec_aaa111'],
    changed: ['sec_aaa111', 'sec_bbb222'],
    intent: [intent('sec_ccc333')],
    dispatched: 'sec_disp00',
  });
  assert.deepEqual(r.observedCandidates, ['sec_aaa111', 'sec_bbb222', 'sec_ccc333', 'sec_disp00']);
});

// ── Sentinel scrape + claimed-anchor shape validation (§F-D) ──────────────────

test('scrapePlanEventSentinel — valid shape yields payload + claimed anchor', () => {
  const msg = 'work done.\n<!--PLAN-EVENT {"claimed_section_anchor":"sec_abc123","note":"hi"}-->';
  const s = scrapePlanEventSentinel(msg);
  assert.equal(s.claimedSectionAnchor, 'sec_abc123');
  assert.ok(s.payload);
  assert.equal(s.payload!.note, 'hi');
});

test('scrapePlanEventSentinel — blk_ prefix accepted', () => {
  const s = scrapePlanEventSentinel('<!--PLAN-EVENT {"claimed_section_anchor":"blk_9zx0aa"}-->');
  assert.equal(s.claimedSectionAnchor, 'blk_9zx0aa');
});

test('scrapePlanEventSentinel — camelCase key also accepted', () => {
  const s = scrapePlanEventSentinel('<!--PLAN-EVENT {"claimedSectionAnchor":"sec_abc123"}-->');
  assert.equal(s.claimedSectionAnchor, 'sec_abc123');
});

test('scrapePlanEventSentinel — invalid shape → payload kept but claimed coerced null', () => {
  const s = scrapePlanEventSentinel('<!--PLAN-EVENT {"claimed_section_anchor":"NOPE"}-->');
  assert.ok(s.payload, 'payload survives (valid JSON)');
  assert.equal(s.claimedSectionAnchor, null, 'bad shape → null');
});

test('scrapePlanEventSentinel — missing sentinel → both null', () => {
  const s = scrapePlanEventSentinel('a message with no sentinel at all');
  assert.equal(s.payload, null);
  assert.equal(s.claimedSectionAnchor, null);
});

test('scrapePlanEventSentinel — malformed JSON never throws, both null', () => {
  const s = scrapePlanEventSentinel('<!--PLAN-EVENT {not: valid json,,}-->');
  assert.equal(s.payload, null);
  assert.equal(s.claimedSectionAnchor, null);
});

test('scrapePlanEventSentinel — null / non-string input → both null', () => {
  assert.equal(scrapePlanEventSentinel(null).claimedSectionAnchor, null);
  assert.equal(scrapePlanEventSentinel(undefined).payload, null);
  assert.equal(scrapePlanEventSentinel(42 as unknown as string).payload, null);
});

test('scrapePlanEventSentinel — last sentinel wins when several present', () => {
  const msg =
    '<!--PLAN-EVENT {"claimed_section_anchor":"sec_aaa111"}-->\n' +
    '<!--PLAN-EVENT {"claimed_section_anchor":"sec_bbb222"}-->';
  assert.equal(scrapePlanEventSentinel(msg).claimedSectionAnchor, 'sec_bbb222');
});

test('validateClaimedAnchor — shape matrix (/^(sec|blk)_[a-z0-9]{6}$/)', () => {
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'sec_abc123' }), 'sec_abc123');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'blk_a1b2c3' }), 'blk_a1b2c3');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'sec_ABC123' }), null, 'uppercase rejected');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'sec_abc12' }), null, 'too short');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'sec_abc1234' }), null, 'too long');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 'foo_abc123' }), null, 'bad prefix');
  assert.equal(validateClaimedAnchor({ claimed_section_anchor: 42 }), null, 'non-string');
  assert.equal(validateClaimedAnchor({}), null, 'missing key');
  assert.equal(validateClaimedAnchor(null), null, 'null payload');
});

// ── composePlanEvent over stub deps ──────────────────────────────────────────

function touch(overrides: Partial<PlanSectionTouchRow>): PlanSectionTouchRow {
  return {
    id: 'tid', agentId: 'a1', planId: 'plan-1', sectionAnchor: '*',
    blockAnchor: null, tool: 'read_plan_section', kind: 'read', readMode: null,
    source: 'transcript', toolUseId: null, resolvePayload: null,
    observedAt: '1970-01-01T00:00:00.000Z', ...overrides,
  };
}
function change(anchor: string): PlanSectionChangeRow {
  return {
    id: 'cid', planId: 'plan-1', sectionAnchor: anchor, blockAnchor: null,
    contentHash: 'h', changedAt: '1970-01-01T00:00:00.000Z',
  };
}
function stubDeps(o: {
  plan?: { planId: string | null; planSection: string | null } | null;
  touches?: PlanSectionTouchRow[];
  changes?: PlanSectionChangeRow[];
  resolveEditTargetAnchor?: (payload: string | null, planId: string) => string | null;
  // Fix-4 — witnessed repo-activity deps (both must be wired for capture).
  getTurnRepoActivity?: ComposePlanEventDeps['getTurnRepoActivity'];
  getRepoActivityContext?: ComposePlanEventDeps['getRepoActivityContext'];
}): { deps: ComposePlanEventDeps; inserts: InsertPlanEventInput[]; writeEvents: Array<Record<string, unknown>> } {
  const inserts: InsertPlanEventInput[] = [];
  const writeEvents: Array<Record<string, unknown>> = [];
  const deps: ComposePlanEventDeps = {
    getAgentPlan: () => (o.plan === undefined ? { planId: 'plan-1', planSection: null } : o.plan),
    getTurnSectionTouches: () => o.touches ?? [],
    getTurnSectionChanges: () => o.changes ?? [],
    insertPlanEvent: (input) => { inserts.push(input); return 'evt-' + inserts.length; },
    resolveEditTargetAnchor: o.resolveEditTargetAnchor,
    getTurnRepoActivity: o.getTurnRepoActivity,
    getRepoActivityContext: o.getRepoActivityContext,
    onWriteEvent: (e) => { writeEvents.push(e as unknown as Record<string, unknown>); },
  };
  return { deps, inserts, writeEvents };
}
// Fix-4 — a file_activities row under the '/ws' workspace root.
function fa(filePath: string, operation: 'read' | 'write' | 'create', ts = '2026-07-09T12:00:00.000Z'): FileActivity {
  return { id: 1, agentId: 'a1', filePath, operation, timestamp: ts, generation: 0, sessionId: null };
}
const REPO_CTX = { workspaceRoot: '/ws', planRelPath: 'plans/p.html' };
const ARGS = { agentId: 'a1', sinceIso: '1970-01-01T00:00:00Z', untilIso: '1970-01-01T00:00:10Z' };

test('composePlanEvent — no plan rail → null, insert skipped', () => {
  const { deps, inserts } = stubDeps({ plan: null });
  assert.equal(composePlanEvent(deps, ARGS), null);
  assert.equal(inserts.length, 0);
});

test('composePlanEvent — plan rail with null planId → null, insert skipped', () => {
  const { deps, inserts } = stubDeps({ plan: { planId: null, planSection: null } });
  assert.equal(composePlanEvent(deps, ARGS), null);
  assert.equal(inserts.length, 0);
});

test('composePlanEvent — reads (intent) drive resolution; orientation reads excluded', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [
      touch({ sectionAnchor: ORIENTATION_ANCHOR, tool: 'list_plan_sections' }), // excluded
      touch({ sectionAnchor: 'sec_read00', readMode: 'raw+editWindow' }),
    ],
  });
  const id = composePlanEvent(deps, ARGS);
  assert.equal(id, 'evt-1');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].observedSectionAnchor, 'sec_read00');
  assert.equal(inserts[0].observedVia, 'intent-only');
  assert.equal(inserts[0].readIntentAnchor, 'sec_read00');
});

test('composePlanEvent — concrete edit-target anchor used directly', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: 'sec_edt000' })],
  });
  composePlanEvent(deps, ARGS);
  assert.equal(inserts[0].observedSectionAnchor, 'sec_edt000');
  assert.equal(inserts[0].observedVia, 'edit-target');
  assert.equal(inserts[0].editTargetAnchor, 'sec_edt000');
});

test('composePlanEvent — PENDING edit-target resolves through WP4 matcher when wired', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: PENDING_EDIT_ANCHOR, resolvePayload: '{}' })],
    resolveEditTargetAnchor: () => 'sec_wp4xxx',
  });
  composePlanEvent(deps, ARGS);
  assert.equal(inserts[0].observedSectionAnchor, 'sec_wp4xxx');
  assert.equal(inserts[0].observedVia, 'edit-target');
});

test('composePlanEvent — PENDING edit-target with no matcher degrades down the ladder', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: 'sec_disp00' },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: PENDING_EDIT_ANCHOR, resolvePayload: '{}' })],
    // no resolveEditTargetAnchor → the edit-target contributes no anchor
  });
  composePlanEvent(deps, ARGS);
  assert.equal(inserts[0].observedVia, 'dispatched-fallback');
  assert.equal(inserts[0].observedSectionAnchor, 'sec_disp00');
});

test('composePlanEvent — claimed anchor mirrored to row but EXCLUDED from resolver inputs (F-D)', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [touch({ sectionAnchor: 'sec_read00' })],          // intent → observed
    changes: [change('sec_chg000')],                            // fs-diff → observed
    // The worker self-reports a DIFFERENT anchor. It must appear on the row but
    // never influence the resolver / candidates.
  });
  const id = composePlanEvent(deps, {
    ...ARGS,
    finalMessage: '<!--PLAN-EVENT {"claimed_section_anchor":"sec_liar0z"}-->',
  });
  assert.equal(id, 'evt-1');
  const row = inserts[0];
  assert.equal(row.claimedSectionAnchor, 'sec_liar0z', 'mirrored onto the row (diagnostics)');
  assert.equal(row.observedSectionAnchor, 'sec_chg000', 'resolver ignored the claim (fs-diff wins)');
  assert.notEqual(row.observedSectionAnchor, 'sec_liar0z');
  const candidates = JSON.parse(row.observedCandidatesJson!);
  assert.ok(!candidates.includes('sec_liar0z'), 'claimed anchor is not a resolver candidate');
  assert.ok(row.claimedPayloadJson && row.claimedPayloadJson.includes('sec_liar0z'));
});

test('composePlanEvent — dispatched section threaded onto the row + envelope', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: 'sec_disp00' },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: 'sec_edt000' })],
  });
  composePlanEvent(deps, { ...ARGS, turnId: 't1', eventType: 'turn-end' });
  const row = inserts[0];
  assert.equal(row.dispatchedSectionAnchor, 'sec_disp00');
  assert.equal(row.sectionMismatch, true);
  assert.equal(row.mismatchReason, 'dispatch-drift');
  assert.equal(row.eventType, 'turn-end');
  const env = JSON.parse(row.trustedEnvelopeJson);
  assert.equal(env.turnId, 't1');
  assert.equal(env.dispatchedSectionAnchor, 'sec_disp00');
  assert.equal(env.touchCount, 1);
});

test('composePlanEvent — a throwing touch query never blocks insertion (tolerant)', () => {
  const inserts: InsertPlanEventInput[] = [];
  const deps: ComposePlanEventDeps = {
    getAgentPlan: () => ({ planId: 'plan-1', planSection: 'sec_disp00' }),
    getTurnSectionTouches: () => { throw new Error('db blip'); },
    getTurnSectionChanges: () => [],
    insertPlanEvent: (input) => { inserts.push(input); return 'evt-1'; },
  };
  const id = composePlanEvent(deps, ARGS);
  assert.equal(id, 'evt-1');
  assert.equal(inserts[0].observedVia, 'dispatched-fallback');
});

test('composePlanEvent — malformed sentinel does not gate insertion', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: 'sec_edt000' })],
  });
  const id = composePlanEvent(deps, { ...ARGS, finalMessage: '<!--PLAN-EVENT {broken-->' });
  assert.equal(id, 'evt-1');
  assert.equal(inserts[0].claimedPayloadJson, null);
  assert.equal(inserts[0].claimedSectionAnchor, null);
});

// ── GT-A WP-A1: written-set (effect only) + change_count on the composed row ──

test('composePlanEvent — writtenSectionAnchorsJson = uniq(changed); changeCount = RAW changes.length', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_aaa111'), change('sec_bbb222'), change('sec_aaa111')], // dup last
  });
  composePlanEvent(deps, ARGS);
  const row = inserts[0];
  assert.deepEqual(JSON.parse(row.writtenSectionAnchorsJson!), ['sec_aaa111', 'sec_bbb222'],
    'effect set is de-duplicated, order preserved');
  assert.equal(row.changeCount, 3, 'change_count = RAW cardinality (D-5), not the de-duplicated length');
});

test('composePlanEvent — an edit-target-only turn with NO fs-diff change writes [] / 0 (D-4)', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    touches: [touch({ kind: 'edit-target', tool: 'edit', sectionAnchor: 'sec_edt000' })],
    // no changes → editTargets are audit signals, NEVER counted as writes
  });
  composePlanEvent(deps, ARGS);
  const row = inserts[0];
  assert.equal(row.writtenSectionAnchorsJson, '[]', 'edit-target/read-intent are not writes');
  assert.equal(row.changeCount, 0);
  assert.equal(row.observedVia, 'edit-target', 'still attributed via the edit-target for display');
  assert.equal(row.editTargetAnchor, 'sec_edt000');
});

// ── GT-C §1.5: enriched onWriteEvent trigger + single createdAt ───────────────

test('composePlanEvent — onWriteEvent fires once on a write turn, carrying the returned id + same createdAt', () => {
  const { deps, inserts, writeEvents } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000'), change('sec_chg111')],
  });
  const id = composePlanEvent(deps, { ...ARGS, createdAt: '2026-07-05T12:00:00.000Z' });
  assert.equal(writeEvents.length, 1, 'exactly one write-event trigger');
  assert.equal(writeEvents[0].planEventId, id, 'carries the returned plan_events id');
  assert.equal(writeEvents[0].createdAt, '2026-07-05T12:00:00.000Z');
  assert.equal(writeEvents[0].createdAt, inserts[0].createdAt, 'ONE createdAt threaded to row + trigger');
  assert.equal(writeEvents[0].changeCount, 2);
  assert.equal(writeEvents[0].planId, 'plan-1');
  assert.deepEqual(writeEvents[0].observedCandidates, JSON.parse(inserts[0].observedCandidatesJson!));
});

test('composePlanEvent — default createdAt is a single value shared by row + trigger', () => {
  const { deps, inserts, writeEvents } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
  });
  composePlanEvent(deps, ARGS); // no explicit createdAt
  assert.ok(inserts[0].createdAt, 'a createdAt was synthesized once');
  assert.equal(writeEvents[0].createdAt, inserts[0].createdAt, 'no second timestamp synthesized');
});

test('composePlanEvent — onWriteEvent does NOT fire on a presence (no-change) turn', () => {
  const { deps, writeEvents } = stubDeps({
    plan: { planId: 'plan-1', planSection: 'sec_disp00' },
    // no changes, no touches → dispatched-fallback presence turn
  });
  composePlanEvent(deps, ARGS);
  assert.equal(writeEvents.length, 0, 'presence turn files no write trigger (I-3 discrimination)');
});

test('composePlanEvent — a throwing onWriteEvent never affects the returned id (best-effort)', () => {
  const inserts: InsertPlanEventInput[] = [];
  const deps: ComposePlanEventDeps = {
    getAgentPlan: () => ({ planId: 'plan-1', planSection: null }),
    getTurnSectionTouches: () => [],
    getTurnSectionChanges: () => [change('sec_chg000')],
    insertPlanEvent: (input) => { inserts.push(input); return 'evt-42'; },
    onWriteEvent: () => { throw new Error('hook blew up'); },
  };
  let id: string | null = null;
  assert.doesNotThrow(() => { id = composePlanEvent(deps, ARGS); });
  assert.equal(id, 'evt-42', 'the insert id survives a throwing hook');
});

// ── Turn-scoped compose dedup (planning-surface demo fix, 2026-07-06) ─────────
// Regression for the codex double-compose: a second idle delivery for the SAME
// turn must NOT compose a second plan_events row. The guard keys on the turn id
// (when present) else the working→idle window-start ms.

test('planEventTurnKey — turn id wins when present', () => {
  assert.equal(planEventTurnKey('turn-abc', 12345), 't:turn-abc');
});

test('planEventTurnKey — falls back to the window-start ms when no turn id', () => {
  assert.equal(planEventTurnKey(null, 12345), 'w:12345');
  assert.equal(planEventTurnKey(undefined, 999), 'w:999');
  assert.equal(planEventTurnKey('', 42), 'w:42');
});

test('TurnComposeGuard — a duplicate idle delivery for the same turn is skipped (codex double-compose)', () => {
  const guard = new TurnComposeGuard();
  const key = planEventTurnKey('turn-1', 1000);
  assert.equal(guard.shouldSkip('agent-x', key), false, 'first compose for the turn proceeds');
  assert.equal(guard.shouldSkip('agent-x', key), true, 'second delivery (same turn) is suppressed');
});

test('TurnComposeGuard — no-turn-id duplicates collapse on the shared window start', () => {
  const guard = new TurnComposeGuard();
  // Two idle events 1-2 ms apart share the SAME working-hook window start.
  const key = planEventTurnKey(null, 5_000);
  assert.equal(guard.shouldSkip('agent-c', key), false);
  assert.equal(guard.shouldSkip('agent-c', key), true, 'same window start → one compose');
});

test('TurnComposeGuard — a genuinely new turn (new window start / turn id) composes again', () => {
  const guard = new TurnComposeGuard();
  assert.equal(guard.shouldSkip('agent-x', planEventTurnKey(null, 1000)), false);
  assert.equal(guard.shouldSkip('agent-x', planEventTurnKey(null, 2000)), false, 'later turn = new window start');
  assert.equal(guard.shouldSkip('agent-x', planEventTurnKey('turn-9', 2000)), false, 'distinct turn id also composes');
});

test('TurnComposeGuard — keys are per-agent (one agent never suppresses another)', () => {
  const guard = new TurnComposeGuard();
  const key = planEventTurnKey('shared-turn', 7);
  assert.equal(guard.shouldSkip('agent-a', key), false);
  assert.equal(guard.shouldSkip('agent-b', key), false, 'different agent, same key → still composes');
  assert.equal(guard.shouldSkip('agent-a', key), true, 'agent-a duplicate still suppressed');
});

test('TurnComposeGuard — forget() clears an agent so a reused id recomposes', () => {
  const guard = new TurnComposeGuard();
  const key = planEventTurnKey('turn-1', 1000);
  assert.equal(guard.shouldSkip('agent-x', key), false);
  guard.forget('agent-x');
  assert.equal(guard.shouldSkip('agent-x', key), false, 'after forget the same key composes again');
});

// ── Fix-4 §3: witnessed repo-activity capture at the compose seam ─────────────

test('fix4 §3 — both deps wired + rows → row carries non-null captured blob; totals match', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
    getRepoActivityContext: () => REPO_CTX,
    getTurnRepoActivity: () => [
      fa('/ws/src/a.ts', 'write'), fa('/ws/src/b.ts', 'write'), fa('/ws/src/a.ts', 'read'),
    ],
  });
  composePlanEvent(deps, ARGS);
  const blob = inserts[0].repoActivityJson;
  assert.ok(blob, 'a captured turn stores a non-null repo blob');
  const ev = parseRepoActivityEvidence(blob)!;
  assert.ok(ev, 'blob round-trips through the tolerant parser');
  assert.equal(ev.totals.filesEdited, 2, 'two distinct write-touched files');
  assert.equal(ev.totals.filesRead, 1, 'a.ts also read once');
  assert.equal(ev.totals.distinctFiles, 2);
  assert.equal(formatRepoDigest(ev.totals), 'witnessed: 2 repo files edited; 1 read');
});

test('fix4 §3 (I-4) — getTurnRepoActivity throws → row still inserts with repoActivityJson null', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
    getRepoActivityContext: () => REPO_CTX,
    getTurnRepoActivity: () => { throw new Error('db blip during capture'); },
  });
  const id = composePlanEvent(deps, ARGS);
  assert.equal(id, 'evt-1', 'evidence failure never blocks the insert');
  assert.equal(inserts[0].repoActivityJson, null, 'throwing capture degrades to a NULL blob');
});

test('fix4 §3 (I-4) — getRepoActivityContext returns null → NULL blob, insert succeeds', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
    getRepoActivityContext: () => null, // plan resolved but no workspace context
    getTurnRepoActivity: () => [fa('/ws/src/a.ts', 'write')],
  });
  assert.equal(composePlanEvent(deps, ARGS), 'evt-1');
  assert.equal(inserts[0].repoActivityJson, null, 'no context → capture skipped, blob NULL');
});

test('fix4 §3 — legacy fixture (deps absent) → NULL blob, no throw', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
    // getTurnRepoActivity / getRepoActivityContext intentionally omitted
  });
  assert.equal(composePlanEvent(deps, ARGS), 'evt-1');
  assert.equal(inserts[0].repoActivityJson, null, 'both deps required; either absent → NULL');
});

test('fix4 §3 — exclusion end-to-end: only plan file + .dashboard touched → blob present, digest null', () => {
  const { deps, inserts } = stubDeps({
    plan: { planId: 'plan-1', planSection: null },
    changes: [change('sec_chg000')],
    getRepoActivityContext: () => REPO_CTX,
    getTurnRepoActivity: () => [
      fa('/ws/plans/p.html', 'write'),                 // the plan's own HTML — excluded
      fa('/ws/.dashboard/workers/claude/x.ts', 'read'), // .dashboard/** — excluded
    ],
  });
  composePlanEvent(deps, ARGS);
  const ev = parseRepoActivityEvidence(inserts[0].repoActivityJson)!;
  assert.ok(ev, 'a captured (but empty) turn still serializes a valid blob');
  assert.equal(ev.totals.distinctFiles, 0, 'plan file + .dashboard/** are excluded from totals');
  assert.equal(formatRepoDigest(ev.totals), null, 'no repo activity worth a digest line');
});

test('fix4 §3 (I-5) — no-plan turn returns null before any repo capture runs', () => {
  let capderCalled = false;
  const { deps, inserts } = stubDeps({
    plan: null,
    getRepoActivityContext: () => REPO_CTX,
    getTurnRepoActivity: () => { capderCalled = true; return []; },
  });
  assert.equal(composePlanEvent(deps, ARGS), null, 'no plan rail → null');
  assert.equal(inserts.length, 0, 'insert skipped');
  assert.equal(capderCalled, false, 'repo capture never runs for a no-plan turn');
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
