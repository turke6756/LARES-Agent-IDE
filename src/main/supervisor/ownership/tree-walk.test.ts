// Unit tests — verified tree walk (D4 tree-walk). Run:
//   npm run build:main
//   node dist/main/main/supervisor/ownership/tree-walk.test.js

import assert from 'node:assert/strict';
import { collectTree, verifyRoot, findVerifiedTree } from './tree-walk';
import type { ProcessInfo } from './types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const procs = (...rows: [pid: number, ppid: number][]): ProcessInfo[] =>
  rows.map(([pid, parentPid]) => ({ pid, parentPid }));

// ── collectTree ───────────────────────────────────────────────────────────────

test('collectTree gathers the whole subtree including the root', () => {
  // 100 → {200, 201}; 200 → {300}. Plus an unrelated 999.
  const table = procs([100, 4], [200, 100], [201, 100], [300, 200], [999, 4]);
  const pids = collectTree(100, table).sort((a, b) => a - b);
  assert.deepEqual(pids, [100, 200, 201, 300]);
});

test('collectTree returns [] when the root process is gone (children reparented)', () => {
  // root 100 absent; its former child 200 now parented to 4 (reparent).
  const table = procs([200, 4], [300, 200]);
  assert.deepEqual(collectTree(100, table), []);
});

test('collectTree is cycle-safe', () => {
  const table = procs([100, 200], [200, 100]); // mutual parent cycle
  const pids = collectTree(100, table).sort((a, b) => a - b);
  assert.deepEqual(pids, [100, 200]);
});

// ── verifyRoot (PID-reuse guard) ────────────────────────────────────────────────

test('verifyRoot matches when the live creation time equals the stored one', () => {
  const r = verifyRoot(100, 'CT_A', () => 'CT_A');
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'match');
});

test('verifyRoot REJECTS a reused PID: same PID, different creation time', () => {
  const r = verifyRoot(100, 'CT_A', () => 'CT_B');
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'creation-mismatch');
});

test('verifyRoot reports root-gone when the PID no longer exists', () => {
  const r = verifyRoot(100, 'CT_A', () => null);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'root-gone');
});

test('verifyRoot is unverifiable when no creation time was ever stored', () => {
  const r = verifyRoot(100, null, () => 'CT_A');
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no-stored-creation');
});

test('verifyRoot is unverifiable when the creation-time source throws (native off)', () => {
  const r = verifyRoot(100, 'CT_A', () => { throw new Error('native unavailable'); });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no-creation-source');
});

// ── findVerifiedTree ────────────────────────────────────────────────────────────

test('findVerifiedTree returns a verified tree to terminate on a match', () => {
  const table = procs([100, 4], [200, 100], [300, 200]);
  const res = findVerifiedTree({ rootPid: 100, pidCreationTime: 'CT_A' }, table, () => 'CT_A');
  assert.equal(res.status, 'tree');
  assert.deepEqual(res.pids.sort((a, b) => a - b), [100, 200, 300]);
});

test('findVerifiedTree returns no-tree (safe) when the PID was reused', () => {
  // PID 100 exists but is a DIFFERENT process now (creation time differs).
  const table = procs([100, 4], [200, 100]);
  const res = findVerifiedTree({ rootPid: 100, pidCreationTime: 'CT_A' }, table, () => 'CT_B');
  assert.equal(res.status, 'no-tree');
  assert.deepEqual(res.pids, []);
});

test('findVerifiedTree returns no-tree when the root is gone', () => {
  const res = findVerifiedTree({ rootPid: 100, pidCreationTime: 'CT_A' }, procs([200, 4]), () => null);
  assert.equal(res.status, 'no-tree');
});

test('findVerifiedTree is unverifiable (fail-closed) when native cannot supply a creation time', () => {
  const table = procs([100, 4], [200, 100]);
  const res = findVerifiedTree(
    { rootPid: 100, pidCreationTime: 'CT_A' },
    table,
    () => { throw new Error('native off'); },
  );
  assert.equal(res.status, 'unverifiable');
  assert.deepEqual(res.pids, []);
});

test('findVerifiedTree is unverifiable when no creation time was recorded at spawn', () => {
  const table = procs([100, 4], [200, 100]);
  const res = findVerifiedTree({ rootPid: 100, pidCreationTime: null }, table, () => 'CT_A');
  assert.equal(res.status, 'unverifiable');
});

test('findVerifiedTree treats a null rootPid (WSL row) as no-tree', () => {
  const res = findVerifiedTree({ rootPid: null, pidCreationTime: null }, [], () => null);
  assert.equal(res.status, 'no-tree');
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
