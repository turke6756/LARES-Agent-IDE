// outcome-tracker unit tests (A4 — hardening-epochs-outcomes §4–§5).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/outcome-tracker.test.js
//
// Coverage: predicate snapshot + `target_predicate_hash` immutability/overlap; the five
// §5 reconciliation states (matched / applied_variant / relocated / not_detected /
// target_mismatch); one action closing TWO epochs → two links; after-window anchored at
// the DETECTED epoch close (not the click); bounded before/after windows + overlap caps;
// per-100-turns normalization; NON-VACUOUS SUBTRACT regret (before≈0 gate rejects a
// noisy-before section); both TUNE success directions; RELOCATE regret;
// insufficient-outcome-exposure + confounded guards.

import assert from 'node:assert/strict';
import type { ContextOptimizerProposal, ContextOptimizerProposalKind } from '../../shared/types';
import {
  buildOptimizerActionTarget,
  reconcileAction,
  computeOutcomeWindows,
  toRates,
  assessOutcome,
  type BuildActionTargetInput,
  type EpochTransition,
  type WindowMetric,
  type WindowRates,
} from './outcome-tracker';
import { OPTIMIZER_CONFIG } from './optimizer-config';

// ── fixture builders ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed clock; the module never reads a real one

function proposalTarget(
  over: Partial<ContextOptimizerProposal['target']> = {},
): ContextOptimizerProposal['target'] {
  return { absPath: '/w/.dashboard/supervisor/CLAUDE.md', lineStart: 40, lineEnd: 60,
           lane: 'supervisor', mutable: 'scaffold-managed', ...over };
}

function buildInput(over: Partial<BuildActionTargetInput> = {}): BuildActionTargetInput {
  return {
    proposal: { kind: 'subtract-dead-guidance', target: proposalTarget() },
    lane: 'supervisor',
    watchLanes: ['supervisor'],
    includeSubagents: false,
    proposedEdit: { summary: 'remove dead ## Teams section' },
    epochRefs: [{ sectionKey: 'markdown_section:sup:sentinel:teams', epochId: 'e-teams',
                  contentHash: 'H_TEAMS', sourcePath: '/w/.dashboard/supervisor/CLAUDE.md' }],
    predictedActions: [{ id: 'pa1', kind: 'command-family', params: { family: 'gws' }, derivability: 'exact' }],
    ...over,
  };
}

function metric(over: Partial<WindowMetric> = {}): WindowMetric {
  return { occ: 0, streams: 0, exposureTurns: 100, ...over };
}
function rates(over: Partial<WindowMetric> = {}): WindowRates {
  return toRates(metric(over));
}

function transition(over: Partial<EpochTransition> = {}): EpochTransition {
  return { epochId: 'e-teams', sectionKey: 'markdown_section:sup:sentinel:teams',
           closedContentHash: 'H_TEAMS', closedAtMs: T0 + DAY, lastSeenReason: 'removed', ...over };
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

// ── §4.2 snapshot + target_predicate_hash ──────────────────────────────────────

check('snapshot: freezes matchers, expect direction, and includeSubagents basis', () => {
  const { target } = buildOptimizerActionTarget(buildInput());
  assert.equal(target.schemaVersion, 1);
  assert.equal(target.actionKind, 'subtract-dead-guidance');
  assert.equal(target.watch.predicateKind, 'predicted_action');
  assert.equal(target.watch.includeSubagents, false); // Bug-4: matches the verdict basis
  assert.equal(target.watch.minOutcomeTurns, OPTIMIZER_CONFIG.MIN_EXPOSURE_TURNS);
  assert.deepEqual(target.watch.expect, { subtractStaysCold: true });
  assert.equal(target.predictedActions.length, 1); // self-contained — no recompile needed
});

check('snapshot: SUBTRACT survives deleted guidance — matchers re-runnable without the source', () => {
  // The source section is gone; the snapshot still carries the matcher verbatim, so a
  // later recompute never consults the compiler (test 18).
  const { target } = buildOptimizerActionTarget(buildInput());
  assert.equal(target.predictedActions[0].params.family, 'gws');
  assert.equal(target.epochRefs[0].contentHash, 'H_TEAMS');
});

check('predicate hash: identical matchers → identical hash (overlap/supersession key, §4.6)', () => {
  const a = buildOptimizerActionTarget(buildInput({ proposedEdit: { summary: 'phrasing A' } }));
  const b = buildOptimizerActionTarget(buildInput({ proposedEdit: { summary: 'totally different phrasing B' } }));
  // proposedEdit is NOT in the hash basis — only the runnable matchers are.
  assert.equal(a.targetPredicateHash, b.targetPredicateHash);
});

check('predicate hash: different matcher params → different hash', () => {
  const a = buildOptimizerActionTarget(buildInput());
  const b = buildOptimizerActionTarget(buildInput({
    predictedActions: [{ id: 'pa1', kind: 'command-family', params: { family: 'jq' }, derivability: 'exact' }],
  }));
  assert.notEqual(a.targetPredicateHash, b.targetPredicateHash);
});

check('snapshot: toolset SUBTRACT watches the grant; TUNE with a skill watches the trigger', () => {
  const ts = buildOptimizerActionTarget(buildInput({
    proposal: { kind: 'subtract-unused-toolset', target: proposalTarget() },
    toolset: { lane: 'supervisor', toolset: 'orchestration', memberToolNames: ['x'], grantHash: 'G' },
  }));
  assert.equal(ts.target.watch.predicateKind, 'toolset_grant');
  const tune = buildOptimizerActionTarget(buildInput({
    proposal: { kind: 'tune-skill-trigger', target: proposalTarget() },
    skill: { skillName: 'read-comments', skillPath: '/s', ownedScriptGlobs: [] },
  }));
  assert.equal(tune.target.watch.predicateKind, 'skill_trigger');
  assert.deepEqual(tune.target.watch.expect, { skillRises: true, bypassFalls: true });
});

// ── §5 reconciliation — the five states ────────────────────────────────────────

check('reconcile matched: after_start is the DETECTED epoch close, not the click', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0,
    target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's' } },
    transitions: [transition({ closedAtMs: T0 + 6 * HOUR })], nowMs: T0 + 3 * DAY,
  });
  assert.equal(r.status, 'matched');
  assert.equal(r.afterStartMs, T0 + 6 * HOUR); // the epoch close, NOT T0
  assert.notEqual(r.afterStartMs, T0);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].relation, 'closed');
  assert.equal(r.links[0].confidence, 'exact');
  assert.equal(r.reDeriveMatchers, false);
});

check('reconcile applied_variant: section reworded to a NON-proposed hash → re-derive matchers', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0,
    target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's', afterHash: 'H_PROPOSED' } },
    transitions: [transition({ openedContentHash: 'H_HUMAN_EDIT', lastSeenReason: 'edited' })],
    nowMs: T0 + DAY,
  });
  assert.equal(r.status, 'applied_variant');
  assert.equal(r.reDeriveMatchers, true); // keep snapshot AND measure the human's actual edit
  assert.equal(r.links[0].relation, 'touched');
  assert.equal(r.links[0].confidence, 'variant');
  assert.equal(r.afterStartMs, T0 + DAY); // still anchored at the detected close
});

check('reconcile relocated: moved_to_section_key preserves lineage, watches bypass', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0, target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's' } },
    transitions: [transition({ movedToSectionKey: 'skill_body:teams', lastSeenReason: 'moved_cross_target' })],
    nowMs: T0 + DAY,
  });
  assert.equal(r.status, 'relocated');
  assert.equal(r.links[0].confidence, 'variant');
  assert.equal(r.afterStartMs, T0 + DAY);
});

check('reconcile not_detected: no on-disk change → NO after-window, no verdict', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0, target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's' } },
    transitions: [], nowMs: T0 + DAY,
  });
  assert.equal(r.status, 'not_detected');
  assert.equal(r.afterStartMs, null);
  assert.equal(r.detectedAtMs, null);
  assert.equal(r.links.length, 0);
});

check('reconcile target_mismatch: a DIFFERENT section changed → mismatch link, no verdict', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0, target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's' } },
    transitions: [transition({ epochId: 'e-other', sectionKey: 'markdown_section:sup:sentinel:notebooks' })],
    nowMs: T0 + DAY,
  });
  assert.equal(r.status, 'target_mismatch');
  assert.equal(r.afterStartMs, null);
  assert.equal(r.links[0].relation, 'mismatch');
  assert.equal(r.links[0].confidence, 'mismatch');
});

check('reconcile multi-epoch: one action closing TWO epochs writes TWO links (QW3)', () => {
  const epochRefs = [
    { sectionKey: 'sk:teams', epochId: 'e-teams', contentHash: 'H_TEAMS', sourcePath: '/w/CLAUDE.md' },
    { sectionKey: 'sk:notebooks', epochId: 'e-nb', contentHash: 'H_NB', sourcePath: '/w/CLAUDE.md' },
  ];
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0, target: { epochRefs, proposedEdit: { summary: 's' } },
    transitions: [
      transition({ epochId: 'e-teams', sectionKey: 'sk:teams', closedContentHash: 'H_TEAMS', closedAtMs: T0 + 6 * HOUR }),
      transition({ epochId: 'e-nb', sectionKey: 'sk:notebooks', closedContentHash: 'H_NB', closedAtMs: T0 + 12 * HOUR }),
    ],
    nowMs: T0 + 3 * DAY,
  });
  assert.equal(r.status, 'matched');
  assert.equal(r.links.length, 2);
  assert.equal(r.afterStartMs, T0 + 12 * HOUR); // opens once BOTH targeted epochs are closed
});

check('reconcile: a transition outside APPLY_RECONCILE_WINDOW_MS is ignored', () => {
  const r = reconcileAction({
    actionId: 'act1', appliedAtMs: T0, target: { epochRefs: buildInput().epochRefs, proposedEdit: { summary: 's' } },
    transitions: [transition({ closedAtMs: T0 + 5 * DAY })], // way past the 24h window
    nowMs: T0 + 6 * DAY,
  });
  assert.equal(r.status, 'not_detected');
});

// ── §4.3 windows ───────────────────────────────────────────────────────────────

check('windows: before is bounded + epoch-floored; after opens at detected close', () => {
  const w = computeOutcomeWindows({
    appliedAtMs: T0, afterStartMs: T0 + DAY, epochFirstSeenMs: T0 - 60 * DAY, nowMs: T0 + 10 * DAY,
  });
  assert.equal(w.before.hi, T0);
  assert.equal(w.before.lo, T0 - OPTIMIZER_CONFIG.OUTCOME_WINDOW_DAYS * DAY); // bounded, not the (older) birthday
  assert.ok(w.after);
  assert.equal(w.after!.lo, T0 + DAY); // detected close, not the click
  assert.equal(w.after!.hi, T0 + 10 * DAY);
});

check('windows: before floored at a young epoch birthday', () => {
  const w = computeOutcomeWindows({
    appliedAtMs: T0, afterStartMs: T0 + DAY, epochFirstSeenMs: T0 - 3 * DAY, nowMs: T0 + DAY,
  });
  assert.equal(w.before.lo, T0 - 3 * DAY); // birthday wins over the (older) window bound
});

check('windows: afterStart null (not_detected) → after window is null', () => {
  const w = computeOutcomeWindows({ appliedAtMs: T0, afterStartMs: null, epochFirstSeenMs: T0 - DAY, nowMs: T0 + DAY });
  assert.equal(w.after, null);
});

check('windows: overlap/re-add caps the after window (§4.6)', () => {
  const w = computeOutcomeWindows({
    appliedAtMs: T0, afterStartMs: T0 + DAY, epochFirstSeenMs: T0 - DAY, nowMs: T0 + 100 * DAY,
    nextOverlappingActionAtMs: T0 + 5 * DAY, epochReaddedAtMs: T0 + 3 * DAY,
  });
  assert.equal(w.after!.hi, T0 + 3 * DAY); // earliest cap wins
});

// ── §4.4 per-100-turns normalization ───────────────────────────────────────────

check('rates: normalized per-100-turns; a 5× turn-volume gap compares correctly (test 19)', () => {
  // Raw counts would say "after has MORE" (6 vs 5); rates say after is COLDER.
  const before = toRates({ occ: 5, streams: 3, exposureTurns: 100 });  // 5.0 / 100
  const after = toRates({ occ: 6, streams: 3, exposureTurns: 500 });   // 1.2 / 100
  assert.equal(before.ratePer100, 5);
  assert.equal(after.ratePer100, 1.2);
  assert.ok(after.ratePer100 < before.ratePer100); // the raw-count path would misfire
});

check('rates: zero exposure → zero rate (no divide-by-zero)', () => {
  assert.equal(toRates({ occ: 3, streams: 1, exposureTurns: 0 }).ratePer100, 0);
});

// ── §4.5 assessment — NON-VACUOUS regret ───────────────────────────────────────

check('SUBTRACT regret: before≈0, after ≥ 0.5/100 with ≥3 occ / ≥2 streams → suggest-revert', () => {
  const a = assessOutcome({
    kind: 'subtract-dead-guidance',
    before: rates({ occ: 0, streams: 0, exposureTurns: 200 }),
    after: rates({ occ: 4, streams: 2, exposureTurns: 200 }), // 2.0/100
  });
  assert.equal(a.verdict, 'suggest-revert');
});

check('SUBTRACT regret is NON-VACUOUS: a noisy-before section never regrets', () => {
  // Same alarming after-rate, but before was NOT cold → the before≈0 gate rejects it.
  const a = assessOutcome({
    kind: 'subtract-dead-guidance',
    before: rates({ occ: 10, streams: 3, exposureTurns: 200 }),
    after: rates({ occ: 4, streams: 2, exposureTurns: 200 }),
  });
  assert.equal(a.verdict, 'no-regret');
});

check('SUBTRACT: below the occurrence/stream floor stays silent (one tic ≠ revert)', () => {
  const a = assessOutcome({
    kind: 'subtract-dead-guidance',
    before: rates({ occ: 0, streams: 0, exposureTurns: 200 }),
    after: rates({ occ: 2, streams: 1, exposureTurns: 200 }), // 2 occ / 1 stream — below floors
  });
  assert.equal(a.verdict, 'success'); // stayed effectively cold — no regression
});

check('SUBTRACT: cold before + cold after → success (stayed cold)', () => {
  const a = assessOutcome({
    kind: 'subtract-dead-guidance',
    before: rates({ occ: 0, streams: 0, exposureTurns: 200 }),
    after: rates({ occ: 0, streams: 0, exposureTurns: 200 }),
  });
  assert.equal(a.verdict, 'success');
});

check('guard: < REGRET_MIN_AFTER_TURNS after-exposure → insufficient-outcome-exposure', () => {
  const a = assessOutcome({
    kind: 'subtract-dead-guidance',
    before: rates({ occ: 0, exposureTurns: 200 }),
    after: rates({ occ: 5, streams: 3, exposureTurns: 5 }), // below the floor
  });
  assert.equal(a.verdict, 'insufficient-outcome-exposure');
});

check('guard: confounded overlap → confounded, no verdict', () => {
  const a = assessOutcome({
    kind: 'subtract-dead-guidance', confounded: true,
    before: rates({ occ: 0, exposureTurns: 200 }), after: rates({ occ: 5, streams: 3, exposureTurns: 200 }),
  });
  assert.equal(a.verdict, 'confounded');
});

check('TUNE success direction A: bypass down ≥50% → success', () => {
  const a = assessOutcome({
    kind: 'tune-skill-trigger',
    before: rates({ occ: 20, streams: 4, exposureTurns: 200 }), // 10/100
    after: rates({ occ: 8, streams: 3, exposureTurns: 200 }),   // 4/100 — down 60%
    beforeSkill: rates({ occ: 1, exposureTurns: 200 }), afterSkill: rates({ occ: 1, exposureTurns: 200 }),
  });
  assert.equal(a.verdict, 'success');
});

check('TUNE success direction B: skill up ≥50% (bypass flat) → success', () => {
  const a = assessOutcome({
    kind: 'tune-skill-trigger',
    before: rates({ occ: 10, streams: 3, exposureTurns: 200 }),
    after: rates({ occ: 10, streams: 3, exposureTurns: 200 }), // bypass flat
    beforeSkill: rates({ occ: 4, exposureTurns: 200 }),        // 2/100
    afterSkill: rates({ occ: 8, exposureTurns: 200 }),         // 4/100 — up 100%
  });
  assert.equal(a.verdict, 'success');
});

check('TUNE rework: neither path moved ≥50% → rework', () => {
  const a = assessOutcome({
    kind: 'tune-skill-trigger',
    before: rates({ occ: 10, streams: 3, exposureTurns: 200 }),
    after: rates({ occ: 9, streams: 3, exposureTurns: 200 }),  // down 10%
    beforeSkill: rates({ occ: 4, exposureTurns: 200 }), afterSkill: rates({ occ: 4, exposureTurns: 200 }), // flat
  });
  assert.equal(a.verdict, 'rework');
});

check('ADD rework: cluster did not shrink (after ≥ before·0.8) → rework', () => {
  const a = assessOutcome({
    kind: 'add-improvisation-support',
    before: rates({ occ: 10, streams: 3, exposureTurns: 200 }),
    after: rates({ occ: 9, streams: 3, exposureTurns: 200 }), // 90% — didn't shrink enough
  });
  assert.equal(a.verdict, 'rework');
});

check('ADD success: cluster shrank below the floor', () => {
  const a = assessOutcome({
    kind: 'add-improvisation-support',
    before: rates({ occ: 10, streams: 3, exposureTurns: 200 }),
    after: rates({ occ: 2, streams: 1, exposureTurns: 200 }), // 20% — well below 80%
  });
  assert.equal(a.verdict, 'success');
});

check('RELOCATE regret: bypass rose AND skill use did not → suggest-revert (needed resident)', () => {
  const a = assessOutcome({
    kind: 'relocate-to-progressive-disclosure',
    before: rates({ occ: 4, streams: 2, exposureTurns: 200 }),
    after: rates({ occ: 10, streams: 3, exposureTurns: 200 }), // bypass rose
    beforeSkill: rates({ occ: 5, exposureTurns: 200 }), afterSkill: rates({ occ: 5, exposureTurns: 200 }), // skill flat
  });
  assert.equal(a.verdict, 'suggest-revert');
});

check('RELOCATE success: bypass rose but skill use also rose', () => {
  const a = assessOutcome({
    kind: 'relocate-to-progressive-disclosure',
    before: rates({ occ: 4, streams: 2, exposureTurns: 200 }),
    after: rates({ occ: 6, streams: 3, exposureTurns: 200 }),
    beforeSkill: rates({ occ: 2, exposureTurns: 200 }), afterSkill: rates({ occ: 6, exposureTurns: 200 }), // skill rose
  });
  assert.equal(a.verdict, 'success');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
