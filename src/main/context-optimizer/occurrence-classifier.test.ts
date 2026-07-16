// Tests for occurrence-classifier.ts (the WP5 "did the rent get paid?" pass, §5.2).
// node:assert on dist. Run: node dist/main/main/context-optimizer/occurrence-classifier.test.js
import assert from 'node:assert';
import type { BehaviorPredicate, Exposure, MatchCount } from './behavior-store';
import type { PredictedAction } from './guidance-action-model';
import {
  classifyAction,
  classifyOccurrences,
  defaultExposureResolver,
  defaultOccurrenceCounter,
  normalizeMatcher,
  type ClassifyDeps,
  type ExposureCount,
  type OccurrenceCounter,
  type ExposureResolver,
  type EvidenceResolver,
  type OccurrenceEvidenceV1,
} from './occurrence-classifier';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────
function pa(partial: Partial<PredictedAction>): PredictedAction {
  return {
    id: `id-${partial.kind ?? 'tool-invocation'}`,
    source: { absPath: '/ws/CLAUDE.md', line: 1 },
    sourceKind: 'capability',
    lanes: ['worker'],
    kind: 'tool-invocation',
    params: {},
    derivability: 'exact',
    residentTokens: 100,
    sourceSectionKey: 'markdown_section:/ws/CLAUDE.md:x',
    sourceEpochId: 'epoch-1',
    requiresDerivationGate: true,
    ...partial,
  } as PredictedAction;
}

const NIL_MATCH: MatchCount = { occurrences: 0, distinctStreams: 0, distinctSlugs: 0, lastTsMs: null };
const NIL_EXPOSURE: ExposureCount = { exposureTurns: 0, distinctStreams: 0, distinctSlugs: 0 };

/** Build ClassifyDeps from fixed match/exposure values, tracking whether the
 *  occurrence counter was invoked (for short-circuit assertions). */
function deps(opts: {
  match?: MatchCount;
  exposure?: ExposureCount;
  matchFn?: OccurrenceCounter['count'];
  epochConfidenceFor?: ClassifyDeps['epochConfidenceFor'];
  evidence?: EvidenceResolver;
}): ClassifyDeps & { calls: number } {
  const box = { calls: 0 };
  const occurrence: OccurrenceCounter = {
    count: (pred, o) => {
      box.calls++;
      return opts.matchFn ? opts.matchFn(pred, o) : (opts.match ?? NIL_MATCH);
    },
  };
  const exposure: ExposureResolver = { resolve: () => opts.exposure ?? NIL_EXPOSURE };
  return {
    occurrence, exposure, evidence: opts.evidence,
    epochConfidenceFor: opts.epochConfidenceFor, get calls() { return box.calls; },
  };
}

// ── WP-1A fail-closed evidence fixtures ───────────────────────────────────────
// Exposure above the `never` floor (MIN_EXPOSURE_TURNS / MIN_STREAMS).
const OVER_FLOOR: ExposureCount = { exposureTurns: 40, distinctStreams: 3, distinctSlugs: 3 };

/** A reproducible audit object whose gates PASS by default: non-empty providers
 *  (path-supported), a denominator sample, zero unresolved-path events. Individual
 *  cases override one field to exercise each fail-closed gate. */
function mkEvidence(over: Partial<OccurrenceEvidenceV1> = {}): OccurrenceEvidenceV1 {
  const predicate: BehaviorPredicate = { kind: 'tool-invocation', toolName: 'Rare' };
  return {
    predicate,
    matcherVersion: '7',
    normalizedMatcher: normalizeMatcher(predicate),
    epoch: { id: 'epoch-1', confidence: 'high' },
    denominator: { turns: 40, streams: 3, slugs: 3, sampledStreams: [{ streamId: 's1', turns: 20, lane: 'worker' }] },
    numerator: { occurrences: 0, streams: 0, sampledEvents: [] },
    captureCoverage: {
      providers: { Bash: { streams: 3, pathEventsSupported: true } },
      unknownToolEvents: 0,
      unresolvedPathEvents: 0,
    },
    exclusions: { subagents: false, reasons: [] },
    ...over,
  };
}

const stubEvidence = (ev: OccurrenceEvidenceV1): EvidenceResolver => ({ resolve: () => ev });

/** A `path-touch` action carrying a RESOLVED file identity → the richer
 *  `file-access` predicate (canonical, subtract-eligible). */
function faPa(over: Partial<PredictedAction> = {}): PredictedAction {
  return pa({
    kind: 'path-touch',
    derivability: 'exact',
    params: { pathGlob: 'src/x.ts' },
    fileAccess: { raw: 'src/x.ts', canonicalAbs: 'C:/ws/src/x.ts', base: 'workspace-root', modes: ['read'], timing: 'unverified' },
    ...over,
  });
}

// ── 1. occurs — rent paid ─────────────────────────────────────────────────────
check('occurrences > 0 → occurs', () => {
  const d = deps({ match: { occurrences: 5, distinctStreams: 3, distinctSlugs: 2, lastTsMs: 111 } });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Bash' } }), d);
  assert.strictEqual(v.status, 'occurs');
  assert.strictEqual(v.occurrences, 5);
  assert.strictEqual(v.lastTsMs, 111);
  assert.strictEqual(v.confidence, 'observed'); // exact
  assert.deepStrictEqual(v.predicate, { kind: 'tool-invocation', toolName: 'Bash' });
});

// ── 2. never — zero occurrences ABOVE the exposure floor ──────────────────────
check('occurrences 0 + exposure ≥ floor → never', () => {
  const d = deps({ match: NIL_MATCH, exposure: { exposureTurns: 40, distinctStreams: 3, distinctSlugs: 3 } });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'never');
  assert.strictEqual(v.exposureTurns, 40);
  assert.strictEqual(v.exposureStreams, 3);
});

// ── 3. exposure floor — no `never` below MIN_EXPOSURE_TURNS ────────────────────
check('occurrences 0 + turns below floor → insufficient-exposure (never NOT reached)', () => {
  const d = deps({ match: NIL_MATCH, exposure: { exposureTurns: 5, distinctStreams: 3, distinctSlugs: 3 } });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'insufficient-exposure');
  assert.strictEqual(v.confidence, 'heuristic'); // watch-item forced to floor
});

// ── 4. exposure floor — no `never` below MIN_STREAMS ──────────────────────────
check('occurrences 0 + streams below floor → insufficient-exposure', () => {
  const d = deps({ match: NIL_MATCH, exposure: { exposureTurns: 100, distinctStreams: 1, distinctSlugs: 1 } });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'insufficient-exposure');
});

// ── 5. unmatchable short-circuit — unobservable, store NEVER queried ──────────
check('derivability unmatchable → unobservable, no store query', () => {
  const d = deps({ match: { occurrences: 99, distinctStreams: 9, distinctSlugs: 9, lastTsMs: 1 } });
  const v = classifyAction(pa({ kind: 'unmatchable', derivability: 'unmatchable', params: {} }), d);
  assert.strictEqual(v.status, 'unobservable');
  assert.strictEqual(v.unobservableReason, 'unmatchable');
  assert.strictEqual(v.predicate, null);
  assert.strictEqual(v.occurrences, 0);
  assert.strictEqual(d.calls, 0); // short-circuited before any store call
});

// ── 6. coarse server grant — toolset-usage w/ {server}, no {toolset} ──────────
check('toolset-usage coarse {server} (no toolset) → unobservable, no store query', () => {
  const d = deps({ match: { occurrences: 3, distinctStreams: 2, distinctSlugs: 1, lastTsMs: 2 } });
  const v = classifyAction(pa({ kind: 'toolset-usage', sourceKind: 'tool', params: { server: 'agent-dashboard' } }), d);
  assert.strictEqual(v.status, 'unobservable');
  assert.strictEqual(v.unobservableReason, 'coarse-server-grant');
  assert.strictEqual(d.calls, 0);
});

// ── 7. deferred kinds — workflow-sequence / decision-branch → unobservable ────
check('workflow-sequence → unobservable (sequence-deferred), no store query', () => {
  const d = deps({});
  const v = classifyAction(pa({ kind: 'workflow-sequence', derivability: 'heuristic', params: { sequence: 'a>b' } }), d);
  assert.strictEqual(v.status, 'unobservable');
  assert.strictEqual(v.unobservableReason, 'sequence-deferred');
  assert.strictEqual(d.calls, 0);
});
check('decision-branch → unobservable (branch-deferred)', () => {
  const d = deps({});
  const v = classifyAction(pa({ kind: 'decision-branch', derivability: 'heuristic', params: { branch: 'when x' } }), d);
  assert.strictEqual(v.status, 'unobservable');
  assert.strictEqual(v.unobservableReason, 'branch-deferred');
});

// ── 8. A3 subagent rule (REQUIRED) ────────────────────────────────────────────
// A subagent-only tool: occurrences exist ONLY when subagent streams are counted.
check('A3: subagent-only tool keeps toolset occurs but does NOT mark persona predicate occurs', () => {
  const matchFn: OccurrenceCounter['count'] = (_pred, o) =>
    o.includeSubagents
      ? { occurrences: 4, distinctStreams: 2, distinctSlugs: 1, lastTsMs: 5 } // subagent activity visible
      : NIL_MATCH;                                                            // primary-only: nothing
  // exposure below floor so the persona predicate lands on insufficient-exposure (NOT never, NOT occurs)
  const d = deps({ matchFn, exposure: { exposureTurns: 3, distinctStreams: 1, distinctSlugs: 1 } });

  // toolset-usage predicate from a *tool grant* (sourceKind 'tool') → includes subagents → occurs
  const toolset = classifyAction(
    pa({ kind: 'toolset-usage', sourceKind: 'tool', params: { toolset: 'observability' } }), d);
  assert.strictEqual(toolset.includeSubagents, true);
  assert.strictEqual(toolset.status, 'occurs');

  // persona/CLAUDE.md-derived tool-invocation (sourceKind 'capability') → excludes subagents → NOT occurs
  const persona = classifyAction(
    pa({ kind: 'tool-invocation', sourceKind: 'capability', params: { toolName: 'mcp__x__y' } }), d);
  assert.strictEqual(persona.includeSubagents, false);
  assert.notStrictEqual(persona.status, 'occurs');
  assert.strictEqual(persona.status, 'insufficient-exposure');
});

// ── 9. predicate mapping (param-name translation) ─────────────────────────────
check('param-name mapping → BehaviorPredicate', () => {
  const captured: BehaviorPredicate[] = [];
  const d: ClassifyDeps = {
    occurrence: { count: (pred) => { captured.push(pred); return NIL_MATCH; } },
    exposure: { resolve: () => NIL_EXPOSURE },
  };
  classifyAction(pa({ kind: 'command-family', params: { commandFamily: 'npm-run:build' } }), d);
  classifyAction(pa({ kind: 'path-touch', params: { pathGlob: 'src/**/*.ts' } }), d);
  classifyAction(pa({ kind: 'search-pattern', derivability: 'heuristic', params: { queryHash: 'abc123' } }), d);
  classifyAction(pa({ kind: 'skill-invocation', params: { skillName: 'deep-research' } }), d);
  assert.deepStrictEqual(captured[0], { kind: 'command-family', family: 'npm-run:build' });
  assert.deepStrictEqual(captured[1], { kind: 'path-touch', pathGlob: 'src/**/*.ts' });
  assert.deepStrictEqual(captured[2], { kind: 'search-pattern', signatureHash: 'abc123' });
  assert.deepStrictEqual(captured[3], { kind: 'skill-invocation', skillName: 'deep-research' });
});

// ── 10. confidence tier by derivability ───────────────────────────────────────
check('heuristic derivability → inferred; exact → observed', () => {
  const d = deps({ match: { occurrences: 1, distinctStreams: 1, distinctSlugs: 1, lastTsMs: 1 } });
  const heur = classifyAction(pa({ kind: 'search-pattern', derivability: 'heuristic', params: { queryHash: 'h' } }), d);
  assert.strictEqual(heur.confidence, 'inferred');
  const exact = classifyAction(pa({ kind: 'path-touch', derivability: 'exact', params: { pathGlob: 'a.ts' } }), d);
  assert.strictEqual(exact.confidence, 'observed');
});

// ── 11. epoch confidence surfaced for WP6 down-rank ───────────────────────────
check('epochConfidence surfaced from injected lookup; unknown when unwired', () => {
  const graded = deps({ match: NIL_MATCH, exposure: { exposureTurns: 40, distinctStreams: 3, distinctSlugs: 3 },
    epochConfidenceFor: (id) => (id === 'epoch-1' ? 'low' : 'high') });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'T' } }), graded);
  assert.strictEqual(v.epochConfidence, 'low');

  const unwired = deps({ match: NIL_MATCH, exposure: { exposureTurns: 40, distinctStreams: 3, distinctSlugs: 3 } });
  const v2 = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'T' } }), unwired);
  assert.strictEqual(v2.epochConfidence, 'unknown');

  // empty sourceEpochId ⇒ unknown even with a lookup present
  const v3 = classifyAction(pa({ kind: 'tool-invocation', sourceEpochId: '', params: { toolName: 'T' } }), graded);
  assert.strictEqual(v3.epochConfidence, 'unknown');
});

// ── 12. batch preserves order ─────────────────────────────────────────────────
check('classifyOccurrences preserves input order', () => {
  const d = deps({ match: { occurrences: 1, distinctStreams: 1, distinctSlugs: 1, lastTsMs: 1 } });
  const out = classifyOccurrences([
    pa({ id: 'a', kind: 'tool-invocation', params: { toolName: 'A' } }),
    pa({ id: 'b', kind: 'unmatchable', derivability: 'unmatchable', params: {} }),
    pa({ id: 'c', kind: 'path-touch', params: { pathGlob: 'c.ts' } }),
  ], d);
  assert.deepStrictEqual(out.map((v) => v.actionId), ['a', 'b', 'c']);
  assert.strictEqual(out[1].status, 'unobservable');
});

// ── 13. default seams wrap a BehaviorStore ────────────────────────────────────
check('defaultOccurrenceCounter forwards to store.countMatching', () => {
  let seen: { pred: BehaviorPredicate; lanes: unknown; since: unknown } | null = null;
  const store = {
    countMatching: (pred: BehaviorPredicate, lanes?: unknown, since?: unknown): MatchCount => {
      seen = { pred, lanes, since };
      return { occurrences: 7, distinctStreams: 2, distinctSlugs: 1, lastTsMs: 9 };
    },
  };
  const counter = defaultOccurrenceCounter(store as never);
  const r = counter.count({ kind: 'tool-invocation', toolName: 'Z' }, { lanes: ['worker'], includeSubagents: true, sinceMs: 42 });
  assert.strictEqual(r.occurrences, 7);
  assert.deepStrictEqual(seen!.lanes, ['worker']);
  assert.strictEqual(seen!.since, 42);
});

check('defaultExposureResolver sums exposureForLane over the action lanes', () => {
  const byLane: Record<string, Exposure> = {
    worker: { lane: 'worker', turnCount: 30, distinctStreams: 2, distinctSlugs: 1 },
    supervisor: { lane: 'supervisor', turnCount: 12, distinctStreams: 1, distinctSlugs: 1 },
  };
  const store = { exposureForLane: (lane: string): Exposure => byLane[lane] };
  const resolver = defaultExposureResolver(store as never);
  const e = resolver.resolve(pa({ lanes: ['worker', 'supervisor'] }), { includeSubagents: false });
  assert.strictEqual(e.exposureTurns, 42);
  assert.strictEqual(e.distinctStreams, 3);
  assert.strictEqual(e.distinctSlugs, 2);
});

// ══ WP-1A (Priority 0): fail-closed, auditable `never` ════════════════════════

// ── 16. auditable never — exact predicate + wired resolver ⇒ evidenceState auditable
check('never + wired resolver (all gates pass) → evidenceState auditable, evidence attached', () => {
  const pred: BehaviorPredicate = { kind: 'tool-invocation', toolName: 'Rare' };
  const ev = mkEvidence({ predicate: pred, normalizedMatcher: normalizeMatcher(pred) });
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR, evidence: stubEvidence(ev) });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'never');
  assert.strictEqual(v.evidenceState, 'auditable');
  assert.ok(v.evidence, 'evidence object attached');
  assert.ok(v.evidence!.denominator.sampledStreams.length >= 1, 'denominator sample present');
  assert.strictEqual(v.evidence!.matcherVersion, '7');
  assert.deepStrictEqual(v.evidence!.normalizedMatcher, { kind: 'tool-invocation', toolName: 'Rare' });
});

// ── 17. fail-closed gate (a): path-touch glob matcher is NOT canonical ────────
check('provisional-never with path-touch GLOB matcher → capture-incomplete / partial', () => {
  const pred: BehaviorPredicate = { kind: 'path-touch', pathGlob: 'src/**/*.ts' };
  const ev = mkEvidence({ predicate: pred, normalizedMatcher: normalizeMatcher(pred) });
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR, evidence: stubEvidence(ev) });
  const v = classifyAction(pa({ kind: 'path-touch', derivability: 'exact', params: { pathGlob: 'src/**/*.ts' } }), d);
  assert.strictEqual(v.status, 'capture-incomplete');
  assert.strictEqual(v.evidenceState, 'partial');
  assert.ok(v.evidence, 'evidence still attached so the reason is auditable');
});

// ── 18. fail-closed gate (b): file-access canonical but providers EMPTY ───────
check('provisional-never file-access, capture providers empty → capture-incomplete', () => {
  const ev = mkEvidence({ captureCoverage: { providers: {}, unknownToolEvents: 0, unresolvedPathEvents: 0 } });
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR, evidence: stubEvidence(ev) });
  const v = classifyAction(faPa(), d);
  assert.strictEqual(v.predicate?.kind, 'file-access');
  assert.strictEqual(v.status, 'capture-incomplete');
  assert.strictEqual(v.evidenceState, 'partial');
});

// ── 19. fail-closed gate (c): file-access unresolved-path rate ≥ threshold ────
check('provisional-never file-access, unresolved-path rate ≥ threshold → capture-incomplete', () => {
  // 10 unresolved / 40 turns = 0.25 ≥ NEVER_MAX_UNRESOLVED_PATH_RATE (0.10).
  const ev = mkEvidence({
    captureCoverage: { providers: { Read: { streams: 3, pathEventsSupported: true } }, unknownToolEvents: 0, unresolvedPathEvents: 10 },
  });
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR, evidence: stubEvidence(ev) });
  const v = classifyAction(faPa(), d);
  assert.strictEqual(v.predicate?.kind, 'file-access');
  assert.strictEqual(v.status, 'capture-incomplete');
  assert.strictEqual(v.evidenceState, 'partial');
});

// ── 20. fail-closed gate (d): gates otherwise pass but NO denominator sample ──
check('provisional-never with empty sampledStreams → capture-incomplete (not auditable)', () => {
  const ev = mkEvidence({ denominator: { turns: 40, streams: 3, slugs: 3, sampledStreams: [] } });
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR, evidence: stubEvidence(ev) });
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'capture-incomplete');
  assert.strictEqual(v.evidenceState, 'partial');
});

// ── 21. non-never verdicts carry evidenceState 'unavailable', no evidence ─────
check('non-never (occurs / insufficient) → evidenceState unavailable even with resolver wired', () => {
  const ev = mkEvidence();
  const occurs = classifyAction(
    pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }),
    deps({ match: { occurrences: 3, distinctStreams: 2, distinctSlugs: 1, lastTsMs: 9 }, exposure: OVER_FLOOR, evidence: stubEvidence(ev) }));
  assert.strictEqual(occurs.status, 'occurs');
  assert.strictEqual(occurs.evidenceState, 'unavailable');
  assert.strictEqual(occurs.evidence, undefined);

  const insufficient = classifyAction(
    pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }),
    deps({ match: NIL_MATCH, exposure: { exposureTurns: 5, distinctStreams: 1, distinctSlugs: 1 }, evidence: stubEvidence(ev) }));
  assert.strictEqual(insufficient.status, 'insufficient-exposure');
  assert.strictEqual(insufficient.evidenceState, 'unavailable');
});

// ── 22. legacy path: ABSENT resolver keeps `never`, stamps 'unavailable' ──────
check('never with NO resolver wired → legacy never + evidenceState unavailable (15 legacy cases stay green)', () => {
  const d = deps({ match: NIL_MATCH, exposure: OVER_FLOOR }); // no evidence dep
  const v = classifyAction(pa({ kind: 'tool-invocation', params: { toolName: 'Rare' } }), d);
  assert.strictEqual(v.status, 'never');
  assert.strictEqual(v.evidenceState, 'unavailable');
  assert.strictEqual(v.evidence, undefined);
});

console.log(`\n${passed} passed`);
