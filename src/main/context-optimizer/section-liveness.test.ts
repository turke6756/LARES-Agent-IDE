// section-liveness.test.ts — WP5 (G5): one test per strict-lattice row,
// including the adversarial rows (dead+unmatchable → NOT dead; observed +
// structurally-broken → BOTH axes; cohort conflict → mixed + per-cohort map),
// plus annotation/rollup behavior.
//
// node:assert on dist. Run: node dist/main/main/context-optimizer/section-liveness.test.js
import assert from 'node:assert';
import type { ConfigWeightRollup, SectionBehaviorStatus } from '../../shared/types';
import type { PredictedAction } from './guidance-action-model';
import type { OccurrenceVerdict } from './occurrence-classifier';
import { annotateConfigWeight, cohortsOf, joinSectionBehavior } from './section-liveness';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const K = 'markdown_section:C:/ws/CLAUDE.md:h:guide>alpha';

let seq = 0;
function action(over: Partial<PredictedAction> = {}): PredictedAction {
  return {
    id: `a${++seq}`,
    source: { absPath: 'C:/ws/CLAUDE.md', line: 7 },
    sourceKind: 'workflow',
    lanes: ['worker'],
    kind: 'command-family',
    params: { commandFamily: 'git' },
    derivability: 'exact',
    residentTokens: 10,
    sourceSectionKey: K,
    sourceEpochId: '',
    requiresDerivationGate: true,
    ...over,
  } as PredictedAction;
}
function verdict(actionId: string, status: OccurrenceVerdict['status'], over: Partial<OccurrenceVerdict> = {}): OccurrenceVerdict {
  return {
    actionId, status,
    occurrences: status === 'occurs' ? 3 : 0,
    distinctStreams: 0, distinctSlugs: 0,
    exposureTurns: 100, exposureStreams: 5, exposureSlugs: 2,
    confidence: 'observed', epochConfidence: 'unknown',
    includeSubagents: false, predicate: null,
    evidenceState: 'unavailable',
    ...over,
  } as OccurrenceVerdict;
}

/** One lane whose verdicts mirror the given statuses/overrides, all on section K. */
function join(nodes: Array<{ status: OccurrenceVerdict['status']; v?: Partial<OccurrenceVerdict>; a?: Partial<PredictedAction>; unpaired?: boolean }>) {
  const actions: PredictedAction[] = [];
  const verdicts: OccurrenceVerdict[] = [];
  for (const n of nodes) {
    const a = action(n.a ?? {});
    actions.push(a);
    if (!n.unpaired) verdicts.push(verdict(a.id, n.status, n.v ?? {}));
  }
  return joinSectionBehavior([{ actions, verdicts }]);
}
function statusOf(nodes: Parameters<typeof join>[0]): SectionBehaviorStatus {
  const recs = join(nodes);
  assert.strictEqual(recs.length, 1);
  return recs[0].behaviorStatus;
}

// A fully fail-closed dead node: `never` + auditable (never-gates passed) +
// audience-scoped with a provably `complete` capture cohort.
const DEAD = {
  status: 'never' as const,
  v: { evidenceState: 'auditable' as const, captureCoverage: 'complete' as const },
  a: { audienceProviders: ['claude'] as string[] | 'unknown' },
};

// ── lattice rows ──────────────────────────────────────────────────────────────

check("row 1: zero nodes extracted → 'not-analyzed' (via annotate)", () => {
  const rollup: ConfigWeightRollup = {
    sections: [{
      sourcePath: 'C:/ws/CLAUDE.md', sourceLabel: 'CLAUDE.md', scope: 'agent',
      heading: 'Alpha', startLine: 5, endLine: 8, tokens: 40,
      weightClass: 'insufficient-evidence', evidence: [], sectionKey: K,
    }],
    tokensByClass: {} as ConfigWeightRollup['tokensByClass'],
  };
  const { rollup: out } = annotateConfigWeight(rollup, []);
  assert.strictEqual(out.sections[0].behaviorStatus, 'not-analyzed');
  assert.deepStrictEqual(out.sections[0].behaviorStatusByCohort, {});
});

check("row 2: all nodes unmatchable/pure-prose → 'unobservable'", () => {
  assert.strictEqual(statusOf([
    { status: 'unobservable' }, { status: 'unobservable' },
  ]), 'unobservable');
});

check("row 3: ≥1 observed AND ≥1 fail-closed-dead → 'mixed'", () => {
  assert.strictEqual(statusOf([
    { status: 'occurs' },
    { status: 'never', v: { evidenceState: 'auditable' } },
  ]), 'mixed');
});

check("row 4: ≥1 observed, no dead → 'live'", () => {
  assert.strictEqual(statusOf([
    { status: 'occurs' }, { status: 'insufficient-exposure' },
  ]), 'live');
});

check("row 5: all analyzable dead via never-gates + complete capture + zero unmatchable → 'dead'", () => {
  assert.strictEqual(statusOf([DEAD, DEAD]), 'dead');
});

check("row 6: any capture-incomplete and no observed → 'capture-incomplete'", () => {
  assert.strictEqual(statusOf([
    { status: 'capture-incomplete', v: { evidenceState: 'partial' } },
    DEAD,
  ]), 'capture-incomplete');
});

check("row 7: otherwise → 'insufficient-evidence'", () => {
  assert.strictEqual(statusOf([{ status: 'insufficient-exposure' }]), 'insufficient-evidence');
});

// ── adversarial rows ──────────────────────────────────────────────────────────

check('adversarial: dead + unmatchable → NOT dead', () => {
  const s = statusOf([DEAD, { status: 'unobservable' }]);
  assert.notStrictEqual(s, 'dead');
  assert.strictEqual(s, 'insufficient-evidence');
});

check('fail-closed: a legacy un-audited `never` (evidenceState unavailable) never supports dead', () => {
  const s = statusOf([{ status: 'never', v: { evidenceState: 'unavailable' } }]);
  assert.notStrictEqual(s, 'dead');
  assert.strictEqual(s, 'insufficient-evidence');
});

check("fail-closed: `never`+auditable WITHOUT captureCoverage 'complete' never supports dead", () => {
  const s = statusOf([{ status: 'never', v: { evidenceState: 'auditable' } }]);
  assert.notStrictEqual(s, 'dead');
  assert.strictEqual(s, 'insufficient-evidence');
});

check('fail-closed: an unpaired (verdict-less) action bars dead', () => {
  const s = statusOf([DEAD, { status: 'never', unpaired: true }]);
  assert.notStrictEqual(s, 'dead');
  const [rec] = join([DEAD, { status: 'never', unpaired: true }]);
  assert.strictEqual(rec.nodeCounts.unpaired, 1, 'the gap is disclosed, not dropped');
});

check('adversarial: cohort conflict → top-level mixed + per-cohort map always exported', () => {
  // Deliberately a conflict whose ALL-NODES lattice is NOT mixed ('live':
  // observed ≥1, no dead) — only the cohort-disagreement rule forces 'mixed',
  // so this test fails if that override is dropped.
  const recs = join([
    { status: 'occurs', a: { audienceProviders: ['claude'] } },
    { status: 'insufficient-exposure', a: { audienceProviders: ['codex'] } },
  ]);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].behaviorStatus, 'mixed');
  assert.deepStrictEqual(recs[0].behaviorStatusByCohort,
    { claude: 'live', codex: 'insufficient-evidence' });
});

check('cohort conflict where a dead cohort meets an observed cohort → mixed + map', () => {
  const recs = join([
    { status: 'occurs', a: { audienceProviders: ['claude'] } },
    { ...DEAD, a: { audienceProviders: ['codex'] } },
  ]);
  assert.strictEqual(recs[0].behaviorStatus, 'mixed');
  assert.deepStrictEqual(recs[0].behaviorStatusByCohort, { claude: 'live', codex: 'dead' });
});

check('cohort agreement keeps the lattice status; map still exported', () => {
  const recs = join([{ status: 'occurs' }, { status: 'occurs' }]);
  assert.strictEqual(recs[0].behaviorStatus, 'live');
  assert.deepStrictEqual(recs[0].behaviorStatusByCohort, { claude: 'live' });
});

check("cohorts: legacy → 'claude'; 'unknown'/empty audience → 'unknown'; list → per provider", () => {
  assert.deepStrictEqual(cohortsOf(action()), ['claude']);
  assert.deepStrictEqual(cohortsOf(action({ audienceProviders: 'unknown' })), ['unknown']);
  assert.deepStrictEqual(cohortsOf(action({ audienceProviders: [] })), ['unknown']);
  assert.deepStrictEqual(cohortsOf(action({ audienceProviders: ['Codex', 'claude'] })), ['claude', 'codex']);
});

// ── per-lane pairing + section scoping ────────────────────────────────────────

check('same action id across lanes pairs per-lane (occurs in one, dead in the other → mixed)', () => {
  const a1 = action({ id: 'shared' });
  const a2 = action({ id: 'shared' });
  const recs = joinSectionBehavior([
    { actions: [a1], verdicts: [verdict('shared', 'occurs')] },
    { actions: [a2], verdicts: [verdict('shared', 'never', { evidenceState: 'auditable' })] },
  ]);
  assert.strictEqual(recs[0].behaviorStatus, 'mixed');
  assert.strictEqual(recs[0].nodeCounts.total, 2);
});

check('actions with an empty sourceSectionKey belong to no section', () => {
  const a = action({ sourceSectionKey: '' });
  const recs = joinSectionBehavior([{ actions: [a], verdicts: [verdict(a.id, 'occurs')] }]);
  assert.deepStrictEqual(recs, []);
});

// ── annotation: both axes, rollup, disclosure ─────────────────────────────────

function rollupWith(sections: ConfigWeightRollup['sections']): ConfigWeightRollup {
  return { sections, tokensByClass: {} as ConfigWeightRollup['tokensByClass'] };
}

check('observed + structurally-broken → BOTH axes exported (weightClass untouched)', () => {
  const rollup = rollupWith([{
    sourcePath: 'C:/ws/CLAUDE.md', sourceLabel: 'CLAUDE.md', scope: 'agent',
    heading: 'Alpha', startLine: 5, endLine: 8, tokens: 40,
    weightClass: 'structurally-broken', evidence: ['references ./gone.md — file not found'],
    sectionKey: K,
  }]);
  const recs = join([{ status: 'occurs' }]);
  const { rollup: out, joinedSectionCount } = annotateConfigWeight(rollup, recs);
  assert.strictEqual(joinedSectionCount, 1);
  assert.strictEqual(out.sections[0].weightClass, 'structurally-broken', 'structural axis untouched');
  assert.strictEqual(out.sections[0].behaviorStatus, 'live', 'behavior axis exported beside it');
  assert.deepStrictEqual(out.sections[0].evidence, rollup.sections[0].evidence, 'no structural evidence discarded');
});

check('annotate: tokensByBehavior parallel rollup; keyless sections untouched; unmatched keys disclosed', () => {
  const rollup = rollupWith([
    { sourcePath: 'C:/ws/CLAUDE.md', sourceLabel: 'CLAUDE.md', scope: 'agent',
      heading: 'Alpha', startLine: 5, endLine: 8, tokens: 40,
      weightClass: 'insufficient-evidence', evidence: [], sectionKey: K },
    { sourcePath: 'C:/ws/CLAUDE.md', sourceLabel: 'CLAUDE.md', scope: 'agent',
      heading: 'NoKey', startLine: 9, endLine: 12, tokens: 7,
      weightClass: 'unobservable', evidence: [] },
  ]);
  const recs = join([{ status: 'occurs' }]);
  const foreign = { ...recs[0], sectionKey: 'markdown_section:C:/ws/CLAUDE.md:h:guide>gone' };
  const { rollup: out, unmatchedRecordKeys } = annotateConfigWeight(rollup, [...recs, foreign]);

  assert.strictEqual(out.sections[0].behaviorStatus, 'live');
  assert.strictEqual(out.sections[1].behaviorStatus, undefined, 'keyless section makes no behavior claim');
  assert.deepStrictEqual(unmatchedRecordKeys, [foreign.sectionKey], 'partial join disclosed');

  const tb = out.tokensByBehavior!;
  assert.strictEqual(tb.live, 40);
  assert.strictEqual(tb['not-analyzed'], 7, 'un-joined tokens read not-analyzed, never dead');
  assert.strictEqual(tb.dead, 0);
  for (const k of ['live', 'dead', 'mixed', 'unobservable', 'capture-incomplete', 'insufficient-evidence', 'not-analyzed']) {
    assert.ok(k in tb, `bucket ${k} always present`);
  }
});

console.log(`section-liveness: ${passed} checks passed`);
