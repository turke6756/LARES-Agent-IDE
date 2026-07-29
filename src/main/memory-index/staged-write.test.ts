// staged-write.test.ts — WP-F1 transactional multi-copy writer.
//
// Covers the acceptance criteria that live at the staging layer:
//   - a clean multi-write lands every copy and returns per-target receipts;
//   - a SECOND-rename failure restores every already-renamed target (delete a
//     freshly-created one; rewrite prior bytes for a pre-existing one) and
//     removes every staged tmp;
//   - a target holding DIFFERING content is a conflict (never overwritten),
//     independent of preexisted;
//   - publication SHARES the scaffold lock (acquireWorkspaceLock defaults to the
//     scaffold lock rel and is mutually exclusive at the mkdir level).
//
// Pure filesystem (windows pathType) against a temp dir — no DB, no Electron.
//   npm run build:main
//   node dist/main/main/memory-index/staged-write.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stagedMultiWrite, StagedWriteConflictError, type StageTarget } from './staged-write';
import { acquireWorkspaceLock, SCAFFOLD_LOCK_REL } from '../scaffold-writer';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const PT = 'windows';
const noLock = () => () => { /* no real lock in unit tests */ };

function mkWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'staged-write-'));
}
function full(workDir: string, rel: string): string {
  return path.join(workDir, rel);
}
function target(workDir: string, rel: string, content: string): StageTarget {
  return { workDir, relPath: rel, content };
}

// ── clean multi-write ──────────────────────────────────────────────────
test('a clean multi-write lands every copy and returns committed receipts', () => {
  const wd = mkWorkDir();
  const rels = ['a/x/SKILL.md', 'b/x/SKILL.md', 'c/x/SKILL.md'];
  const res = stagedMultiWrite(rels.map((r) => target(wd, r, 'BODY')), PT, noLock);
  for (const r of rels) {
    assert.equal(fs.readFileSync(full(wd, r), 'utf8'), 'BODY', `${r} landed`);
    assert.ok(!fs.existsSync(full(wd, `${r}.tmp`)), `${r}.tmp removed`);
  }
  assert.equal(res.receipts.length, 3);
  assert.ok(res.receipts.every((rc) => rc.committed && !rc.preexisted));
});

// ── second-rename failure → restore + tmps removed (fresh target) ────────
test('second-rename failure restores a freshly-created first target and removes all tmps', () => {
  const wd = mkWorkDir();
  const rel1 = 'one/SKILL.md';
  const rel2 = 'two/SKILL.md';
  // Force target2's rename to fail: pre-create a DIRECTORY where its final file
  // should go, so renameSync(tmp → final) throws (can't rename a file over a dir).
  fs.mkdirSync(full(wd, rel2), { recursive: true });

  assert.throws(() => stagedMultiWrite([target(wd, rel1, 'B1'), target(wd, rel2, 'B2')], PT, noLock));

  // rel1 was renamed then restored (it did not pre-exist → deleted).
  assert.ok(!fs.existsSync(full(wd, rel1)), 'the committed-then-failed first target was rolled back (deleted)');
  // every staged tmp is gone.
  assert.ok(!fs.existsSync(full(wd, `${rel1}.tmp`)), 'tmp1 removed');
  assert.ok(!fs.existsSync(full(wd, `${rel2}.tmp`)), 'tmp2 removed');
  // the blocking dir is untouched.
  assert.ok(fs.statSync(full(wd, rel2)).isDirectory(), 'the pre-existing blocker is untouched');
});

// ── second-rename failure → restore prior bytes for a PRE-existing target ─
test('second-rename failure rewrites prior bytes for a pre-existing first target', () => {
  const wd = mkWorkDir();
  const rel1 = 'one/SKILL.md';
  const rel2 = 'two/SKILL.md';
  // rel1 pre-exists with the SAME content we publish (a differing prior would be
  // a conflict, not a restore) — so restore must rewrite it back intact.
  fs.mkdirSync(path.dirname(full(wd, rel1)), { recursive: true });
  fs.writeFileSync(full(wd, rel1), 'BODY', 'utf8');
  fs.mkdirSync(full(wd, rel2), { recursive: true }); // block rel2's rename

  assert.throws(() => stagedMultiWrite([target(wd, rel1, 'BODY'), target(wd, rel2, 'BODY')], PT, noLock));

  assert.equal(fs.readFileSync(full(wd, rel1), 'utf8'), 'BODY', 'the pre-existing first target was restored to its prior bytes');
  assert.ok(!fs.existsSync(full(wd, `${rel1}.tmp`)) && !fs.existsSync(full(wd, `${rel2}.tmp`)), 'tmps removed');
});

// ── conflict: differing content is never overwritten ─────────────────────
test('a target holding DIFFERING content is a conflict and is never overwritten', () => {
  const wd = mkWorkDir();
  const rel1 = 'one/SKILL.md';
  const rel2 = 'two/SKILL.md';
  fs.mkdirSync(path.dirname(full(wd, rel2)), { recursive: true });
  fs.writeFileSync(full(wd, rel2), 'FOREIGN EDIT', 'utf8'); // differs from intended

  assert.throws(
    () => stagedMultiWrite([target(wd, rel1, 'BODY'), target(wd, rel2, 'BODY')], PT, noLock),
    (e: unknown) => e instanceof StagedWriteConflictError,
  );
  // Nothing was committed: rel1 not created, rel2 untouched, no tmps left.
  assert.ok(!fs.existsSync(full(wd, rel1)), 'no copy committed on a conflict');
  assert.equal(fs.readFileSync(full(wd, rel2), 'utf8'), 'FOREIGN EDIT', 'the differing target was NOT overwritten');
  assert.ok(!fs.existsSync(full(wd, `${rel1}.tmp`)) && !fs.existsSync(full(wd, `${rel2}.tmp`)), 'tmps removed');
});

// ── shared scaffold lock ─────────────────────────────────────────────────
test('acquireWorkspaceLock defaults to the scaffold lock rel and is mutually exclusive', () => {
  const wd = mkWorkDir();
  const lockDir = full(wd, SCAFFOLD_LOCK_REL);
  const release = acquireWorkspaceLock(wd, PT); // default rel = SCAFFOLD_LOCK_REL
  try {
    assert.ok(fs.existsSync(lockDir), 'the shared scaffold lock dir was created (publication shares it)');
    // A raw mkdir of the same lock dir fails while held → mutual exclusion.
    assert.throws(() => fs.mkdirSync(lockDir), 'the held lock excludes a concurrent acquisition');
  } finally {
    release();
  }
  assert.ok(!fs.existsSync(lockDir), 'the lock dir is removed on release');
});

// ── Run ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
