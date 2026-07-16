// WP3 behavior-enrichment unit tests — the status ladder + file-reference stats.
//   npm run build:main
//   node dist/main/main/agent-knowledge/knowledge-behavior-enrichment.test.js
//
// The rollup + file-ref seams are reader-injected, so these tests exercise the REAL
// predicate compiler (guidance-action-model) against a STUB BehaviorReader — no DB,
// no file IO. That isolates the ladder logic (observed / never-observed /
// insufficient-exposure / unobservable) and the r/w/x split.

import assert from 'node:assert/strict';
import type { KnowledgeNode } from '../../shared/types';
import type { BehaviorPredicate, FilePathUsage, MatchCount } from '../context-optimizer/behavior-store';
import { compileGuidanceActions, type CompileDeps } from '../context-optimizer/guidance-action-model';
import {
  rollUpBehavior, predicateFor, fileReferenceStatsForNode, type BehaviorReader,
} from './knowledge-behavior-enrichment';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const WINDOW = 30;
const SINCE = 1_000;

// Trivial compile deps — no resident targets needed to derive the predicate KINDS.
const COMPILE_DEPS: CompileDeps = {
  residentTargets: [],
  estimateTokens: () => 0,
};

function node(over: Partial<KnowledgeNode> & Pick<KnowledgeNode, 'type' | 'label'>): KnowledgeNode {
  return {
    source: { absPath: '/ws/CLAUDE.md', lineStart: 1, lineEnd: 1 },
    sourceRole: 'workspace-claude',
    ...over,
  };
}

function predKey(p: BehaviorPredicate): string {
  switch (p.kind) {
    case 'tool-invocation': return `tool:${p.toolName}`;
    case 'skill-invocation': return `skill:${p.skillName}`;
    case 'toolset-usage': return `toolset:${p.toolset}`;
    case 'command-family': return `cmd:${p.family}`;
    case 'path-touch': return `path:${p.pathGlob}`;
    case 'file-access': return `file:${p.path.canonicalAbs ?? p.path.workspaceRelative ?? p.path.raw}`;
    case 'search-pattern': return `search:${p.signatureHash}`;
  }
}

const EMPTY_MATCH: MatchCount = { occurrences: 0, distinctStreams: 0, distinctSlugs: 0, lastTsMs: null };
const EMPTY_USAGE: FilePathUsage = { touches: 0, reads: 0, writes: 0, executes: 0, distinctStreams: 0, lastTsMs: null };

function stubReader(over: { matches?: Record<string, MatchCount>; usage?: FilePathUsage } = {}): BehaviorReader {
  return {
    countMatching: (pred) => over.matches?.[predKey(pred)] ?? EMPTY_MATCH,
    usageForFilePath: () => over.usage ?? EMPTY_USAGE,
  };
}

function behaviorFor(n: KnowledgeNode, reader: BehaviorReader, exposureTurns: number) {
  const actions = compileGuidanceActions([n], COMPILE_DEPS);
  return rollUpBehavior(actions, reader, 'worker', SINCE, exposureTurns, WINDOW);
}

// ── ladder ──────────────────────────────────────────────────────────────────────

test('observed: a tool node whose predicate fired ≥1× → observed with counts', () => {
  const n = node({ type: 'tool', label: 'Bash' });
  const reader = stubReader({ matches: { 'tool:Bash': { occurrences: 4, distinctStreams: 2, distinctSlugs: 1, lastTsMs: 999 } } });
  const b = behaviorFor(n, reader, 12);
  assert.equal(b.status, 'observed');
  assert.equal(b.occurrences, 4);
  assert.equal(b.distinctStreams, 2);
  assert.equal(b.lastObservedMs, 999);
  assert.deepEqual(b.actionKinds, ['tool-invocation']);
  assert.match(b.explanation, /fired 4×/);
});

test('never-observed: observable + lane exposure but 0 matches → never-observed', () => {
  const n = node({ type: 'tool', label: 'Bash' });
  const b = behaviorFor(n, stubReader(), 12);
  assert.equal(b.status, 'never-observed');
  assert.equal(b.occurrences, 0);
  assert.match(b.explanation, /candidate for trim/);
});

test('insufficient-exposure: observable but the lane has 0 turns → insufficient', () => {
  const n = node({ type: 'tool', label: 'Bash' });
  const b = behaviorFor(n, stubReader(), 0);
  assert.equal(b.status, 'insufficient-exposure');
  assert.match(b.explanation, /too little corpus/);
});

test('unobservable: a pure-prose capability with no mechanical predicate → unobservable', () => {
  const n = node({ type: 'capability', label: 'Be concise and trust your supervisor.' });
  const b = behaviorFor(n, stubReader(), 50);
  assert.equal(b.status, 'unobservable');
  assert.equal(b.occurrences, 0);
  assert.deepEqual(b.actionKinds, ['unmatchable']);
  assert.match(b.explanation, /Pure prose/);
});

test('predicateFor maps a compiled path-touch action, and null for unmatchable', () => {
  const pathActions = compileGuidanceActions([node({ type: 'file-reference', label: 'memory/MEMORY.md' })], COMPILE_DEPS);
  assert.equal(pathActions.length, 1);
  const p = predicateFor(pathActions[0]);
  assert.deepEqual(p, { kind: 'path-touch', pathGlob: 'memory/MEMORY.md' });

  const proseActions = compileGuidanceActions([node({ type: 'capability', label: 'Be nice.' })], COMPILE_DEPS);
  assert.equal(predicateFor(proseActions[0]), null);
});

// ── file-reference stats ──────────────────────────────────────────────────────────

test('file-reference: usageForFilePath split into r/w/x + recency', () => {
  const n = node({ type: 'file-reference', label: '@behavioral-notes.md' });
  const reader = stubReader({ usage: { touches: 7, reads: 5, writes: 1, executes: 1, distinctStreams: 3, lastTsMs: 42 } });
  const stats = fileReferenceStatsForNode(n, reader, 'worker', SINCE, WINDOW);
  assert.equal(stats.touches, 7);
  assert.equal(stats.reads, 5);
  assert.equal(stats.writes, 1);
  assert.equal(stats.executes, 1);
  assert.equal(stats.distinctStreams, 3);
  assert.equal(stats.lastTouchedMs, 42);
  assert.equal(stats.windowDays, WINDOW);
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
