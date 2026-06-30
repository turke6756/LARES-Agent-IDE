// Context-Overhead Analyzer — walk-up + @import unit tests (plan §6, R5).
//   npm run build:main
//   node dist/main/main/context-overhead/walk-up.test.js

import assert from 'node:assert/strict';
import { extractClaudeImports, analyzeWalkUp } from './walk-up';
import { makePathOps } from './paths';
import { TokenEstimator } from './token-estimator';
import type { FileReader } from './context-overhead-analyzer';
import type { OverheadSource } from '../../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── extractClaudeImports ──────────────────────────────────────────────────────

test('extractClaudeImports: skips fenced code blocks', () => {
  const md = '```\n@inside.md\n```\nbody @outside.md';
  assert.deepEqual(extractClaudeImports(md), ['outside.md']);
});

test('extractClaudeImports: skips inline code spans and backtick-escaped tokens', () => {
  assert.deepEqual(extractClaudeImports('`@inline.md` and @real.md'), ['real.md']);
  assert.deepEqual(extractClaudeImports('see `@README` for notes'), []);
});

test('extractClaudeImports: absolute + relative paths, multiple in document order', () => {
  assert.deepEqual(extractClaudeImports('@/abs/one.md then @rel/two.md and @three.md'), [
    '/abs/one.md',
    'rel/two.md',
    'three.md',
  ]);
});

test('extractClaudeImports: an email-like token is not an import', () => {
  assert.deepEqual(extractClaudeImports('contact foo@bar.com please'), []);
});

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

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
