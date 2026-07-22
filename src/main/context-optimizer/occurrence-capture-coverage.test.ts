// WP2 (G2) — capture-coverage never-gate tests: an audience-scoped guidance
// action can reach `never`/dead ONLY under a provably `complete` capture cohort.
//   npm run build:main
//   node dist/main/main/context-optimizer/occurrence-capture-coverage.test.js

import assert from 'node:assert/strict';
import {
  classifyAction,
  resolveCaptureCoverage,
  type ClassifyDeps,
  type EvidenceResolver,
  type OccurrenceEvidenceV1,
} from './occurrence-classifier';
import type { PredictedAction } from './guidance-action-model';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── resolveCaptureCoverage (pure) ─────────────────────────────────────────────

test('resolveCaptureCoverage: the lattice', () => {
  // unknown audience → unknown, always (never eligible for complete).
  assert.equal(resolveCaptureCoverage('unknown', ['codex'], true), 'unknown');
  assert.equal(resolveCaptureCoverage([], ['codex'], true), 'unknown');
  // no capture information at all → unknown (absence of evidence, not evidence).
  assert.equal(resolveCaptureCoverage(['codex'], undefined, false), 'unknown');
  // measured zero overlap → none.
  assert.equal(resolveCaptureCoverage(['codex'], [], false), 'none');
  assert.equal(resolveCaptureCoverage(['codex'], ['claude'], false), 'none');
  // partial overlap → partial.
  assert.equal(resolveCaptureCoverage(['codex', 'claude'], ['claude'], false), 'partial');
  // full overlap WITHOUT a measured denominator → observed (presence only).
  assert.equal(resolveCaptureCoverage(['codex'], ['codex'], false), 'observed');
  assert.equal(resolveCaptureCoverage(['codex'], ['Codex'], false), 'observed', 'case-folded');
  // full overlap WITH the measured denominator → complete.
  assert.equal(resolveCaptureCoverage(['codex'], ['codex'], true), 'complete');
});

test('resolveCaptureCoverage: complete is unreachable without enumeration — full presence caps at observed', () => {
  // The denominator fixture: identical capture presence, only the enumeration
  // flag differs. Presence must never masquerade as completeness.
  assert.equal(resolveCaptureCoverage(['codex'], ['codex'], false), 'observed');
  assert.equal(resolveCaptureCoverage(['codex'], ['codex'], true), 'complete');
});

// ── classifyAction fixtures ───────────────────────────────────────────────────

function action(over: Partial<PredictedAction> = {}): PredictedAction {
  return {
    id: 'a1',
    source: { absPath: '/ws/AGENTS.md', line: 3 },
    sourceKind: 'capability',
    lanes: ['worker'],
    kind: 'command-family',
    params: { commandFamily: 'npm-run:test' },
    derivability: 'exact',
    residentTokens: 10,
    sourceSectionKey: '',
    sourceEpochId: '',
    requiresDerivationGate: true,
    ...over,
  };
}

function evidenceWith(providers: Record<string, { streams: number; pathEventsSupported: boolean }>): EvidenceResolver {
  return {
    resolve: (_pa, inp): OccurrenceEvidenceV1 => ({
      predicate: inp.predicate,
      matcherVersion: '1',
      normalizedMatcher: { kind: 'command-family', family: 'npm-run:test' },
      epoch: inp.epoch,
      denominator: { turns: 100, streams: 5, slugs: 1,
        sampledStreams: [{ streamId: 's1', turns: 20, lane: 'worker' }] },
      numerator: { occurrences: 0, streams: 0, sampledEvents: [] },
      captureCoverage: { providers, unknownToolEvents: 0, unresolvedPathEvents: 0 },
      exclusions: { subagents: true, reasons: [] },
    }),
  };
}

function deps(over: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return {
    occurrence: { count: () => ({ occurrences: 0, distinctStreams: 0, distinctSlugs: 0, lastTsMs: null }) },
    exposure: { resolve: () => ({ exposureTurns: 100, distinctStreams: 5, distinctSlugs: 1 }) },
    config: { MIN_EXPOSURE_TURNS: 1, MIN_STREAMS: 1 },
    ...over,
  };
}

test('uncaptured audience provider → capture-incomplete + coverage none; never/dead is unreachable', () => {
  // Audience is codex; capture only ever saw claude streams. WP-1A gates would
  // pass (canonical matcher, providers present, sampled denominator) — the WP2
  // audience gate must STILL withhold `never`.
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps({
    evidence: evidenceWith({ claude: { streams: 5, pathEventsSupported: true } }),
  }));
  assert.equal(v.captureCoverage, 'none');
  assert.equal(v.status, 'capture-incomplete', 'never-observed/dead must be unreachable');
  assert.equal(v.evidenceState, 'partial', 'the downgrade keeps its audit trail');
});

test('audience captured but NOT enumerated → observed presence, still capture-incomplete', () => {
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps({
    evidence: evidenceWith({ codex: { streams: 5, pathEventsSupported: true } }),
  }));
  assert.equal(v.captureCoverage, 'observed', 'presence, not completeness');
  assert.equal(v.status, 'capture-incomplete', 'observed alone may NOT support dead');
});

test('the measured denominator (enumeration seam) is the ONLY path to never', () => {
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps({
    evidence: evidenceWith({ codex: { streams: 5, pathEventsSupported: true } }),
    windowStreamEnumeration: { allAudienceStreamsCaptured: () => true },
  }));
  assert.equal(v.captureCoverage, 'complete');
  assert.equal(v.status, 'never', 'a provably complete cohort may support never');
  assert.equal(v.evidenceState, 'auditable');
});

test('enumeration that CANNOT vouch for the audience keeps the downgrade', () => {
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps({
    evidence: evidenceWith({ codex: { streams: 5, pathEventsSupported: true } }),
    windowStreamEnumeration: { allAudienceStreamsCaptured: () => false },
  }));
  assert.equal(v.captureCoverage, 'observed');
  assert.equal(v.status, 'capture-incomplete');
});

test('unknown audience can never reach complete, even with enumeration wired', () => {
  const v = classifyAction(action({ audienceProviders: 'unknown' }), deps({
    evidence: evidenceWith({ codex: { streams: 5, pathEventsSupported: true } }),
    windowStreamEnumeration: { allAudienceStreamsCaptured: () => true },
  }));
  assert.equal(v.captureCoverage, 'unknown');
  assert.equal(v.status, 'capture-incomplete');
});

test('audience-scoped never WITHOUT an evidence resolver still downgrades (fail-closed)', () => {
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps());
  assert.equal(v.captureCoverage, 'unknown', 'no capture info → unknown, never covered');
  assert.equal(v.status, 'capture-incomplete');
});

test('legacy (no audience) actions are UNTOUCHED — Claude walk-up semantics unchanged', () => {
  const legacy = classifyAction(action(), deps({
    evidence: evidenceWith({ claude: { streams: 5, pathEventsSupported: true } }),
  }));
  assert.equal(legacy.captureCoverage, undefined, 'no coverage stamp on legacy actions');
  assert.equal(legacy.status, 'never', 'the pre-WP2 WP-1A path is preserved verbatim');

  const legacyNoEvidence = classifyAction(action(), deps());
  assert.equal(legacyNoEvidence.status, 'never');
  assert.equal(legacyNoEvidence.evidenceState, 'unavailable');
});

test('an occurring audience-scoped action stays occurs (the gate only guards never)', () => {
  const v = classifyAction(action({ audienceProviders: ['codex'] }), deps({
    occurrence: { count: () => ({ occurrences: 3, distinctStreams: 2, distinctSlugs: 1, lastTsMs: null }) },
  }));
  assert.equal(v.status, 'occurs');
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
