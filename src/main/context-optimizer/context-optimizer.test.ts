// context-optimizer unit tests (design §7–§9 / master WP6b).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/context-optimizer.test.js
//
// Coverage: the four levers (subtract-unused-toolset / subtract-dead-guidance /
// add-improvisation-support / tune-skill-trigger + tune-split-section +
// relocate-to-progressive-disclosure); HARD tier grouping (a high-token guess never
// outranks a low-token certainty); tokenTurnsWeight ranking within a tier;
// epochConfidence down-rank within tier; the derivation-gate flow (occurrence-derived
// → candidate-unverified + suppressed; cluster/bypass → actionable, never suppressed);
// "Not analyzable" section; file-heat rollup passthrough; per-100-turns cost
// normalization; capstone mapping registry; and byte-identical determinism.

import assert from 'node:assert/strict';
import type { AgentRoleLane, PersonaLane, ResidentAssetUsage } from '../../shared/types';
import type { PredictedAction, PredicateKind, Derivability } from './guidance-action-model';
import type { OccurrenceVerdict, OccurrenceStatus } from './occurrence-classifier';
import type { DriftFinding } from './config-drift';
import type { ImprovisationCandidate } from './improvisation-clusters';
import type { BypassProposal, BypassResult, FileCoverageResult, FileHeatEntry } from './file-coverage';
import type { DerivationVerifiedResult } from './compiler-parity-gate';
import {
  generateContextOptimizerProposals,
  behavioralNeedTriggers,
  CAPSTONE_KIND_MAP,
  safetyRouteFor,
  leverFor,
  type LaneOptimizerInput,
  type LaneResidentSummary,
} from './context-optimizer';
import { proposalHasActionableContent } from '../../shared/context-optimizer-policy';

// ── fixtures ─────────────────────────────────────────────────────────────────

function action(over: Partial<PredictedAction> & { id: string }): PredictedAction {
  return {
    source: { absPath: 'C:/ws/.dashboard/supervisor/CLAUDE.md', line: 10 },
    sourceKind: 'capability',
    lanes: ['supervisor'],
    kind: 'path-touch' as PredicateKind,
    params: {},
    derivability: 'exact' as Derivability,
    residentTokens: 100,
    sourceSectionKey: 'sec-A',
    sourceEpochId: 'ep-A',
    requiresDerivationGate: true,
    ...over,
  };
}

function verdict(over: Partial<OccurrenceVerdict> & { actionId: string }): OccurrenceVerdict {
  return {
    status: 'never' as OccurrenceStatus,
    occurrences: 0,
    distinctStreams: 0,
    distinctSlugs: 0,
    exposureTurns: 100,
    exposureStreams: 5,
    exposureSlugs: 3,
    confidence: 'observed',
    epochConfidence: 'high',
    includeSubagents: true,
    predicate: null,
    evidenceState: 'unavailable',
    ...over,
  };
}

const cleanDerivation: DerivationVerifiedResult = {
  lane: 'supervisor', verified: false, state: 'unverified', staleReasons: [],
};
const verifiedDerivation: DerivationVerifiedResult = {
  lane: 'supervisor', verified: true, state: 'verified', staleReasons: [], verifiedAsOf: '2026-07-01T00:00:00.000Z',
};

const resident: LaneResidentSummary = {
  residentTokens: 5000, claude: 3000, mcp: 1800, skillHeaders: 200,
  exposureTurns: 100, exposureStreams: 5, exposureSlugs: 3,
};

function lane(over: Partial<LaneOptimizerInput>): LaneOptimizerInput {
  return {
    lane: 'supervisor',
    resident,
    actions: [],
    verdicts: [],
    clusters: [],
    bypass: { proposals: [], watchItems: [] },
    drift: [],
    derivation: cleanDerivation,
    ...over,
  };
}

function run(over: Partial<LaneOptimizerInput>) {
  return generateContextOptimizerProposals({
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    lanes: [lane(over)],
  });
}

function heat(over: Partial<FileHeatEntry> & { pathHash: string }): FileHeatEntry {
  return {
    pathDisplay: '<supervisor>/foo.py', coverage: 'uncovered',
    reads: 1, writes: 0, executes: 3, distinctStreams: 2, ...over,
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
}

// ── subtract-dead-guidance ─────────────────────────────────────────────────────

check('subtract-dead-guidance: all exact `never`, none unobservable → one SUBTRACT card', () => {
  const a1 = action({ id: 'a1', residentTokens: 300, sourceSectionKey: 'sec-dead' });
  const a2 = action({ id: 'a2', residentTokens: 300, sourceSectionKey: 'sec-dead', source: { absPath: a1.source.absPath, line: 14 } });
  const res = run({ actions: [a1, a2], verdicts: [verdict({ actionId: 'a1' }), verdict({ actionId: 'a2' })] });
  const dead = res.proposals.filter((p) => p.kind === 'subtract-dead-guidance');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].occurrence, 'never');
  assert.equal(dead[0].lever, 'subtract');
  assert.equal(dead[0].residentTokenDelta.basis, 'remove-resident');
  assert.equal(dead[0].residentTokenDelta.estimate, 300);
  assert.equal(dead[0].tokenTurnsWeight, 300 * 100);
  assert.equal(dead[0].confidence, 'observed-safe'); // never + observed → observed-safe
  assert.equal(dead[0].costEvidence?.residentTokensTimesExposure, 300 * 100);
});

check('subtract-dead-guidance: NOT emitted when a section member is unobservable', () => {
  const a1 = action({ id: 'a1', sourceSectionKey: 'sec-mix' });
  const a2 = action({ id: 'a2', sourceSectionKey: 'sec-mix', derivability: 'unmatchable', requiresDerivationGate: false });
  const res = run({
    actions: [a1, a2],
    verdicts: [verdict({ actionId: 'a1' }), verdict({ actionId: 'a2', status: 'unobservable', unobservableReason: 'unmatchable' })],
  });
  assert.equal(res.proposals.filter((p) => p.kind === 'subtract-dead-guidance').length, 0);
});

// ── subtract-unused-toolset (flagship) ─────────────────────────────────────────

check('subtract-unused-toolset: toolset grant `never` → whole-toolset SUBTRACT with server.total delta', () => {
  const a = action({
    id: 'orch', kind: 'toolset-usage', params: { toolset: 'orchestration' },
    residentTokens: 40, sourceSectionKey: '',
  });
  const res = run({
    actions: [a],
    verdicts: [verdict({ actionId: 'orch' })],
    toolsetResidentTokens: { orchestration: 9000 },
  });
  const t = res.proposals.filter((p) => p.kind === 'subtract-unused-toolset');
  assert.equal(t.length, 1);
  assert.equal(t[0].residentTokenDelta.estimate, 9000);       // server.total, not the action token
  assert.equal(t[0].tokenTurnsWeight, 9000 * 100);
  assert.equal(t[0].target.mcpToolset, 'orchestration');
  assert.equal(t[0].confidence, 'observed-safe');
});

// ── HARD tier grouping ─────────────────────────────────────────────────────────

check('hard tier groups: a low-token observed-safe certainty outranks a high-token inferred guess', () => {
  // observed-safe, tiny weight
  const safe = action({ id: 'safe', residentTokens: 10, sourceSectionKey: 'sec-safe' });
  // inferred (injected verdict confidence), huge weight — still exact-derivable.
  const guess = action({ id: 'guess', residentTokens: 9000, sourceSectionKey: 'sec-guess' });
  const res = run({
    actions: [safe, guess],
    verdicts: [
      verdict({ actionId: 'safe' }),                              // never+observed → observed-safe
      verdict({ actionId: 'guess', confidence: 'inferred' }),      // never+inferred → inferred
    ],
  });
  assert.equal(res.proposals[0].confidence, 'observed-safe');
  assert.equal(res.proposals[0].id.includes('safe'), true);
  assert.ok(res.proposals[0].tokenTurnsWeight < res.proposals[1].tokenTurnsWeight,
    'the certainty ranks first DESPITE a smaller weight — tiers never blend');
  assert.equal(res.proposals[1].confidence, 'inferred');
});

check('within a tier, higher tokenTurnsWeight ranks first', () => {
  const big = action({ id: 'big', residentTokens: 500, sourceSectionKey: 'sec-big' });
  const small = action({ id: 'small', residentTokens: 50, sourceSectionKey: 'sec-small' });
  const res = run({ actions: [big, small], verdicts: [verdict({ actionId: 'big' }), verdict({ actionId: 'small' })] });
  // both observed-safe → weight decides
  assert.equal(res.proposals[0].tokenTurnsWeight, 500 * 100);
  assert.equal(res.proposals[1].tokenTurnsWeight, 50 * 100);
});

check('epochConfidence low down-ranks within its tier', () => {
  // two observed-safe SUBTRACTs with EQUAL weight; the low-epoch one sorts last.
  const hi = action({ id: 'hi', residentTokens: 100, sourceSectionKey: 'sec-hi' });
  const lo = action({ id: 'lo', residentTokens: 100, sourceSectionKey: 'sec-lo' });
  const res = run({
    actions: [hi, lo],
    verdicts: [verdict({ actionId: 'hi', epochConfidence: 'high' }), verdict({ actionId: 'lo', epochConfidence: 'low' })],
  });
  assert.equal(res.proposals[0].epochConfidence, 'high');
  assert.equal(res.proposals[1].epochConfidence, 'low');
});

// ── derivation gate flow ───────────────────────────────────────────────────────

check('occurrence-derived proposal is candidate-unverified + suppressed when the gate is unverified', () => {
  const a = action({ id: 'a', sourceSectionKey: 'sec-g', requiresDerivationGate: true });
  const res = run({ actions: [a], verdicts: [verdict({ actionId: 'a' })], derivation: cleanDerivation });
  const p = res.proposals[0];
  assert.equal(p.verification.requiresDerivationGate, true);
  assert.equal(p.derivationVerified, false);
  assert.equal(p.actionability, 'candidate-unverified');
  assert.equal(p.suppressedFromAgentSurface, true);
  assert.equal(res.meta.unverifiedSuppressedCount, 1);
});

check('occurrence-derived proposal is actionable + not suppressed once the gate is verified', () => {
  const a = action({ id: 'a', sourceSectionKey: 'sec-g' });
  const res = run({ actions: [a], verdicts: [verdict({ actionId: 'a' })], derivation: verifiedDerivation });
  const p = res.proposals[0];
  assert.equal(p.derivationVerified, true);
  assert.equal(p.actionability, 'actionable');
  assert.equal(p.suppressedFromAgentSurface, false);
});

check('bypass tune card is gate-exempt: actionable + never suppressed even under an unverified gate', () => {
  const res = run({ bypass: bypassResult(), derivation: cleanDerivation });
  const tune = res.proposals.find((p) => p.kind === 'tune-skill-trigger')!;
  assert.equal(tune.verification.requiresDerivationGate, false);
  assert.equal(tune.actionability, 'actionable');
  assert.equal(tune.suppressedFromAgentSurface, false);
});

// ── tune-skill-trigger (read-comments class) ───────────────────────────────────

function bypassResult(): BypassResult {
  const bp: BypassProposal = {
    kind: 'tune-skill-trigger', skillName: 'read-comments', lane: 'worker',
    scriptPath: 'c:/ws/.claude/skills/read-comments/read-comments.py',
    matchConfidence: 'exact', execCount: 24, execStreams: 24, skillStreams: 5,
    citedStreams: ['s1', 's2', 's3'], disclosedSubagentExecs: 2,
    triggerMutability: 'user-owned', requiresDerivationGate: false,
  };
  return { proposals: [bp], watchItems: [] };
}

check('tune-skill-trigger: read-comments case → header-only, cites streams, discloses subagent execs', () => {
  const res = run({ lane: 'worker', bypass: bypassResult() });
  const tune = res.proposals.find((p) => p.kind === 'tune-skill-trigger')!;
  assert.equal(tune.lever, 'tune');
  assert.equal(tune.residentTokenDelta.basis, 'header-only');
  assert.equal(tune.tokenTurnsWeight, 0);              // skills are never token-motivated
  assert.equal(tune.target.skillName, 'read-comments');
  assert.equal(tune.target.mutable, 'user-owned');
  assert.equal(tune.confidence, 'observed');            // exact match
  assert.equal(tune.citations.length, 3);
  assert.match(tune.costEvidence?.note ?? '', /subagent execs excluded/);
});

check('tune-skill-trigger: A8 cost evidence normalized per-100-turns when injected', () => {
  const res = run({
    lane: 'worker',
    bypass: bypassResult(),
    cost: { bypassCostByScript: { 'c:/ws/.claude/skills/read-comments/read-comments.py': {
      improvisedTokensPerSession: 500, skillTokensPerInvocation: 120, sessionsSampled: 10 } } },
  });
  const tune = res.proposals.find((p) => p.kind === 'tune-skill-trigger')!;
  // 500 * 10 sessions = 5000 raw over 100 exposure turns → per-100-turns = 5000
  assert.equal(tune.costEvidence?.improvisedPathTokensPer100Turns, 5000);
  assert.equal(tune.costEvidence?.skillPathTokensPerInvocation, 120);
});

// ── add-improvisation-support ──────────────────────────────────────────────────

check('add-improvisation-support: an uncovered cluster over the floor → ADD card (gate-exempt)', () => {
  const c: ImprovisationCandidate = { lane: 'supervisor', dimension: 'command_family', key: 'gh pr', count: 9, distinctStreams: 4, expectedSaving: 1200 };
  const res = run({ clusters: [c] });
  const add = res.proposals.find((p) => p.kind === 'add-improvisation-support')!;
  assert.equal(add.lever, 'add');
  assert.equal(add.residentTokenDelta.basis, 'add-resident');
  assert.equal(add.verification.requiresDerivationGate, false);
  assert.equal(add.suppressedFromAgentSurface, false);
  assert.equal(add.costEvidence?.improvisedPathTokensPer100Turns, Math.round((1200 / 100) * 100));
});

check('add-improvisation-support: below the recurrence/stream floor → dropped', () => {
  const c: ImprovisationCandidate = { lane: 'supervisor', dimension: 'command_family', key: 'x', count: 2, distinctStreams: 1, expectedSaving: 0 };
  const res = run({ clusters: [c] });
  assert.equal(res.proposals.filter((p) => p.kind === 'add-improvisation-support').length, 0);
});

// ── config-drift ───────────────────────────────────────────────────────────────

check('config-drift: decommissioned → SUBTRACT; undocumented grant → ADD; both observed-safe, gate-exempt', () => {
  const drift: DriftFinding[] = [
    { kind: 'documented-but-decommissioned', lane: 'supervisor', toolset: 'old', toolName: 'gone', evidenceTier: 'observed-safe', detail: 'tool vanished', sources: [{ absPath: 'C:/ws/CLAUDE.md', line: 4 }] },
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'newgrant', evidenceTier: 'observed-safe', detail: 'granted, undocumented', sources: [] },
  ];
  // WP-2A honest gating: a grant-mismatch subtract requires a positive resident-section
  // token estimate (no zero-weight dead-guidance fallback), so wire the sizing seams.
  // R2 WP-4B (Step 1): granted-but-undocumented ADD now demotes to a config-completeness
  // note UNLESS a behavioral need triggers — inject one so the ADD still emits (this test's
  // subject is the ADD's shape, not the demotion; the demotion is covered by its own tests).
  const res = run({ drift, residentSectionTextAt: () => 'x'.repeat(500), estimateTokens: (t) => t.length, behavioralNeedFor: () => ({ discoverabilityFailures: 2 }) });
  const sub = res.proposals.find((p) => p.kind === 'subtract-grant-mismatch' && p.id.includes('drift'))!;
  const add = res.proposals.find((p) => p.kind === 'add-missing-guidance')!;
  assert.equal(sub.confidence, 'observed-safe');
  assert.equal(sub.verification.requiresDerivationGate, false);
  assert.equal(add.lever, 'add');
});

// ── BUG-43: drift proposal ids unique + lane-correct ────────────────────────────

check('BUG-43: two lanes each granted an undocumented toolset `foo` → one proposal per lane, all ids unique', () => {
  const mkDrift = (l: PersonaLane): DriftFinding[] => [
    { kind: 'granted-but-undocumented', lane: l, toolset: 'foo', evidenceTier: 'observed-safe', detail: 'granted, undocumented', sources: [] },
  ];
  const res = generateContextOptimizerProposals({
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    lanes: [
      lane({ lane: 'worker', drift: mkDrift('worker'), behavioralNeedFor: () => ({ discoverabilityFailures: 2 }) }),
      lane({ lane: 'researcher', drift: mkDrift('researcher'), behavioralNeedFor: () => ({ discoverabilityFailures: 2 }) }),
    ],
  });
  const ids = res.proposals.map((p) => p.id);
  assert.equal(ids.filter((id) => id === 'drift:granted-but-undocumented:worker:foo').length, 1);
  assert.equal(ids.filter((id) => id === 'drift:granted-but-undocumented:researcher:foo').length, 1);
  assert.equal(new Set(ids).size, ids.length, 'all proposal ids are unique');
});

check('BUG-43 engine belt: a lane carrying cross-lane drift findings still yields unique ids', () => {
  // Simulate the pre-fix state where lane.drift held findings for other lanes too:
  // both mint the same `drift:...:worker:foo` id (id uses lane.lane) → the engine belt
  // must collapse them to exactly one row.
  const drift: DriftFinding[] = [
    { kind: 'granted-but-undocumented', lane: 'worker', toolset: 'foo', evidenceTier: 'observed-safe', detail: 'x', sources: [] },
    { kind: 'granted-but-undocumented', lane: 'researcher', toolset: 'foo', evidenceTier: 'observed-safe', detail: 'x', sources: [] },
  ];
  const res = run({ lane: 'worker', drift, behavioralNeedFor: () => ({ discoverabilityFailures: 2 }) });
  const ids = res.proposals.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids collapsed by the engine belt');
  assert.equal(ids.filter((id) => id === 'drift:granted-but-undocumented:worker:foo').length, 1);
});

// ── tune-split-section / relocate ──────────────────────────────────────────────

check('tune-split-section: mixed occurs + never (small section) → split, capped at inferred', () => {
  const on = action({ id: 'on', residentTokens: 80, sourceSectionKey: 'sec-mixed' });
  const off = action({ id: 'off', residentTokens: 80, sourceSectionKey: 'sec-mixed', source: { absPath: on.source.absPath, line: 20 } });
  const res = run({
    actions: [on, off],
    verdicts: [verdict({ actionId: 'on', status: 'occurs', occurrences: 5 }), verdict({ actionId: 'off', status: 'never' })],
  });
  const split = res.proposals.find((p) => p.kind === 'tune-split-section')!;
  assert.ok(split, 'split card emitted');
  assert.equal(split.lever, 'tune');
  assert.equal(split.occurrence, 'occurs');
  assert.equal(split.confidence, 'inferred'); // capped
});

check('relocate-to-progressive-disclosure: a LARGE occasionally-used section → relocate lever', () => {
  const on = action({ id: 'on', residentTokens: 600, sourceSectionKey: 'sec-big-mixed' });
  const off = action({ id: 'off', residentTokens: 600, sourceSectionKey: 'sec-big-mixed', source: { absPath: on.source.absPath, line: 40 } });
  const res = run({
    actions: [on, off],
    verdicts: [verdict({ actionId: 'on', status: 'occurs', occurrences: 3 }), verdict({ actionId: 'off', status: 'never' })],
  });
  const rel = res.proposals.find((p) => p.kind === 'relocate-to-progressive-disclosure')!;
  assert.ok(rel, 'relocate card emitted for a >= RELOCATE_MIN_SECTION_TOKENS section');
  assert.equal(rel.lever, 'relocate');
  assert.equal(rel.residentTokenDelta.basis, 'relocate-to-disclosure');
});

// ── Not analyzable ─────────────────────────────────────────────────────────────

check('Not analyzable: unobservable + insufficient-exposure actions land in notAnalyzable, not proposals', () => {
  const u = action({ id: 'u', sourceSectionKey: 'sec-u', derivability: 'unmatchable', source: { absPath: 'C:/ws/CLAUDE.md', line: 3 } });
  const i = action({ id: 'i', sourceSectionKey: 'sec-i', source: { absPath: 'C:/ws/CLAUDE.md', line: 7 } });
  const res = run({
    actions: [u, i],
    verdicts: [
      verdict({ actionId: 'u', status: 'unobservable', unobservableReason: 'unmatchable' }),
      verdict({ actionId: 'i', status: 'insufficient-exposure', exposureTurns: 3 }),
    ],
  });
  const labels = res.modelStats.notAnalyzable.map((n) => n.label).sort();
  assert.deepEqual(labels, ['insufficient-exposure', 'unmatchable']);
  assert.equal(res.proposals.length, 0);
});

// ── R2 WP-4C: section-level analyzability diagnostic + the dedupe-bug fix ────────

check('WP-4C dedupe fix: a section shared across lanes is counted ONCE carrying BOTH lanes', () => {
  // The SAME section (sourceSectionKey) is compiled under both the supervisor and worker
  // lanes with the SAME action id (id excludes lane). The pre-fix dedupe stored the FIRST
  // lane seen; the fix accumulates the full lane SET and counts the section once.
  const sup = action({ id: 'shared', sourceSectionKey: 'sec-shared', lanes: ['supervisor', 'worker'],
    derivability: 'unmatchable', requiresDerivationGate: false });
  const wrk = action({ id: 'shared', sourceSectionKey: 'sec-shared', lanes: ['supervisor', 'worker'],
    derivability: 'unmatchable', requiresDerivationGate: false });
  const res = generateContextOptimizerProposals({
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    lanes: [
      lane({ lane: 'supervisor', actions: [sup],
        verdicts: [verdict({ actionId: 'shared', status: 'unobservable', unobservableReason: 'unmatchable' })] }),
      lane({ lane: 'worker', actions: [wrk],
        verdicts: [verdict({ actionId: 'shared', status: 'unobservable', unobservableReason: 'unmatchable' })] }),
    ],
  });
  const diags = res.modelStats.analyzability ?? [];
  assert.equal(diags.length, 1, 'the cross-lane section is ONE diagnostic, not two');
  const d = diags[0];
  assert.deepEqual([...d.lanes].sort(), ['supervisor', 'worker'], 'carries BOTH lanes');
  assert.equal(d.actionCount, 1, 'the shared action id is counted ONCE across lanes');
  assert.equal(d.reasons.length, 1);
  assert.equal(d.reasons[0].code, 'pure-prose');
  assert.equal(d.reasons[0].count, 1);
});

check('WP-4C reason mapping: each label maps to its stable code + advisory suggestedDetector', () => {
  const cases: Array<[string, Partial<OccurrenceVerdict>, string, string | undefined]> = [
    ['s-prose',   { status: 'unobservable', unobservableReason: 'unmatchable' },         'pure-prose',        'imperative-prose-detector'],
    ['s-server',  { status: 'unobservable', unobservableReason: 'coarse-server-grant' }, 'matcher-ambiguous', 'named-tool-resolver'],
    ['s-seq',     { status: 'unobservable', unobservableReason: 'sequence-deferred' },   'sequence-deferred', 'workflow-sequence-detector'],
    ['s-branch',  { status: 'unobservable', unobservableReason: 'branch-deferred' },     'branch-deferred',   'policy-constraint-detector'],
    ['s-path',    { status: 'unobservable', unobservableReason: 'unresolved-path' },     'capture-missing',   'relative-path-resolver'],
    ['s-exp',     { status: 'insufficient-exposure', exposureTurns: 2 },                 'exposure-low',      undefined],
  ];
  const actions = cases.map(([sk]) => action({ id: sk, sourceSectionKey: sk }));
  const verdicts = cases.map(([sk, v]) => verdict({ actionId: sk, ...v }));
  const res = generateContextOptimizerProposals({
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    lanes: [lane({ actions, verdicts })],
  });
  const diags = res.modelStats.analyzability ?? [];
  for (const [sk, , code, detector] of cases) {
    const d = diags.find((x) => x.sectionKey === sk);
    assert.ok(d, `diagnostic for ${sk}`);
    assert.equal(d.reasons[0].code, code, `${sk} → ${code}`);
    assert.equal(d.reasons[0].suggestedDetector, detector, `${sk} detector`);
  }
});

check('WP-4C: distinct actions in one section accumulate actionCount + per-code counts', () => {
  // Two DISTINCT unmatchable actions in the same section → one diagnostic, actionCount 2.
  const a1 = action({ id: 'p1', sourceSectionKey: 'sec-multi', derivability: 'unmatchable', requiresDerivationGate: false });
  const a2 = action({ id: 'p2', sourceSectionKey: 'sec-multi', derivability: 'unmatchable', requiresDerivationGate: false,
    source: { absPath: a1.source.absPath, line: 20 } });
  const res = run({
    actions: [a1, a2],
    verdicts: [
      verdict({ actionId: 'p1', status: 'unobservable', unobservableReason: 'unmatchable' }),
      verdict({ actionId: 'p2', status: 'unobservable', unobservableReason: 'unmatchable' }),
    ],
  });
  const diags = res.modelStats.analyzability ?? [];
  assert.equal(diags.length, 1);
  assert.equal(diags[0].actionCount, 2);
  assert.equal(diags[0].reasons[0].code, 'pure-prose');
  assert.equal(diags[0].reasons[0].count, 2);
});

check('WP-4C: analyzability is absent when nothing is notAnalyzable (honest omission)', () => {
  const a = action({ id: 'ok', sourceSectionKey: 'sec-ok', residentTokens: 300 });
  const res = run({ actions: [a], verdicts: [verdict({ actionId: 'ok' })] });
  assert.equal(res.modelStats.analyzability, undefined);
});

// ── file-heat rollup ───────────────────────────────────────────────────────────

check('file-heat rollup passthrough marks uncovered-hot entries', () => {
  const hot = heat({ pathHash: 'h1', coverage: 'uncovered', executes: 9 });
  const covered = heat({ pathHash: 'h2', coverage: 'skill-owned', executes: 1 });
  const coverage: FileCoverageResult = {
    lane: 'supervisor',
    fileHeat: [hot, covered],
    bucketCounts: { ignored: 0, 'scaffold-vendor': 0, 'skill-owned': 1, 'skill-owned-resource': 0, 'config-referenced': 0, uncovered: 1 },
    uncoveredHot: [hot],
  };
  const res = run({ coverage });
  assert.equal(res.fileHeat.length, 2);
  assert.equal(res.fileHeat.find((f) => f.pathHash === 'h1')!.uncovered, true);
  assert.equal(res.fileHeat.find((f) => f.pathHash === 'h2')!.uncovered, false);
});

// ── determinism ────────────────────────────────────────────────────────────────

check('determinism: identical input → byte-identical proposal id ordering', () => {
  const build = () => {
    const acts = [
      action({ id: 'a', residentTokens: 300, sourceSectionKey: 'sec-a' }),
      action({ id: 'b', residentTokens: 300, sourceSectionKey: 'sec-b' }),
      action({ id: 't', kind: 'toolset-usage', params: { toolset: 'z' }, sourceSectionKey: '' }),
    ];
    const vs = [verdict({ actionId: 'a' }), verdict({ actionId: 'b' }), verdict({ actionId: 't' })];
    return run({ actions: acts, verdicts: vs, toolsetResidentTokens: { z: 300 } }).proposals.map((p) => p.id);
  };
  assert.deepEqual(build(), build());
});

// ── capstone registry ──────────────────────────────────────────────────────────

check('capstone mapping: one registry maps every kind to a lever + source; safetyRouteFor covers P4.2', () => {
  for (const kind of Object.keys(CAPSTONE_KIND_MAP) as (keyof typeof CAPSTONE_KIND_MAP)[]) {
    assert.equal(CAPSTONE_KIND_MAP[kind].capstoneSource, 'behavior-grounded-context-optimizer');
    assert.equal(leverFor(kind), CAPSTONE_KIND_MAP[kind].lever);
  }
  assert.equal(safetyRouteFor('generated-vendor'), 'propose-source-constant-edit');
  assert.equal(safetyRouteFor('scaffold-managed'), 'route-to-constants-version-bump');
  assert.equal(safetyRouteFor('user-owned'), 'consider-only');
});

check('modelStats: behaviorEvents sums occurrences; residentTokensByLane carries the lane summary', () => {
  const a = action({ id: 'a', sourceSectionKey: 'sec-a' });
  const res = run({ actions: [a], verdicts: [verdict({ actionId: 'a', status: 'occurs', occurrences: 7 })] });
  assert.equal(res.modelStats.behaviorEvents, 7);
  assert.equal(res.modelStats.residentTokensByLane[0].total, 5000);
  assert.deepEqual(res.meta.tierGroups, ['observed-safe', 'observed', 'inferred', 'heuristic']);
});

// ── WP7: proposedEdit.summary on every proposal kind ────────────────────────────

check('WP7: every emitted proposal carries a non-empty proposedEdit.summary (patch omitted — pure engine)', () => {
  // A fixture broad enough to exercise several distinct kinds in one pass:
  // subtract-dead-guidance (dead section), subtract-unused-toolset (never-used grant),
  // add-missing-guidance (undocumented drift), add-improvisation-support (cluster).
  const d1 = action({ id: 'd1', residentTokens: 300, sourceSectionKey: 'sec-dead' });
  const d2 = action({ id: 'd2', residentTokens: 300, sourceSectionKey: 'sec-dead', source: { absPath: d1.source.absPath, line: 22 } });
  const tool = action({ id: 'tool', kind: 'toolset-usage', params: { toolset: 'z' }, sourceSectionKey: '' });
  const drift: DriftFinding[] = [
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'newgrant', evidenceTier: 'observed-safe', detail: 'granted, undocumented', sources: [] },
  ];
  const cluster: ImprovisationCandidate = { lane: 'supervisor', dimension: 'command_family', key: 'gh pr', count: 9, distinctStreams: 4, expectedSaving: 1200 };
  const res = run({
    actions: [d1, d2, tool],
    verdicts: [verdict({ actionId: 'd1' }), verdict({ actionId: 'd2' }), verdict({ actionId: 'tool' })],
    toolsetResidentTokens: { z: 300 },
    drift,
    clusters: [cluster],
  });
  assert.ok(res.proposals.length >= 3, 'fixture yields multiple proposals');
  const kinds = new Set(res.proposals.map((p) => p.kind));
  assert.ok(kinds.size >= 2, 'multiple distinct kinds present');
  for (const p of res.proposals) {
    assert.ok(p.proposedEdit, `proposedEdit present for ${p.kind} (${p.id})`);
    assert.equal(typeof p.proposedEdit!.summary, 'string');
    assert.ok(p.proposedEdit!.summary.trim().length > 0, `non-empty summary for ${p.kind}`);
  }
});

// ── WP-E: grant-mismatch detector + contradiction guardrail + sample gate ────────

const teamsDrift = (): DriftFinding[] => [
  { kind: 'documented-but-decommissioned', lane: 'supervisor', toolset: 'teams',
    evidenceTier: 'observed-safe', detail: 'teams toolset decommissioned',
    sources: [{ absPath: 'C:/ws/.dashboard/supervisor/CLAUDE.md', line: 10 }] },
];
const GM_ID = 'drift:documented-but-decommissioned:supervisor:teams';

check('WP-E (a): supervisor Teams → subtract-grant-mismatch, verified-by-construction, positive estimate + non-zero weight', () => {
  const res = run({
    drift: teamsDrift(),
    residentSectionTextAt: () => 'x'.repeat(1000),
    estimateTokens: (t) => t.length,
  });
  const gm = res.proposals.find((p) => p.kind === 'subtract-grant-mismatch')!;
  assert.ok(gm, 'grant-mismatch proposal emitted');
  assert.equal(gm.id, GM_ID);                                // id uses the DRIFT kind (BUG-43)
  assert.equal(gm.lever, 'subtract');
  assert.equal(gm.residentTokenDelta.estimate, 1000);        // estimateTokens = length of 1000-char text
  assert.equal(gm.tokenTurnsWeight, 1000 * 100);             // × resident.exposureTurns (100)
  assert.equal(gm.costEvidence?.residentTokensTimesExposure, 1000 * 100);
  assert.equal(gm.verification.requiresDerivationGate, false);
  assert.equal(gm.actionability, 'actionable');
  assert.equal(gm.suppressedFromAgentSurface, false);
  assert.equal(gm.laneInsight, 'grant-mismatch');
});

check('WP-2A (a-suppress): NO seams injected → grant-mismatch SUPPRESSED (no proposal) + section-not-resident evaluation', () => {
  // WP-2A removed the zero-weight subtract-dead-guidance fallback: with no sizing seams the
  // documented section cannot be priced, so the candidate is SUPPRESSED (never a fabricated
  // subtract) and its suppression is auditable via a typed grant-mismatch-evaluation.
  const res = run({ drift: teamsDrift() });
  assert.equal(res.proposals.filter((p) => p.id === GM_ID).length, 0, 'no drift subtract emitted without seams');
  const evals = res.diagnostics!.filter((d) => d.kind === 'grant-mismatch-evaluation');
  assert.equal(evals.length, 1, 'exactly one evaluation for the single candidate');
  assert.equal(evals[0].grantMismatchVerdict, 'section-not-resident');
  assert.equal(evals[0].relatedProposalId, GM_ID);
  assert.equal(evals[0].tokenEstimate, 0);
});

check('WP-E (b): planning-sentinel suppressed by the contradiction guardrail + 55-call counter-evidence in the diagnostic', () => {
  const res = run({
    drift: teamsDrift(),
    residentSectionTextAt: () => 'x'.repeat(1000),
    estimateTokens: (t) => t.length,
    capabilityFamilyUsageFor: () => ({ family: 'plans-read', calls: 55 }),
  });
  assert.equal(res.proposals.filter((p) => p.id === GM_ID).length, 0, 'subtract suppressed — no proposal for the drift id');
  const diag = res.diagnostics!.find((d) => d.kind === 'grant-mismatch-contradiction')!;
  assert.ok(diag, 'contradiction diagnostic emitted');
  assert.equal(diag.counterEvidenceCalls, 55);
  assert.equal(diag.capabilityFamily, 'plans-read');
  assert.equal(diag.relatedProposalId, GM_ID);
});

check('WP-E (c): insufficient-sample behavioral subtract → withheld (no actionable subtract) + coverage-insufficient diagnostic', () => {
  const a1 = action({ id: 'c1', residentTokens: 300, sourceSectionKey: 'sec-dead' });
  const a2 = action({ id: 'c2', residentTokens: 300, sourceSectionKey: 'sec-dead', source: { absPath: a1.source.absPath, line: 14 } });
  const res = run({
    actions: [a1, a2],
    // verifiedDerivation ⇒ WOULD be actionable but for the gate; exposureStreams:1 < floor (2).
    verdicts: [verdict({ actionId: 'c1', exposureStreams: 1 }), verdict({ actionId: 'c2', exposureStreams: 1 })],
    derivation: verifiedDerivation,
  });
  assert.equal(res.proposals.filter((p) => p.lever === 'subtract').length, 0, 'no actionable subtract survives the gate');
  const diag = res.diagnostics!.find((d) => d.kind === 'coverage-insufficient')!;
  assert.ok(diag, 'coverage-insufficient diagnostic emitted');
  assert.equal(diag.evidence, 'insufficient-sample');
  assert.equal(diag.sampleStreams, 1);
});

check('WP-E (d): every subtract carries a non-empty laneInsight + a verification class', () => {
  const tool = action({ id: 'tool', kind: 'toolset-usage', params: { toolset: 'z' }, sourceSectionKey: '' });
  const res = run({
    actions: [tool],
    verdicts: [verdict({ actionId: 'tool' })],
    toolsetResidentTokens: { z: 300 },
    drift: teamsDrift(),
    residentSectionTextAt: () => 'x'.repeat(1000),
    estimateTokens: (t) => t.length,
  });
  const subtracts = res.proposals.filter((p) => p.lever === 'subtract');
  assert.ok(subtracts.length >= 2, 'fixture yields a toolset subtract + a grant-mismatch subtract');
  const kinds = new Set(subtracts.map((p) => p.kind));
  assert.ok(kinds.has('subtract-unused-toolset') && kinds.has('subtract-grant-mismatch'), 'both subtract kinds present');
  for (const p of subtracts) {
    assert.equal(typeof p.laneInsight, 'string', `laneInsight is a string for ${p.kind}`);
    assert.ok((p.laneInsight ?? '').length > 0, `non-empty laneInsight for ${p.kind}`);
    assert.ok(p.verification, `verification present for ${p.kind}`);
  }
});

check('WP-E (e): exhaustiveness — subtract-grant-mismatch is a subtract lever + carries a capstone category', () => {
  assert.equal(leverFor('subtract-grant-mismatch'), 'subtract');
  assert.ok(CAPSTONE_KIND_MAP['subtract-grant-mismatch'].category, 'capstone category present for the new kind');
});

// ── WP-2A (Priority 0): honest gating + per-candidate grant-mismatch-evaluation ──

check('WP-2A: a sized grant-mismatch emits the subtract AND exactly one `emitted` evaluation', () => {
  const res = run({
    drift: teamsDrift(),
    residentSectionTextAt: () => 'x'.repeat(1000),
    estimateTokens: (t) => t.length,
  });
  assert.equal(res.proposals.filter((p) => p.id === GM_ID).length, 1, 'the subtract is emitted');
  const evals = res.diagnostics!.filter((d) => d.kind === 'grant-mismatch-evaluation');
  assert.equal(evals.length, 1, 'exactly one evaluation per candidate');
  assert.equal(evals[0].grantMismatchVerdict, 'emitted');
  assert.equal(evals[0].tokenEstimate, 1000);
  assert.equal(evals[0].resolvedToolset, 'teams');
  assert.equal(evals[0].relatedProposalId, GM_ID);
});

check('WP-2A: a contradicted grant-mismatch emits suppressed-counterevidence alongside the contradiction diagnostic', () => {
  const res = run({
    drift: teamsDrift(),
    residentSectionTextAt: () => 'x'.repeat(1000),
    estimateTokens: (t) => t.length,
    capabilityFamilyUsageFor: () => ({ family: 'plans-read', calls: 55 }),
  });
  assert.equal(res.proposals.filter((p) => p.id === GM_ID).length, 0, 'contradicted → no subtract');
  const evals = res.diagnostics!.filter((d) => d.kind === 'grant-mismatch-evaluation');
  assert.equal(evals.length, 1, 'still exactly one evaluation for the candidate');
  assert.equal(evals[0].grantMismatchVerdict, 'suppressed-counterevidence');
  assert.equal(evals[0].counterEvidenceCalls, 55);
  // The existing contradiction diagnostic is still emitted alongside (WP-E b invariant).
  assert.ok(res.diagnostics!.some((d) => d.kind === 'grant-mismatch-contradiction'), 'contradiction diagnostic retained');
});

check('WP-2A: an unresolved/ambiguous documented mention is NEVER a subtract — ambiguous-toolset evaluation only', () => {
  const drift: DriftFinding[] = [
    { kind: 'documented-unresolved-toolset', lane: 'supervisor', toolset: 'create_team',
      mentionedToolName: 'create_team', candidateToolsets: ['teams', 'orchestration'],
      resolutionConfidence: 'code-name', evidenceTier: 'observed-safe',
      detail: 'ambiguous', sources: [{ absPath: 'C:/ws/CLAUDE.md', line: 3 }] },
  ];
  const res = run({ drift, residentSectionTextAt: () => 'x'.repeat(1000), estimateTokens: (t) => t.length });
  assert.equal(res.proposals.filter((p) => p.lever === 'subtract').length, 0, 'unresolved mention never subtracts');
  const evals = res.diagnostics!.filter((d) => d.kind === 'grant-mismatch-evaluation');
  assert.equal(evals.length, 1);
  assert.equal(evals[0].grantMismatchVerdict, 'ambiguous-toolset');
  assert.deepEqual(evals[0].candidateToolsets, ['teams', 'orchestration']);
  assert.equal(evals[0].mentionedToolName, 'create_team');
});

check('WP-2A: "0 rows, N suppressed" is distinguishable from "0 candidates" by the evaluation count', () => {
  // Two grant-mismatch candidates, NO sizing seams → both suppressed → 0 rows, 2 evaluations.
  const drift: DriftFinding[] = [
    { kind: 'documented-but-decommissioned', lane: 'supervisor', toolset: 'teams', evidenceTier: 'observed-safe', detail: 'a', sources: [{ absPath: 'C:/ws/CLAUDE.md', line: 10 }] },
    { kind: 'documented-but-not-granted', lane: 'supervisor', toolset: 'notebooks', evidenceTier: 'observed-safe', detail: 'b', sources: [{ absPath: 'C:/ws/CLAUDE.md', line: 12 }] },
  ];
  const suppressed = run({ drift });
  assert.equal(suppressed.proposals.filter((p) => p.lever === 'subtract').length, 0, 'no subtract rows');
  assert.equal(suppressed.diagnostics!.filter((d) => d.kind === 'grant-mismatch-evaluation').length, 2, 'N=2 suppressed candidates each carry an evaluation');
  // No drift at all → 0 candidates → 0 evaluations (the honest "nothing to optimize" case).
  const none = run({ drift: [] });
  assert.equal((none.diagnostics ?? []).filter((d) => d.kind === 'grant-mismatch-evaluation').length, 0);
});

// ── WP-1A (Priority 0): behaviorEvidence / evidenceState threading ─────────────

/** An auditable non-occurrence audit object (capped identifiers + counts only). */
function auditEvidence(sampledStreamIds: string[]): NonNullable<OccurrenceVerdict['evidence']> {
  return {
    predicate: { kind: 'toolset-usage', toolset: 'orchestration' },
    matcherVersion: '7',
    normalizedMatcher: { kind: 'toolset-usage', toolset: 'orchestration' },
    epoch: { id: 'epoch-1', confidence: 'high' },
    denominator: {
      turns: 100, streams: sampledStreamIds.length, slugs: 1,
      sampledStreams: sampledStreamIds.map((streamId) => ({ streamId, turns: 20, lane: 'supervisor' })),
    },
    numerator: { occurrences: 0, streams: 0, sampledEvents: [] },
    captureCoverage: { providers: { orchestration: { streams: 3, pathEventsSupported: true } }, unknownToolEvents: 0, unresolvedPathEvents: 0 },
    exclusions: { subagents: false, reasons: [] },
  };
}

check('WP-1A: auditable `never` toolset proposal carries behaviorEvidence + evidenceState + denominator streamIds', () => {
  const a = action({ id: 'orch', kind: 'toolset-usage', params: { toolset: 'orchestration' }, residentTokens: 40, sourceSectionKey: '' });
  const ev = auditEvidence(['s1', 's2']);
  const res = run({
    actions: [a],
    verdicts: [verdict({ actionId: 'orch', evidence: ev, evidenceState: 'auditable' })],
    toolsetResidentTokens: { orchestration: 9000 },
  });
  const t = res.proposals.find((p) => p.kind === 'subtract-unused-toolset')!;
  assert.equal(t.evidenceState, 'auditable');
  assert.ok(t.behaviorEvidence, 'behaviorEvidence attached');
  assert.equal(t.behaviorEvidence!.denominator.sampledStreams.length, 2);
  // attribution.streamIds are the DENOMINATOR (exposure) samples, not matching streams.
  assert.deepEqual(t.attribution.streamIds, ['s1', 's2']);
  assert.equal(t.evidenceRef, t.id);
});

check('WP-1A: a dead-guidance SUBTRACT threads the section rep verdict evidenceState', () => {
  const a1 = action({ id: 'd1', residentTokens: 300, sourceSectionKey: 'sec-audit' });
  const ev = auditEvidence(['sx']);
  const res = run({ actions: [a1], verdicts: [verdict({ actionId: 'd1', evidence: ev, evidenceState: 'auditable' })] });
  const dead = res.proposals.find((p) => p.kind === 'subtract-dead-guidance')!;
  assert.equal(dead.evidenceState, 'auditable');
  assert.ok(dead.behaviorEvidence, 'section dead-guidance carries behaviorEvidence');
});

check('WP-1A: drift SUBTRACT/ADD carry evidenceState unavailable (no non-occurrence audit)', () => {
  const drift: DriftFinding[] = [
    { kind: 'documented-but-decommissioned', lane: 'supervisor', toolset: 'old', toolName: 'gone', evidenceTier: 'observed-safe', detail: 'x', sources: [{ absPath: 'C:/ws/CLAUDE.md', line: 4 }] },
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'newgrant', evidenceTier: 'observed-safe', detail: 'y', sources: [] },
  ];
  // WP-2A honest gating: wire the sizing seams so the decommissioned candidate emits a
  // real subtract-grant-mismatch (still evidenceState 'unavailable' — a static-config fact,
  // no non-occurrence audit trail).
  // R2 WP-4B (Step 1): granted-but-undocumented ADD now demotes to a config-completeness
  // note UNLESS a behavioral need triggers — inject one so the ADD still emits (this test's
  // subject is the ADD's shape, not the demotion; the demotion is covered by its own tests).
  const res = run({ drift, residentSectionTextAt: () => 'x'.repeat(500), estimateTokens: (t) => t.length, behavioralNeedFor: () => ({ discoverabilityFailures: 2 }) });
  const sub = res.proposals.find((p) => p.kind === 'subtract-grant-mismatch' && p.id.includes('drift'))!;
  const add = res.proposals.find((p) => p.kind === 'add-missing-guidance')!;
  assert.equal(sub.evidenceState, 'unavailable');
  assert.equal(add.evidenceState, 'unavailable');
});

check('WP-1A: ADD (improvisation cluster) and TUNE (bypass) proposals are evidenceState unavailable', () => {
  const c: ImprovisationCandidate = { lane: 'supervisor', dimension: 'command_family', key: 'gh pr', count: 9, distinctStreams: 4, expectedSaving: 1200 };
  const res = run({ clusters: [c], bypass: bypassResult() });
  const add = res.proposals.find((p) => p.kind === 'add-improvisation-support')!;
  const tune = res.proposals.find((p) => p.kind === 'tune-skill-trigger')!;
  assert.equal(add.evidenceState, 'unavailable');
  assert.equal(tune.evidenceState, 'unavailable');
});

check('WP-1A: a provisional-`never` downgraded to capture-incomplete yields NO subtract + a capture-incomplete diagnostic', () => {
  const a = action({ id: 'ci', kind: 'toolset-usage', params: { toolset: 'orchestration' }, residentTokens: 40, sourceSectionKey: '' });
  const ev = auditEvidence(['s1']);
  const res = run({
    actions: [a],
    verdicts: [verdict({ actionId: 'ci', status: 'capture-incomplete', evidence: ev, evidenceState: 'partial' })],
    toolsetResidentTokens: { orchestration: 9000 },
  });
  // No subtract asserted for a withheld provisional-never.
  assert.equal(res.proposals.filter((p) => p.kind === 'subtract-unused-toolset').length, 0);
  // It buckets into "Not analyzable" with the capture-incomplete label…
  assert.ok(res.modelStats.notAnalyzable.some((n) => n.label === 'capture-incomplete'), 'capture-incomplete in notAnalyzable');
  // …and surfaces an auditable diagnostic explaining the withheld subtract.
  const diag = res.diagnostics?.find((d) => d.kind === 'capture-incomplete');
  assert.ok(diag, 'capture-incomplete diagnostic present');
});

// ── subtract-unused-skill-advertisement (R2 WP-3, resident-asset-derived) ────────

function skillUsage(o: {
  skillName: string; headerTokens?: number; sourcePath?: string;
  observedUses?: number; usageCoveragePct?: number; eligibleExposureTurns?: number;
  lastUsedAt?: number | null;
}): ResidentAssetUsage {
  return {
    asset: {
      kind: 'skill-advertisement', skillName: o.skillName,
      headerTokens: o.headerTokens ?? 120, lanes: ['supervisor'],
      sourcePath: o.sourcePath ?? `C:/ws/.claude/skills/${o.skillName}/SKILL.md`,
    },
    observedUses: o.observedUses ?? 0,
    eligibleExposureTurns: o.eligibleExposureTurns ?? 100,
    exposureApproximate: true,
    usageCoveragePct: o.usageCoveragePct ?? 80,
    lastUsedAt: o.lastUsedAt ?? null,
    zeroUseWindow: { sinceMs: 1000, untilMs: 2000 },
    scopeMeta: { appliedScopeMode: 'strict', workspaceKeyIsSlugProxy: true, proxyIncluded: false },
  };
}

check('subtract-unused-skill-advertisement: unused skill above the coverage floor → one candidate-unverified SUBTRACT sized by header cost', () => {
  const res = run({ residentAssetUsage: [skillUsage({ skillName: 'deep-research', headerTokens: 120, usageCoveragePct: 80, eligibleExposureTurns: 100 })] });
  const s = res.proposals.filter((p) => p.kind === 'subtract-unused-skill-advertisement');
  assert.equal(s.length, 1);
  const p = s[0];
  assert.equal(p.id, 'subtract-skill-adv:supervisor:deep-research');
  assert.equal(p.lever, 'subtract');
  assert.equal(p.target.skillName, 'deep-research');
  assert.equal(p.target.mutable, 'user-owned');                    // skills are user-owned SKILL.md
  assert.equal(p.residentTokenDelta.basis, 'header-only');
  assert.equal(p.residentTokenDelta.estimate, 120);
  assert.equal(p.tokenTurnsWeight, 120 * 100);                     // headerTokens × eligibleExposureTurns
  assert.equal(p.occurrence, 'never');
  assert.equal(p.epochConfidence, 'low');                          // advertisement epoch not derivable
  assert.equal(p.actionability, 'candidate-unverified');           // requiresGate + unverified derivation
  assert.equal(p.suppressedFromAgentSurface, true);                // never auto-actionable
  assert.equal(p.evidenceState, 'unavailable');                    // no OccurrenceEvidence trail
  assert.equal(p.laneInsight, 'unused-skill-advertisement');
  // asset-backed evidence is projected onto the proposal DTO (Step 6).
  assert.equal(p.assetEvidence?.usageCoveragePct, 80);
  assert.equal(p.assetEvidence?.exposureApproximate, true);
  assert.equal(p.assetEvidence?.scopeMeta.appliedScopeMode, 'strict');
  assert.ok(p.costEvidence?.note?.includes('advertisement epoch not derivable'));
  // Scope discipline: remove from the lane's advertised surface / shorten — never global delete.
  assert.ok(/advertised discovery surface/.test(p.rationale) || /shorten/.test(p.rationale));
});

check('subtract-unused-skill-advertisement: below the coverage floor → WITHHELD + coverage-insufficient diagnostic', () => {
  const res = run({ residentAssetUsage: [skillUsage({ skillName: 'gws', usageCoveragePct: 5 })] });
  assert.equal(res.proposals.filter((p) => p.kind === 'subtract-unused-skill-advertisement').length, 0);
  const diag = res.diagnostics?.find((d) => d.kind === 'coverage-insufficient' && d.relatedProposalId === 'subtract-skill-adv:supervisor:gws');
  assert.ok(diag, 'coverage-insufficient diagnostic for the withheld skill subtract');
});

check('subtract-unused-skill-advertisement: an invoked skill is NOT a subtract candidate', () => {
  const res = run({ residentAssetUsage: [skillUsage({ skillName: 'read-comments', observedUses: 4, usageCoveragePct: 90 })] });
  assert.equal(res.proposals.filter((p) => p.kind === 'subtract-unused-skill-advertisement').length, 0);
});

check('subtract-unused-skill-advertisement: a trivially-small header is skipped (below min tokens, no proposal, no diagnostic)', () => {
  const res = run({ residentAssetUsage: [skillUsage({ skillName: 'tiny', headerTokens: 10, usageCoveragePct: 90 })] });
  assert.equal(res.proposals.filter((p) => p.kind === 'subtract-unused-skill-advertisement').length, 0);
  assert.equal((res.diagnostics ?? []).filter((d) => d.relatedProposalId === 'subtract-skill-adv:supervisor:tiny').length, 0);
});

// ── R2 WP-4B (Step 1 + Step 4): improve-lever consolidation ─────────────────────

check('WP-4B Step 1: behavioralNeedTriggers — each of the 4 signals at/over its floor triggers with a reason', () => {
  // Floors (optimizer-config.ts): discoverability 2, shell 3, failed/unknown 2, navigation 200.
  const disc = behavioralNeedTriggers({ discoverabilityFailures: 2 });
  assert.equal(disc.triggered, true);
  assert.equal(disc.reasons.length, 1);
  assert.match(disc.reasons[0], /discoverability/);

  const shell = behavioralNeedTriggers({ shellImprovisations: 3 });
  assert.equal(shell.triggered, true);
  assert.match(shell.reasons[0], /shell improvisation/);

  const failed = behavioralNeedTriggers({ failedOrUnknownCalls: 2 });
  assert.equal(failed.triggered, true);
  assert.match(failed.reasons[0], /failed\/unknown/);

  const nav = behavioralNeedTriggers({ navigationCostTokens: 200 });
  assert.equal(nav.triggered, true);
  assert.match(nav.reasons[0], /navigation cost/);
});

check('WP-4B Step 1: behavioralNeedTriggers — null / empty / below-floor never triggers', () => {
  assert.equal(behavioralNeedTriggers(undefined).triggered, false);
  assert.equal(behavioralNeedTriggers(null).triggered, false);
  assert.deepEqual(behavioralNeedTriggers({}), { triggered: false, reasons: [] });
  // every field one below its floor ⇒ still nothing crosses.
  const below = behavioralNeedTriggers({
    discoverabilityFailures: 1, shellImprovisations: 2, failedOrUnknownCalls: 1, navigationCostTokens: 199,
  });
  assert.equal(below.triggered, false);
  assert.equal(below.reasons.length, 0);
});

check('WP-4B Step 1: ≥2 granted-but-undocumented findings, no behavioral need → ZERO adds + ONE config-completeness diagnostic', () => {
  const drift: DriftFinding[] = [
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'foo', evidenceTier: 'observed-safe', detail: 'granted foo, undocumented', sources: [] },
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'bar', evidenceTier: 'observed-safe', detail: 'granted bar, undocumented', sources: [] },
  ];
  const res = run({ drift, behavioralNeedFor: () => null });
  assert.equal(res.proposals.filter((p) => p.kind === 'add-missing-guidance').length, 0,
    'symmetry-only grants are demoted, never add-missing-guidance proposals');
  const cc = res.diagnostics!.filter((d) => d.kind === 'config-completeness');
  assert.equal(cc.length, 1, 'the no-signal grants fold into ONE lane card');
  assert.equal(cc[0].undocumentedCount, 2, 'undocumentedCount == the finding count');
  assert.equal(cc[0].undocumentedToolsets?.length, 2);
  assert.deepEqual(cc[0].undocumentedToolsets?.map((t) => t.toolset).sort(), ['bar', 'foo']);
});

check('WP-4B Step 1+4: a triggered granted-but-undocumented survives as add-missing-guidance carrying benefitModel.failure-rate-reduced', () => {
  const drift: DriftFinding[] = [
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'foo', evidenceTier: 'observed-safe', detail: 'granted foo, undocumented', sources: [] },
  ];
  const res = run({ drift, behavioralNeedFor: () => ({ discoverabilityFailures: 4 }) });
  const add = res.proposals.find((p) => p.kind === 'add-missing-guidance')!;
  assert.ok(add, 'the triggered grant survives demotion as an ADD');
  assert.equal(add.benefitModel?.kind, 'failure-rate-reduced');
  assert.equal(add.benefitModel?.magnitude, 4); // sum of friction counts (navigation cost excluded)
  // a lone triggered grant produces no config-completeness note.
  assert.equal((res.diagnostics ?? []).filter((d) => d.kind === 'config-completeness').length, 0);
});

check('WP-4B Step 4: within a tier a higher benefitModel.magnitude ADD sorts first; a subtract (benefitScore 0) is unaffected', () => {
  const drift: DriftFinding[] = [
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'lowbenefit', evidenceTier: 'observed-safe', detail: 'low', sources: [] },
    { kind: 'granted-but-undocumented', lane: 'supervisor', toolset: 'highbenefit', evidenceTier: 'observed-safe', detail: 'high', sources: [] },
  ];
  // A toolset subtract lands in the SAME observed-safe tier with a positive adjustedWeight.
  const tool = action({ id: 'tool', kind: 'toolset-usage', params: { toolset: 'z' }, sourceSectionKey: '' });
  const res = run({
    actions: [tool],
    verdicts: [verdict({ actionId: 'tool' })],
    toolsetResidentTokens: { z: 300 },
    drift,
    behavioralNeedFor: (f) => f.toolset === 'highbenefit' ? { failedOrUnknownCalls: 9 } : { failedOrUnknownCalls: 2 },
  });
  const hi = res.proposals.findIndex((p) => p.id === 'drift:granted-but-undocumented:supervisor:highbenefit');
  const lo = res.proposals.findIndex((p) => p.id === 'drift:granted-but-undocumented:supervisor:lowbenefit');
  const sub = res.proposals.findIndex((p) => p.kind === 'subtract-unused-toolset');
  assert.ok(hi >= 0 && lo >= 0 && sub >= 0, 'all three proposals present');
  assert.ok(hi < lo, 'higher benefit magnitude ADD sorts before the lower one within the tier');
  // benefitScore only orders the equal-adjustedWeight (0) ADDs; the subtract keeps its
  // adjustedWeight-driven position ahead of both — its order is unchanged by benefit.
  assert.ok(sub < hi && sub < lo, 'the subtract is ordered by adjustedWeight, unaffected by benefit magnitude');
});

check('WP-4B Step 3/5: a rollup with hasDrillableMembers:false is NOT actionable; a drillable rollup IS', () => {
  const nonDrillable: ImprovisationCandidate = {
    lane: 'supervisor', dimension: 'input_shape_hash', key: '', count: 9, distinctStreams: 4,
    expectedSaving: 0, isRollup: true, rollupCount: 3, clusterDimension: 'input_shape_hash',
  };
  const res1 = run({ clusters: [nonDrillable] });
  const p1 = res1.proposals.find((p) => p.id === 'add-cluster-rollup:supervisor:input_shape_hash')!;
  assert.ok(p1, 'rollup proposal emitted');
  assert.equal(p1.target.rollup?.hasDrillableMembers, false);
  assert.equal(proposalHasActionableContent(p1), false, 'no drillable members ⇒ diagnostic, not actionable');
  assert.equal(p1.clusterExemplarRef, undefined, 'no drill ref when there is nothing to drill');

  const drillable: ImprovisationCandidate = {
    ...nonDrillable, memberRefs: ['h1', 'h2'], topMembers: [{ ref: 'h1', count: 5, distinctStreams: 3 }],
  };
  const res2 = run({ clusters: [drillable] });
  const p2 = res2.proposals.find((p) => p.id === 'add-cluster-rollup:supervisor:input_shape_hash')!;
  assert.equal(p2.target.rollup?.hasDrillableMembers, true);
  assert.equal(proposalHasActionableContent(p2), true, 'drillable members ⇒ the drill IS the action');
  assert.equal(p2.clusterExemplarRef, 'add-cluster-rollup:supervisor:input_shape_hash');
});

// ── summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
