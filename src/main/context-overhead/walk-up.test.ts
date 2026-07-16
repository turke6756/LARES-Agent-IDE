// Context-Overhead Analyzer — walk-up + @import unit tests (plan §6, R5).
//   npm run build:main
//   node dist/main/main/context-overhead/walk-up.test.js

import assert from 'node:assert/strict';
import { analyzeWalkUp } from './walk-up';
import { makePathOps } from './paths';
import { TokenEstimator } from './token-estimator';
import type { FileReader } from './context-overhead-analyzer';
import type { OverheadSource } from '../../shared/types';

// NOTE: `extractClaudeImports` moved to the shared `claude-import-resolver`
// module (base plan §3.2); its unit tests live in `claude-import-resolver.test.ts`.
// walk-up only re-uses it internally, exercised via the @import recursion test below.

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── depth-limited recursion ───────────────────────────────────────────────────

function flatten(sources: OverheadSource[]): OverheadSource[] {
  const out: OverheadSource[] = [];
  const visit = (s: OverheadSource) => { out.push(s); for (const c of s.children ?? []) visit(c); };
  sources.forEach(visit);
  return out;
}

test('@import recursion stops at depth 4 with a warning; the 5th hop is never read', () => {
  const files: Record<string, string> = {
    '/root/CLAUDE.md': '@a.md',
    '/root/a.md': '@b.md',
    '/root/b.md': '@c.md',
    '/root/c.md': '@d.md',
    '/root/d.md': '@e.md',
    '/root/e.md': 'leaf',
  };
  const readLog: string[] = [];
  const reader: FileReader = {
    read(p) { readLog.push(p); const c = files[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return files[p] !== undefined; },
    listFiles() { return []; },
  };
  const frames = analyzeWalkUp('/root', '/root', {
    reader,
    estimator: new TokenEstimator(),
    pathOps: makePathOps('wsl'),
    userHome: '/home/u',
    managedPolicyPath: null,
    env: {},
    seen: new Set(),
  });
  const agentFrame = frames.find((f) => f.distanceFromAgentCwd === 0)!;
  const all = flatten(agentFrame.sources);
  const labels = all.map((s) => s.label);
  assert.ok(labels.includes('@a.md'), 'first import resolved');
  assert.ok(labels.includes('@d.md'), 'fourth import resolved');
  assert.ok(!labels.includes('@e.md'), 'fifth import must NOT be resolved');
  const d = all.find((s) => s.label === '@d.md')!;
  assert.ok((d.warnings ?? []).some((w) => w.includes('depth limit')), '@d.md carries the depth-limit warning');
  assert.ok(!readLog.includes('/root/e.md'), 'e.md must never be read');
});

// ── skill header/body costing split (P1.1) ────────────────────────────────────

test('SKILL.md splits into skill-header (baseline) + skill-body (scenario) sources', () => {
  const skillPath = '/ws/agent/.claude/skills/demo/SKILL.md';
  const content = [
    '---',
    'name: demo',
    'description: A demo skill for testing.',
    '---',
    '',
    'This is the on-invoke body with a fair amount of prose so its token',
    'estimate is clearly larger than the tiny YAML header block above it.',
    'More body text to make the body substantially bigger than the header.',
  ].join('\n');
  const files: Record<string, string> = { [skillPath]: content };
  const reader: FileReader = {
    read(p) { const c = files[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return files[p] !== undefined; },
    listFiles(glob) { return glob.includes('/skills/') ? [skillPath] : []; },
  };
  const frames = analyzeWalkUp('/ws/agent', '/ws', {
    reader,
    estimator: new TokenEstimator(),
    pathOps: makePathOps('wsl'),
    userHome: '/home/u',
    managedPolicyPath: null,
    env: {},
    seen: new Set(),
  });
  const all = frames.flatMap((f) => flatten(f.sources));
  const header = all.find((s) => s.kind === 'skill-header');
  const body = all.find((s) => s.kind === 'skill-body');
  assert.ok(header, 'a skill-header source is emitted');
  assert.ok(body, 'a skill-body source is emitted');
  assert.ok(!all.some((s) => s.kind === 'skill'), 'legacy "skill" kind is no longer emitted');
  assert.equal(header!.disclosureState, 'advertised-header');
  assert.equal(body!.disclosureState, 'scenario-body');
  assert.equal(header!.origin, 'frontmatter-split');
  assert.equal(body!.origin, 'frontmatter-split');
  assert.equal(header!.mutable, 'user-owned', 'a plain workspace skills path → user-owned');
  assert.equal(header!.resolvedPath, skillPath);
  assert.equal(body!.resolvedPath, skillPath);
  assert.ok(header!.estimate.tokens > 0, 'header carries a non-zero estimate');
  assert.ok(body!.estimate.tokens > header!.estimate.tokens, 'body estimate exceeds header estimate');
});

// ── memory resident/on-demand costing split (Wave-2 §C2) ──────────────────────

test('MEMORY.md splits into memory-index (resident, 0 tokens) + memory-body (on-demand, measured)', () => {
  const memPath = '/ws/agent/memory/MEMORY.md';
  const content = [
    '# Supervisor memory index',
    '',
    'A large body of progressively-disclosed notes that is read on demand at the',
    'agent\'s discretion — NOT injected into context every session. Lots of prose',
    'here so the measured body estimate is clearly greater than zero.',
  ].join('\n');
  const files: Record<string, string> = { [memPath]: content };
  const reader: FileReader = {
    read(p) { const c = files[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return files[p] !== undefined; },
    listFiles() { return []; },
  };
  const frames = analyzeWalkUp('/ws/agent', '/ws', {
    reader, estimator: new TokenEstimator(), pathOps: makePathOps('wsl'),
    userHome: '/home/u', managedPolicyPath: null, env: {}, seen: new Set(),
  });
  const all = frames.flatMap((f) => flatten(f.sources));
  const index = all.find((s) => s.kind === 'memory-index');
  const body = all.find((s) => s.kind === 'memory-body');
  assert.ok(index, 'a memory-index source is emitted');
  assert.ok(body, 'a memory-body source is emitted');
  assert.ok(!all.some((s) => s.kind === 'memory'), 'legacy "memory" kind is no longer emitted');
  assert.equal(index!.disclosureTier, 'resident', 'the index tier is resident');
  assert.equal(body!.disclosureTier, 'on-demand', 'the body tier is on-demand');
  assert.equal(index!.estimate.tokens, 0, 'the resident index costs 0 tokens (nothing injected)');
  assert.ok(body!.estimate.tokens > 0, 'the on-demand body carries its measured size');
  assert.equal(index!.resolvedPath, memPath);
  assert.equal(body!.resolvedPath, memPath, 'both rows share the file path (click opens MEMORY.md)');
  assert.ok((index!.warnings ?? []).some((w) => w.includes('resident cost is 0')),
    'the index row explains why its resident cost is 0');
});

test('a fenceless SKILL.md still splits (low confidence) and warns on the header row', () => {
  const skillPath = '/ws/agent/.claude/skills/raw/SKILL.md';
  const files: Record<string, string> = { [skillPath]: '# Raw\n\nNo frontmatter here, just body prose.' };
  const reader: FileReader = {
    read(p) { const c = files[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return files[p] !== undefined; },
    listFiles(glob) { return glob.includes('/skills/') ? [skillPath] : []; },
  };
  const frames = analyzeWalkUp('/ws/agent', '/ws', {
    reader, estimator: new TokenEstimator(), pathOps: makePathOps('wsl'),
    userHome: '/home/u', managedPolicyPath: null, env: {}, seen: new Set(),
  });
  const all = frames.flatMap((f) => flatten(f.sources));
  const header = all.find((s) => s.kind === 'skill-header')!;
  assert.ok((header.warnings ?? []).some((w) => w.toLowerCase().includes('synthesized')),
    'fenceless header row carries a low-confidence warning');
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
