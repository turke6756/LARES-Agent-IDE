// claude-import-resolver unit tests (base plan §3.2). Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/shared/claude-import-resolver.test.js

import assert from 'node:assert/strict';
import { extractClaudeImports, resolveClaudeImports } from './claude-import-resolver';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// A tiny in-memory filesystem for readFn. POSIX paths keep the tests portable.
function fsOf(files: Record<string, string>): (p: string) => string | null {
  return (p) => (p in files ? files[p] : null);
}

// ── extractClaudeImports (moved verbatim from walk-up) ──

test('extract: line/whitespace-anchored @tokens in document order', () => {
  assert.deepEqual(extractClaudeImports('@a/b.md then @c.md'), ['a/b.md', 'c.md']);
});

test('extract: skips fenced + inline code and email-like @', () => {
  const md = 'text foo@bar.com\n```\n@fenced.md\n```\ninline `@span.md` end @real.md';
  assert.deepEqual(extractClaudeImports(md), ['real.md']);
});

// ── resolveClaudeImports ──

test('resolve: relative import joined to parent dir, depth 1, exists', () => {
  const files = { '/w/CLAUDE.md': '@rules/style.md', '/w/rules/style.md': 'be nice' };
  const r = resolveClaudeImports('/w/CLAUDE.md', fsOf(files));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolvedPath, '/w/rules/style.md');
  assert.equal(r[0].depth, 1);
  assert.equal(r[0].exists, true);
  assert.equal(r[0].duplicate, false);
});

test('resolve: absolute import kept as-is', () => {
  const files = { '/w/CLAUDE.md': '@/etc/policy.md', '/etc/policy.md': 'x' };
  const r = resolveClaudeImports('/w/CLAUDE.md', fsOf(files));
  assert.equal(r[0].resolvedPath, '/etc/policy.md');
});

test('resolve: transitive imports recurse and increment depth', () => {
  const files = {
    '/w/CLAUDE.md': '@a.md',
    '/w/a.md': '@b.md',
    '/w/b.md': 'leaf',
  };
  const r = resolveClaudeImports('/w/CLAUDE.md', fsOf(files));
  assert.deepEqual(r.map((x) => [x.resolvedPath, x.depth]), [
    ['/w/a.md', 1],
    ['/w/b.md', 2],
  ]);
});

test('resolve: cycles are broken via dedup (duplicate flag, no infinite loop)', () => {
  const files = { '/w/a.md': '@b.md', '/w/b.md': '@a.md' };
  const r = resolveClaudeImports('/w/a.md', fsOf(files));
  // a → b (fresh), b → a (duplicate: root already seen).
  assert.equal(r.length, 2);
  assert.equal(r[0].resolvedPath, '/w/b.md');
  assert.equal(r[0].duplicate, false);
  assert.equal(r[1].resolvedPath, '/w/a.md');
  assert.equal(r[1].duplicate, true);
});

test('resolve: missing import recorded with exists=false, not recursed', () => {
  const files = { '/w/CLAUDE.md': '@gone.md' };
  const r = resolveClaudeImports('/w/CLAUDE.md', fsOf(files));
  assert.equal(r.length, 1);
  assert.equal(r[0].exists, false);
});

test('resolve: maxDepth stops expansion (depthLimited flagged)', () => {
  const files = {
    '/w/0.md': '@1.md', '/w/1.md': '@2.md', '/w/2.md': '@3.md', '/w/3.md': 'leaf',
  };
  const r = resolveClaudeImports('/w/0.md', fsOf(files), 2);
  // depth 1 (/w/1.md) and depth 2 (/w/2.md) resolve; depth 2 is depthLimited so
  // /w/3.md is never reached.
  assert.deepEqual(r.map((x) => x.resolvedPath), ['/w/1.md', '/w/2.md']);
  assert.equal(r[1].depthLimited, true);
});

test('resolve: shared import deduped across two parents', () => {
  const files = {
    '/w/CLAUDE.md': '@a.md\n@b.md',
    '/w/a.md': '@shared.md',
    '/w/b.md': '@shared.md',
    '/w/shared.md': 'once',
  };
  const r = resolveClaudeImports('/w/CLAUDE.md', fsOf(files));
  const shared = r.filter((x) => x.resolvedPath === '/w/shared.md');
  assert.equal(shared.length, 2);
  assert.equal(shared.filter((x) => !x.duplicate).length, 1, 'counted exactly once');
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
