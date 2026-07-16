// workspace-lineage.ts tests — workspace-LEVEL identity resolution (Priority 0 / WP-2B).
// Pure + IO-free, so no DB stand-in is needed: we exercise the fold + resolve directly.
//
//   npm run build:main
//   node dist/main/main/skill-analytics/workspace-lineage.test.js

import assert from 'node:assert/strict';
import {
  foldLaunchCwdToWorkspaceRoot,
  resolveWorkspaceForCwd,
  WORKSPACE_LINEAGE_VERSION,
  type WorkspaceRecordLite,
} from './workspace-lineage';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Comparison key: forward-slash, no trailing sep, lowercased (case-insensitive for
 *  Windows drives — matches the module's own normKey). */
function norm(p: string | null): string | null {
  return p == null ? null : p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ── foldLaunchCwdToWorkspaceRoot: strip each recognized .dashboard/** tail ──
test('fold — strips the supervisor template tail to the workspace root', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:/proj/.dashboard/supervisor')), 'c:/proj');
});
test('fold — strips the worker/claude template tail', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:/proj/.dashboard/workers/claude')), 'c:/proj');
});
test('fold — strips the researcher template tail', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:/proj/.dashboard/researcher')), 'c:/proj');
});
test('fold — strips the workers/codex template tail', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:/a/b/.dashboard/workers/codex')), 'c:/a/b');
});
test('fold — accepts backslash (Windows) launch cwd', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:\\proj\\.dashboard\\supervisor')), 'c:/proj');
});

// ── no-tail cwd is returned canonicalized as-is (legacy in-root launch) ──
test('fold — a cwd with no template tail folds to itself (legacy in-root launch)', () => {
  assert.equal(norm(foldLaunchCwdToWorkspaceRoot('C:/proj')), 'c:/proj');
});

// ── bare template dir with no parent → workspace unknowable → null ──
test('fold — a bare .dashboard/** tail with no parent folds to null', () => {
  assert.equal(foldLaunchCwdToWorkspaceRoot('.dashboard/supervisor'), null);
  assert.equal(foldLaunchCwdToWorkspaceRoot('.dashboard/workers/claude'), null);
});

// ── unusable input → null ──
test('fold — empty / whitespace / null input folds to null', () => {
  assert.equal(foldLaunchCwdToWorkspaceRoot(''), null);
  assert.equal(foldLaunchCwdToWorkspaceRoot('   '), null);
  assert.equal(foldLaunchCwdToWorkspaceRoot(null), null);
  assert.equal(foldLaunchCwdToWorkspaceRoot(undefined), null);
});

// ── resolveWorkspaceForCwd: UNIQUE owner → lineage(method='root') ──
test('resolve — a folded root owned by EXACTLY one workspace resolves to its id', () => {
  const wss: WorkspaceRecordLite[] = [
    { id: 'ws1', path: 'C:/proj' },
    { id: 'ws2', path: 'C:/other' },
  ];
  const lineage = resolveWorkspaceForCwd('C:/proj/.dashboard/workers/claude', wss);
  assert.ok(lineage, 'unique owner resolves');
  assert.equal(lineage!.workspaceId, 'ws1');
  assert.equal(norm(lineage!.workspaceRoot), 'c:/proj');
  assert.equal(lineage!.method, 'root', 'the folding resolver only ever claims method=root');
});

test('resolve — case-insensitive drive/root match (Windows)', () => {
  const wss: WorkspaceRecordLite[] = [{ id: 'ws1', path: 'c:\\Proj' }];
  const lineage = resolveWorkspaceForCwd('C:/PROJ/.dashboard/supervisor', wss);
  assert.ok(lineage, 'differing case still resolves the same workspace');
  assert.equal(lineage!.workspaceId, 'ws1');
});

// ── AMBIGUOUS (> 1 workspace owns the folded root) → null (leak firewall) ──
test('resolve — a root owned by TWO workspaces resolves to null (never guesses)', () => {
  const wss: WorkspaceRecordLite[] = [
    { id: 'ws1', path: 'C:/proj' },
    { id: 'ws2', path: 'C:/proj' }, // duplicate ownership → ambiguous
  ];
  assert.equal(resolveWorkspaceForCwd('C:/proj/.dashboard/supervisor', wss), null);
});

// ── NO owner (folded root matches no workspace) → null ──
test('resolve — a root owned by NO workspace resolves to null', () => {
  const wss: WorkspaceRecordLite[] = [{ id: 'ws2', path: 'C:/other' }];
  assert.equal(resolveWorkspaceForCwd('C:/proj/.dashboard/supervisor', wss), null);
});

// ── bare-tail / unusable cwd → null even with a registry ──
test('resolve — an unknowable (bare-tail) cwd resolves to null', () => {
  const wss: WorkspaceRecordLite[] = [{ id: 'ws1', path: 'C:/proj' }];
  assert.equal(resolveWorkspaceForCwd('.dashboard/supervisor', wss), null);
  assert.equal(resolveWorkspaceForCwd(null, wss), null);
});

// ── workspaces with an empty path are skipped, not matched ──
test('resolve — a registry row with an empty path never matches', () => {
  const wss: WorkspaceRecordLite[] = [{ id: 'wsEmpty', path: '' }, { id: 'ws1', path: 'C:/proj' }];
  const lineage = resolveWorkspaceForCwd('C:/proj/.dashboard/supervisor', wss);
  assert.equal(lineage!.workspaceId, 'ws1');
});

test('version — the resolver version constant is a positive integer', () => {
  assert.ok(Number.isInteger(WORKSPACE_LINEAGE_VERSION) && WORKSPACE_LINEAGE_VERSION >= 1);
});

// ── runner ──
let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
