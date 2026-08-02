// Grok folder-trust tests (Phase 3 of the grok provider lane).
//
// Exercises the pure helpers behind ensureGrokTrust:
//   - grokTrustPathKey: ONE canonical key = canonical(gitRoot(dir) ?? dir);
//     git-backed dir → repo root, non-git dir → itself, realpathSync.native
//     spelling (Phase 0.2), unsafe roots refused.
//   - mergeGrokFolderTrust: line-aware [folders."<key>"] merge — create, no-op
//     when all trusted, flip trusted=false→true preserving neighbors, preserve
//     unrelated entries, refuse malformed / duplicate-ambiguous stores.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/grok-trust.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  grokTrustPathKey,
  mergeGrokFolderTrust,
} from './index';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── grokTrustPathKey ─────────────────────────────────────────────────────

test('non-windows pathType is skipped (WSL out of scope) → null', () => {
  assert.equal(grokTrustPathKey('/home/turke/ws', 'wsl'), null);
});

test('non-absolute path → null', () => {
  assert.equal(grokTrustPathKey('relative\\ws', 'windows'), null);
  assert.equal(grokTrustPathKey('', 'windows'), null);
});

test('filesystem root and home dir are refused → null', () => {
  assert.equal(grokTrustPathKey('C:\\', 'windows'), null);
  const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]+$/, '');
  if (home) {
    assert.equal(grokTrustPathKey(home, 'windows'), null, 'home dir itself must be refused');
    // Case-insensitive match: an upper-cased home spelling is still the home dir.
    assert.equal(grokTrustPathKey(home.toUpperCase(), 'windows'), null);
  }
});

test('non-git dir → the dir itself, in realpathSync.native spelling', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-key-'));
  try {
    const sub = path.join(base, 'MixedCase_Repo', 'SubDir');
    fs.mkdirSync(sub, { recursive: true });
    const expected = fs.realpathSync.native(sub);
    // Correct-case input.
    assert.equal(grokTrustPathKey(sub, 'windows'), expected);
    // Wrong-case input still normalizes to the true on-disk spelling (Windows).
    if (process.platform === 'win32') {
      assert.equal(grokTrustPathKey(sub.toLowerCase(), 'windows'), expected,
        'lower-cased input must resolve to the true on-disk case');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('git-backed dir → repo root (shallowest .git ancestor)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-git-'));
  try {
    const repo = path.join(base, 'repo');
    const deep = path.join(repo, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });  // .git as a directory
    const expected = fs.realpathSync.native(repo);
    assert.equal(grokTrustPathKey(deep, 'windows'), expected, 'deep cwd collapses to the repo root');
    assert.equal(grokTrustPathKey(repo, 'windows'), expected, 'the repo root maps to itself');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('.git as a FILE (worktree/submodule) is also recognized as a repo root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-gitfile-'));
  try {
    const repo = path.join(base, 'linked');
    const sub = path.join(repo, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: ../real/.git\n');
    const expected = fs.realpathSync.native(repo);
    assert.equal(grokTrustPathKey(sub, 'windows'), expected);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('parent git-root trust covers .lares/workers/grok (upward collapse rationale)', () => {
  // The workspace root and the grok worker cwd (.lares/workers/grok) both sit
  // under one outer git repo. grokTrustPathKey collapses BOTH to that repo
  // root, so ensureGrokTrust dedupes them to a single key that grok's
  // component-wise starts_with lookup then cascades back down to the worker cwd.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-collapse-'));
  try {
    const repo = path.join(base, 'workspace');
    const workerCwd = path.join(repo, '.lares', 'workers', 'grok');
    fs.mkdirSync(workerCwd, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const expected = fs.realpathSync.native(repo);
    const rootKey = grokTrustPathKey(repo, 'windows');
    const workerKey = grokTrustPathKey(workerCwd, 'windows');
    assert.equal(rootKey, expected);
    assert.equal(workerKey, expected, 'the grok worker cwd collapses to the same git root');
    assert.equal(rootKey, workerKey, 'both dirs dedupe to ONE canonical key');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('nested worker repo (Commit 6): outer git-backed → outer root; non-git → worker cwd itself', () => {
  // Commit 6 git-init's the grok worker cwd so grok's projectRoot resolves to it.
  // grokTrustPathKey walks up for the SHALLOWEST `.git`, so its key depends on
  // whether an ancestor is ALSO a repo — both branches must still yield a valid,
  // safe key that COVERS the worker cwd (grok's component-wise starts_with lookup
  // cascades a parent-key trust down to the projectRoot).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-nested-'));
  try {
    // (a) Outer workspace is git-backed AND the worker cwd is now its own repo.
    //     Shallowest .git wins → the OUTER root; trust cascades down to the cwd.
    const outer = path.join(base, 'gitws');
    const outerWorker = path.join(outer, '.lares', 'workers', 'grok');
    fs.mkdirSync(outerWorker, { recursive: true });
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });        // outer repo
    fs.mkdirSync(path.join(outerWorker, '.git'), { recursive: true });  // Commit 6 nested repo
    const outerKey = grokTrustPathKey(outerWorker, 'windows');
    assert.equal(outerKey, fs.realpathSync.native(outer),
      'nested worker repo under a git-backed workspace still collapses to the OUTER root (shallowest .git)');

    // (b) Non-git workspace: the ONLY `.git` is the worker cwd's own (Commit 6),
    //     so the key IS the worker cwd itself — grok now finds a valid projectRoot
    //     where before there was none.
    const plain = path.join(base, 'plainws');
    const plainWorker = path.join(plain, '.lares', 'workers', 'grok');
    fs.mkdirSync(plainWorker, { recursive: true });
    fs.mkdirSync(path.join(plainWorker, '.git'), { recursive: true });  // Commit 6 nested repo only
    const plainKey = grokTrustPathKey(plainWorker, 'windows');
    assert.equal(plainKey, fs.realpathSync.native(plainWorker),
      'in a non-git workspace the worker cwd is its own root → its own trust key');
    // The produced key must be a safe, writable trust key (not refused as junk).
    assert.ok(plainKey !== null && mergeGrokFolderTrust(null, [plainKey]) !== null,
      'the worker-cwd key must be seedable into the trust store');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── mergeGrokFolderTrust ─────────────────────────────────────────────────

const KEY_A = 'C:\\Users\\turke\\Projects\\WS';
const KEY_B = 'C:\\Users\\turke\\Projects\\OTHER';

test('empty store → created with the one canonical key, trusted = true', () => {
  const merged = mergeGrokFolderTrust(null, [KEY_A]);
  assert.ok(merged !== null);
  assert.ok(merged.includes('[folders."C:\\\\Users\\\\turke\\\\Projects\\\\WS"]'),
    `key must be TOML-escaped; got:\n${merged}`);
  assert.equal((merged.match(/trusted = true/g) || []).length, 1);
});

test('empty string store behaves like a missing store', () => {
  const merged = mergeGrokFolderTrust('', [KEY_A]);
  assert.ok(merged !== null && merged.includes('trusted = true'));
});

test('no keys (empty list or only empty strings) → null', () => {
  assert.equal(mergeGrokFolderTrust(null, []), null);
  assert.equal(mergeGrokFolderTrust(null, ['', '']), null);
});

test('all keys already trusted → no-op (null)', () => {
  const existing = `[folders."${KEY_A.replace(/\\/g, '\\\\')}"]\ntrusted = true\ndecided_at = 1700000000\n`;
  assert.equal(mergeGrokFolderTrust(existing, [KEY_A]), null);
});

test('trusted = false is flipped to true, preserving decided_at and neighbors', () => {
  const esc = KEY_A.replace(/\\/g, '\\\\');
  const escB = KEY_B.replace(/\\/g, '\\\\');
  const existing =
    `[folders."${escB}"]\ntrusted = true\ndecided_at = 111\n\n` +
    `[folders."${esc}"]\ntrusted = false\ndecided_at = 222\n`;
  const merged = mergeGrokFolderTrust(existing, [KEY_A]);
  assert.ok(merged !== null, 'a false→true flip must produce a write');
  // The target flipped…
  assert.ok(merged.includes(`[folders."${esc}"]\ntrusted = true\ndecided_at = 222`),
    `flip must preserve decided_at; got:\n${merged}`);
  // …the neighbor entry is completely untouched…
  assert.ok(merged.includes(`[folders."${escB}"]\ntrusted = true\ndecided_at = 111`),
    'neighbor entry must be preserved');
  // …and no false remains, no duplicate table appended.
  assert.ok(!merged.includes('trusted = false'), 'no residual false');
  assert.equal((merged.match(/\[folders\./g) || []).length, 2, 'no duplicate table appended');
});

test('unrelated [folders] entries are preserved when appending a new key', () => {
  const escB = KEY_B.replace(/\\/g, '\\\\');
  const existing = `[folders."${escB}"]\ntrusted = true\ndecided_at = 999\n`;
  const merged = mergeGrokFolderTrust(existing, [KEY_A]);
  assert.ok(merged !== null);
  assert.ok(merged.includes(`[folders."${escB}"]\ntrusted = true\ndecided_at = 999`),
    'unrelated entry preserved byte-for-byte');
  assert.ok(merged.includes('[folders."C:\\\\Users\\\\turke\\\\Projects\\\\WS"]'),
    'new key appended');
  assert.equal((merged.match(/\[folders\./g) || []).length, 2);
});

test('mixed request: one absent (appended), one already trusted (untouched) → one new table', () => {
  const escB = KEY_B.replace(/\\/g, '\\\\');
  const existing = `[folders."${escB}"]\ntrusted = true\n`;
  const merged = mergeGrokFolderTrust(existing, [KEY_A, KEY_B]);
  assert.ok(merged !== null);
  assert.equal((merged.match(/\[folders\./g) || []).length, 2, 'exactly one table appended');
});

test('malformed: a folders.* header we cannot parse → no write (null)', () => {
  // A literal-string folder key (grok uses basic strings) we deliberately do
  // not handle — bail rather than mis-merge.
  const existing = `[folders.'C:\\weird']\ntrusted = false\n`;
  assert.equal(mergeGrokFolderTrust(existing, [KEY_A]), null);
});

test('duplicate ambiguous folder tables for the same key → no write (null)', () => {
  const esc = KEY_A.replace(/\\/g, '\\\\');
  const existing =
    `[folders."${esc}"]\ntrusted = false\n\n` +
    `[folders."${esc}"]\ntrusted = true\n`;
  assert.equal(mergeGrokFolderTrust(existing, [KEY_A]), null);
});

test('wanted key table exists but has no parseable trusted line → no write (null)', () => {
  const esc = KEY_A.replace(/\\/g, '\\\\');
  const existing = `[folders."${esc}"]\ndecided_at = 5\n`;
  assert.equal(mergeGrokFolderTrust(existing, [KEY_A]), null);
});

test('CRLF store keeps CRLF on append', () => {
  const escB = KEY_B.replace(/\\/g, '\\\\');
  const existing = `[folders."${escB}"]\r\ntrusted = true\r\n`;
  const merged = mergeGrokFolderTrust(existing, [KEY_A]);
  assert.ok(merged !== null);
  assert.ok(merged.includes('\r\n'), 'CRLF line style preserved');
  assert.ok(!/[^\r]\n/.test(merged), 'no bare LF introduced');
});

test('a path key containing a quote is TOML-escaped and round-trips as already-trusted', () => {
  const weird = 'C:\\ws\\say "hi"';
  const merged = mergeGrokFolderTrust(null, [weird]);
  assert.ok(merged !== null);
  assert.ok(merged.includes('[folders."C:\\\\ws\\\\say \\"hi\\""]'),
    `quote must be escaped; got:\n${merged}`);
  // Feeding the produced store back in is a no-op (the escaped key is recognized).
  assert.equal(mergeGrokFolderTrust(merged, [weird]), null, 're-seeding is idempotent');
});

test('produced store is stable: create then re-merge same key → null', () => {
  const merged = mergeGrokFolderTrust(null, [KEY_A]);
  assert.ok(merged !== null);
  assert.equal(mergeGrokFolderTrust(merged, [KEY_A]), null);
});

// ── Runner ───────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${t.name}`);
    console.error(err);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
