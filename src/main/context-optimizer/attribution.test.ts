// attribution unit tests (design §6) — the confidence-ladder + shared-cwd honesty.
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/attribution.test.js
//
// Coverage: min() combining; observed-safe minted ONLY for lane-level tool-grant +
// clean dead signal; lane-level guidance section caps at observed; narrower-than-lane
// drops a tier + caveat + inferred cap; legacy/unknown cap at heuristic.

import assert from 'node:assert/strict';
import type { AgentRoleLane } from '../../shared/types';
import type { PredictedAction, PredicateKind, Derivability } from './guidance-action-model';
import type { OccurrenceVerdict, OccurrenceStatus, ConfidenceTier } from './occurrence-classifier';
import {
  scoreAttribution,
  evidenceTierOf,
  type AttributionTarget,
  type TargetGranularity,
  type TargetKind,
  emptyTierBreakdown,
  coverageBand,
  rollUpAttribution,
  nextDrillHint,
  isPerAgentTier,
} from './attribution';
import type { AttributionTier, AttributionTierBreakdown } from '../../shared/types';

// ── fixture builders ─────────────────────────────────────────────────────────

function action(over: Partial<PredictedAction> = {}): PredictedAction {
  return {
    id: 'a1',
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 10 },
    sourceKind: 'tool',
    lanes: ['supervisor'] as AgentRoleLane[],
    kind: 'toolset-usage' as PredicateKind,
    params: { toolset: 'orchestration' },
    derivability: 'exact' as Derivability,
    residentTokens: 100,
    sourceSectionKey: 'markdown_section:/w:sec',
    sourceEpochId: 'e1',
    requiresDerivationGate: true,
    ...over,
  };
}

function verdict(over: Partial<OccurrenceVerdict> = {}): OccurrenceVerdict {
  return {
    actionId: 'a1',
    status: 'never' as OccurrenceStatus,
    occurrences: 0,
    distinctStreams: 4,
    distinctSlugs: 1,
    exposureTurns: 200,
    exposureStreams: 5,
    exposureSlugs: 1,
    confidence: 'observed' as ConfidenceTier,
    epochConfidence: 'high',
    includeSubagents: true,
    predicate: { kind: 'toolset-usage', toolset: 'orchestration' },
    evidenceState: 'unavailable',
    ...over,
  };
}

function target(over: Partial<AttributionTarget> = {}): AttributionTarget {
  return {
    verdict: verdict(),
    granularity: 'lane-level' as TargetGranularity,
    workingDir: 'C:\\w\\.dashboard\\supervisor',
    ...over,
  };
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

// ── evidenceTierOf: the lift + clean-dead-signal promotion ─────────────────────

check('evidence: never + observed confidence → observed-safe (clean dead signal)', () => {
  assert.equal(evidenceTierOf(verdict({ status: 'never', confidence: 'observed' })), 'observed-safe');
});
check('evidence: never + inferred confidence (heuristic derivability) → inferred', () => {
  assert.equal(evidenceTierOf(verdict({ status: 'never', confidence: 'inferred' })), 'inferred');
});
check('evidence: insufficient-exposure watch-item → heuristic', () => {
  assert.equal(evidenceTierOf(verdict({ status: 'insufficient-exposure', confidence: 'heuristic' })), 'heuristic');
});
check('evidence: occurs is NOT promoted to observed-safe (only never is)', () => {
  assert.equal(evidenceTierOf(verdict({ status: 'occurs', confidence: 'observed' })), 'observed');
});

// ── FLAGSHIP: observed-safe minted only for lane-level tool-grant + clean signal ──

check('observed-safe: lane-level tool-grant + exact + never + adequate exposure', () => {
  const s = scoreAttribution(action(), target());
  assert.equal(s.evidenceTier, 'observed-safe');
  assert.equal(s.attributionTier, 'observed-safe');
  assert.equal(s.tier, 'observed-safe');
  assert.equal(s.sharedCwdRisk, 'none');
  assert.equal(s.caveat, undefined);
  assert.equal(s.lane, 'supervisor');
});

check('NOT observed-safe: lane-level GUIDANCE section caps at observed', () => {
  // Same clean dead signal, but the target is a CLAUDE.md prose section, not a grant.
  const a = action({ sourceKind: 'workflow', kind: 'command-family', params: { commandFamily: 'npm' } });
  const s = scoreAttribution(a, target({ verdict: verdict() }));
  assert.equal(s.evidenceTier, 'observed-safe');
  assert.equal(s.attributionTier, 'observed');
  assert.equal(s.tier, 'observed'); // min(observed-safe, observed)
  assert.equal(s.sharedCwdRisk, 'none');
});

check('NOT observed-safe: tool-grant but occurrence occurs → evidence drops (min wins)', () => {
  const s = scoreAttribution(action(), target({ verdict: verdict({ status: 'occurs', occurrences: 3 }) }));
  assert.equal(s.evidenceTier, 'observed');
  assert.equal(s.tier, 'observed');
});

check('explicit targetKind override: guidance-section forces observed even for a tool action', () => {
  const s = scoreAttribution(action(), target({ targetKind: 'guidance-section' as TargetKind }));
  assert.equal(s.attributionTier, 'observed');
  assert.equal(s.tier, 'observed');
});

// ── min() combining: less-confident side wins ─────────────────────────────────

check('min(): evidence inferred + attribution observed-safe → inferred', () => {
  // heuristic derivability → classifier confidence 'inferred' → evidence 'inferred'.
  const s = scoreAttribution(action(), target({ verdict: verdict({ confidence: 'inferred' }) }));
  assert.equal(s.evidenceTier, 'inferred');
  assert.equal(s.attributionTier, 'observed-safe');
  assert.equal(s.tier, 'inferred');
});

check('min(): evidence observed-safe + attribution heuristic (legacy) → heuristic', () => {
  const s = scoreAttribution(action(), target({ workingDir: 'C:\\some\\workspace', lane: undefined }));
  assert.equal(s.evidenceTier, 'observed-safe');
  assert.equal(s.attributionTier, 'heuristic');
  assert.equal(s.tier, 'heuristic');
});

// ── narrower-than-lane: drop a tier + caveat + inferred cap ────────────────────

check('narrower-than-lane: caps at inferred, high risk, caveat with agent count', () => {
  const s = scoreAttribution(
    action(),
    target({ granularity: 'narrower-than-lane', sharedAgentCount: 7 }),
  );
  assert.equal(s.attributionTier, 'inferred');
  assert.equal(s.tier, 'inferred'); // min(observed-safe evidence, inferred) = inferred
  assert.equal(s.sharedCwdRisk, 'high');
  assert.ok(s.caveat, 'caveat must be present');
  assert.match(s.caveat!, /shared-cwd: behavior pooled across 7 agents in this slug/);
  assert.match(s.caveat!, /cannot attribute to a single agent/);
});

check('narrower-than-lane: caveat agent count falls back to verdict.distinctStreams', () => {
  const s = scoreAttribution(
    action(),
    target({ granularity: 'narrower-than-lane', verdict: verdict({ distinctStreams: 4 }) }),
  );
  assert.match(s.caveat!, /pooled across 4 agents/);
});

check('narrower-than-lane never exceeds inferred even with clean dead signal', () => {
  const s = scoreAttribution(action(), target({ granularity: 'narrower-than-lane' }));
  assert.notEqual(s.tier, 'observed-safe');
  assert.notEqual(s.tier, 'observed');
});

// ── legacy / unknown: heuristic cap ───────────────────────────────────────────

check('legacy lane (workspace root, no template tail) caps at heuristic, possible risk', () => {
  const s = scoreAttribution(action(), target({ workingDir: 'C:\\Users\\e\\Projects\\App', lane: undefined }));
  assert.equal(s.lane, 'legacy');
  assert.equal(s.attributionTier, 'heuristic');
  assert.equal(s.tier, 'heuristic');
  assert.equal(s.sharedCwdRisk, 'possible');
  assert.equal(s.caveat, undefined); // caveat is a narrower-than-lane concept only
});

check('unknown lane (unrecognized .dashboard subdir) caps at heuristic, high risk', () => {
  const s = scoreAttribution(action(), target({ workingDir: '/proj/.dashboard/plumber', lane: undefined }));
  assert.equal(s.lane, 'unknown');
  assert.equal(s.attributionTier, 'heuristic');
  assert.equal(s.tier, 'heuristic');
  assert.equal(s.sharedCwdRisk, 'high');
});

// ── lane resolution reuse / fallback ──────────────────────────────────────────

check('lane resolved via laneForWorkingDir (worker template dir)', () => {
  const a = action({ lanes: ['worker'] as AgentRoleLane[] });
  const s = scoreAttribution(a, target({ workingDir: 'C:\\p\\.dashboard\\workers\\claude' }));
  assert.equal(s.lane, 'worker');
  assert.equal(s.attributionTier, 'observed-safe'); // lane-level tool-grant
});

check('lane falls back to action.lanes[] when no workingDir/override', () => {
  const a = action({ lanes: ['researcher'] as AgentRoleLane[] });
  const s = scoreAttribution(a, { verdict: verdict(), granularity: 'lane-level' });
  assert.equal(s.lane, 'researcher');
});

check('lane falls back to unknown when action spans multiple lanes and no override', () => {
  const a = action({ lanes: ['supervisor', 'worker'] as AgentRoleLane[] });
  const s = scoreAttribution(a, { verdict: verdict(), granularity: 'lane-level' });
  assert.equal(s.lane, 'unknown');
  assert.equal(s.tier, 'heuristic');
});

// ── WP-C: coverage PRODUCT (breakdown → rollup → band → firewall) ──────────────

function breakdown(over: Partial<AttributionTierBreakdown> = {}): AttributionTierBreakdown {
  return { ...emptyTierBreakdown(), ...over };
}

check('emptyTierBreakdown is all-zero over the four tiers', () => {
  assert.deepEqual(emptyTierBreakdown(), {
    'agent-attributed': 0,
    'lane-attributed-explicit': 0,
    'lane-inferred-from-current-grant': 0,
    unattributed: 0,
  });
});

check('coverageBand thresholds (>80 direct, 50-80 cautioned, 10-<50 provisional, <10 diagnostic)', () => {
  assert.equal(coverageBand(81), 'direct');
  assert.equal(coverageBand(80), 'cautioned'); // boundary: not > 80
  assert.equal(coverageBand(50), 'cautioned');
  assert.equal(coverageBand(49.9), 'provisional');
  assert.equal(coverageBand(10), 'provisional');
  assert.equal(coverageBand(9.6), 'diagnostic');
  assert.equal(coverageBand(0), 'diagnostic');
});

check('rollUpAttribution: attributedCount is tiers 1-3, coverage rounded to 1 dp (816/1000 → 81.6 direct)', () => {
  const r = rollUpAttribution(breakdown({
    'agent-attributed': 300,
    'lane-attributed-explicit': 400,
    'lane-inferred-from-current-grant': 116,
    unattributed: 184,
  }));
  assert.equal(r.attributedCount, 816);
  assert.equal(r.unattributedCount, 184);
  assert.equal(r.attributionCoveragePct, 81.6);
  assert.equal(r.laneCoverageBand, 'direct');
});

check('rollUpAttribution: 96/1000 → 9.6 diagnostic (the session-only floor shape)', () => {
  const r = rollUpAttribution(breakdown({ 'agent-attributed': 96, unattributed: 904 }));
  assert.equal(r.attributionCoveragePct, 9.6);
  assert.equal(r.laneCoverageBand, 'diagnostic');
});

check('rollUpAttribution: empty breakdown → 0% diagnostic, no divide-by-zero', () => {
  const r = rollUpAttribution(emptyTierBreakdown());
  assert.equal(r.attributedCount, 0);
  assert.equal(r.attributionCoveragePct, 0);
  assert.equal(r.laneCoverageBand, 'diagnostic');
});

check('nextDrillHint reflects the band and cites the unattributed count', () => {
  const direct = rollUpAttribution(breakdown({ 'lane-attributed-explicit': 90, unattributed: 10 }));
  assert.match(nextDrillHint(direct), /filter by lane/);
  const diag = rollUpAttribution(breakdown({ 'agent-attributed': 5, unattributed: 95 }));
  assert.match(nextDrillHint(diag), /coverage diagnostic, not a lane verdict/);
  assert.match(nextDrillHint(diag), /95/);
});

// ── FIREWALL: coverage bands describe LANE claims only, never per-agent ─────────

check('firewall: band namespace is disjoint from the tier namespace', () => {
  const tiers: AttributionTier[] = [
    'agent-attributed', 'lane-attributed-explicit', 'lane-inferred-from-current-grant', 'unattributed',
  ];
  for (const pct of [0, 5, 9.6, 10, 49, 50, 80, 81, 100]) {
    const band = coverageBand(pct);
    assert.ok(!tiers.includes(band as unknown as AttributionTier), `band ${band} must not be a tier name`);
  }
});

check('firewall: isPerAgentTier true only for agent-attributed', () => {
  assert.equal(isPerAgentTier('agent-attributed'), true);
  assert.equal(isPerAgentTier('lane-attributed-explicit'), false);
  assert.equal(isPerAgentTier('lane-inferred-from-current-grant'), false);
  assert.equal(isPerAgentTier('unattributed'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
