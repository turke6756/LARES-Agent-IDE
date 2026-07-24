// Git-Native WP-G1.3a — checkpoint-gating: capability gate, enumeration pathspec,
// full-scope preflight, and the check-ignore exit-code trichotomy.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-gating.test.js
//
// The gate + pathspec + classification logic is pure and always tested with
// fixtures + a fake runGit seam (so FIFO/device/submodule shapes are modelled
// without creating one — impossible on Windows). Where a REAL git is cheap and
// meaningfully different (ls-files scoping, check-attr over NUL stdin,
// check-ignore exit codes) we also drive a throwaway temp repo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyIgnored,
  enumerateScope,
  enumerationPathspec,
  gateCheckpoint,
  type LstatFn,
  type LstatInfo,
  type RunGitLike,
} from './checkpoint-gating';
import { runGit } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';
import type { GitCapability } from '../../shared/types';

interface TestCase { name: string; realGit?: boolean; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }
function testGit(name: string, fn: () => void | Promise<void>): void { tests.push({ name, realGit: true, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-gate-'));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function mkRepo(): string {
  const dir = mkTmpDir();
  execFileSync(EXE, ['init', '-q'], { cwd: dir });
  execFileSync(EXE, ['config', 'user.email', 't@lares.local'], { cwd: dir });
  execFileSync(EXE, ['config', 'user.name', 'Lares Test'], { cwd: dir });
  return dir;
}
/** Bind the real runGit to the resolved exe. */
const realRunGit: RunGitLike = (cwd, args, opts) => runGit(cwd, args, { gitExe: EXE, ...opts });

// ── capability-gate fixtures ──────────────────────────────────────────────────

function cap(overrides: Partial<GitCapability>): GitCapability {
  return {
    resolution: { agentShell: { source: 'system', note: '' }, internal: null },
    repoState: 'repo',
    commonDir: '/repo/.git',
    commonDirQueueKey: '/repo/.git',
    repoRoot: '/repo',
    workspacePrefix: '',
    protectedRoot: false,
    reason: 'ok',
    detail: null,
    ...overrides,
  };
}

// ── 1. capability gate ────────────────────────────────────────────────────────

test('gate accepts a clean-ok repo at root (dirtiness is not a gate input)', () => {
  // The gate consults only reason/repoState/protectedRoot — NEVER worktree
  // cleanliness. Dirty state is the input to checkpointing, never a rejection.
  const g = gateCheckpoint(cap({ repoState: 'repo', workspacePrefix: '' }));
  assert.deepEqual(g, { ok: true, repoState: 'repo', repoRoot: '/repo', workspacePrefix: '' });
});

test('gate ACCEPTS an unborn repo', () => {
  const g = gateCheckpoint(cap({ repoState: 'unborn', workspacePrefix: 'sub' }));
  assert.equal(g.ok, true);
  assert.equal(g.ok && g.repoState, 'unborn');
});

test('gate skips a protected root (on the boolean, regardless of reason)', () => {
  // protectedRoot is carried alongside an otherwise-ok reason; the gate keys on
  // the boolean and reports it as the actionable cause.
  const g = gateCheckpoint(cap({ protectedRoot: true, reason: 'ok', detail: 'home directory' }));
  assert.deepEqual(g, { ok: false, skipped: 'protected-root', detail: 'home directory' });
});

test('gate skips every non-ok reason and every ineligible repo state', () => {
  for (const reason of ['missing', 'too-old', 'unsafe-directory', 'broken', 'timeout', 'unsupported-layout', 'unsupported-path'] as const) {
    const g = gateCheckpoint(cap({ reason }));
    assert.equal(g.ok, false);
    assert.equal(!g.ok && g.skipped, reason);
  }
  for (const repoState of ['non-repo', 'nested', 'spans-boundary', 'unsupported-wsl'] as const) {
    const g = gateCheckpoint(cap({ reason: 'ok', repoState }));
    assert.equal(g.ok, false);
    assert.equal(!g.ok && g.skipped, repoState);
  }
});

test('gate reports incomplete-capability when eligible but paths are null', () => {
  const g = gateCheckpoint(cap({ repoState: 'repo', repoRoot: null }));
  assert.equal(!g.ok && g.skipped, 'incomplete-capability');
});

// ── 2. enumeration pathspec ───────────────────────────────────────────────────

test('root workspace → no pathspec; sub-prefix → :(top,literal); never empty', () => {
  assert.equal(enumerationPathspec(''), null);
  assert.equal(enumerationPathspec('sub/dir'), ':(top,literal)sub/dir');
  assert.equal(enumerationPathspec('a'), ':(top,literal)a');
  // Never produces the bare, whole-tree-matching magic.
  assert.notEqual(enumerationPathspec('x'), ':(top,literal)');
});

// ── 3. enumeration preflight (fake runGit + injected lstat) ────────────────────

function L(over: Partial<LstatInfo> = {}): LstatInfo {
  return {
    isFile: true, isSymbolicLink: false, isDirectory: false,
    isFIFO: false, isSocket: false, isCharacterDevice: false, isBlockDevice: false,
    mode: 0o100644, size: 0, ...over,
  };
}
/** lstat from a map: value null → absent (deletion); missing key → absent. */
function lstatFrom(map: Record<string, LstatInfo | null>): LstatFn {
  return (rel) => (rel in map ? map[rel] : null);
}
/** Fake runGit that answers ls-files (canned) + check-attr (from a driver map),
 *  recording every call so tests can assert what was — and was NOT — invoked. */
function fakeGit(opts: { lsFiles: string[]; attr?: Record<string, string>; calls?: Array<{ args: string[]; stdin?: string }> }): RunGitLike {
  return async (_cwd, args, o) => {
    opts.calls?.push({ args, stdin: o.stdin === undefined ? undefined : String(o.stdin) });
    if (args[0] === 'ls-files') {
      return { code: 0, stdout: opts.lsFiles.map((p) => `${p}\0`).join(''), stderr: '' };
    }
    if (args[0] === 'check-attr') {
      const paths = String(o.stdin ?? '').split('\0').filter(Boolean);
      const out = paths.map((p) => `${p}\0filter\0${opts.attr?.[p] ?? 'unspecified'}\0`).join('');
      return { code: 0, stdout: out, stderr: '' };
    }
    throw new Error(`fakeGit: unexpected git ${args[0]}`);
  };
}

test('full scope counts CLEAN tracked files (no stat-based reuse)', async () => {
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '', runGit: fakeGit({ lsFiles: ['clean.txt', 'dirty.txt', 'new.txt'] }),
    lstat: lstatFrom({ 'clean.txt': L({ size: 10 }), 'dirty.txt': L({ size: 20 }), 'new.txt': L({ size: 30 }) }),
  });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.capturable.length, 3, 'clean tracked files are in scope, not elided');
  assert.deepEqual(out.capturable.map((e) => e.path).sort(), ['clean.txt', 'dirty.txt', 'new.txt']);
  assert.deepEqual(out.observed, { paths: 3, bytes: 60 });
});

test('oversized by path count → skip with observed values + thresholds', async () => {
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '', maxPaths: 2,
    runGit: fakeGit({ lsFiles: ['a', 'b', 'c'] }),
    lstat: lstatFrom({ a: L({ size: 1 }), b: L({ size: 1 }), c: L({ size: 1 }) }),
  });
  assert.deepEqual(out, {
    kind: 'skipped', reason: 'oversized',
    observed: { paths: 3, bytes: 3 }, thresholds: { maxPaths: 2, maxBytes: 256 * 1024 * 1024 },
  });
});

test('oversized by byte sum → skip with observed values + thresholds', async () => {
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '', maxBytes: 100,
    runGit: fakeGit({ lsFiles: ['big'] }),
    lstat: lstatFrom({ big: L({ size: 500 }) }),
  });
  assert.equal(out.kind, 'skipped');
  assert.equal(out.kind === 'skipped' && out.observed.bytes, 500);
  assert.equal(out.kind === 'skipped' && out.thresholds.maxBytes, 100);
});

test('filtered path is CAPTURED + flagged, never skipped', async () => {
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '',
    runGit: fakeGit({ lsFiles: ['a.enc', 'b.txt'], attr: { 'a.enc': 'lfs' } }),
    lstat: lstatFrom({ 'a.enc': L({ size: 5 }), 'b.txt': L({ size: 5 }) }),
  });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.deepEqual(out.capturable.map((e) => e.path).sort(), ['a.enc', 'b.txt'], 'filtered file still captured');
  assert.deepEqual(out.filteredPaths, ['a.enc']);
  assert.equal(out.beforeRawFilterBypassed, true);
});

test('FIFO / device entries are EXCLUDED, marked, and never handed to hash-object', async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '',
    runGit: fakeGit({ lsFiles: ['pipe', 'dev', 'real.txt'], calls }),
    lstat: lstatFrom({
      pipe: L({ isFile: false, isFIFO: true }),
      dev: L({ isFile: false, isCharacterDevice: true }),
      'real.txt': L({ size: 4 }),
    }),
  });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.deepEqual(out.unsupported.sort(), ['dev', 'pipe']);
  assert.deepEqual(out.capturable.map((e) => e.path), ['real.txt'], 'only the regular file is capturable');
  // Never hashed (this module never even calls hash-object) …
  assert.equal(calls.some((c) => c.args[0] === 'hash-object'), false);
  // … and the FIFO/device are excluded from the check-attr stdin too (no hang).
  const attrCall = calls.find((c) => c.args[0] === 'check-attr');
  assert.ok(attrCall);
  assert.equal(attrCall!.stdin!.includes('pipe'), false);
  assert.equal(attrCall!.stdin!.includes('dev\0'), false);
});

test('symlink → capturable (type symlink); gitlink dir → gitlinks; absent → deletion', async () => {
  const out = await enumerateScope({
    repoRoot: '/repo', workspacePrefix: '',
    runGit: fakeGit({ lsFiles: ['link', 'submod', 'gone.txt', 'file.txt'] }),
    lstat: lstatFrom({
      link: L({ isFile: false, isSymbolicLink: true, mode: 0o120000, size: 7 }),
      submod: L({ isFile: false, isDirectory: true }),
      'gone.txt': null,
      'file.txt': L({ size: 3 }),
    }),
  });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.deepEqual(out.capturable.map((e) => [e.path, e.type]).sort(), [['file.txt', 'regular'], ['link', 'symlink']]);
  assert.deepEqual(out.gitlinks, ['submod']);
  assert.deepEqual(out.deletions, ['gone.txt']);
  // deletions count toward the path total; their bytes are 0.
  assert.deepEqual(out.observed, { paths: 3, bytes: 10 });
});

// ── 4. check-ignore trichotomy ────────────────────────────────────────────────

test('check-ignore exit-code trichotomy (0 some / 1 none / >1 error)', async () => {
  const some: RunGitLike = async () => ({ code: 0, stdout: 'ignored.txt\0', stderr: '' });
  assert.deepEqual(await classifyIgnored({ repoRoot: '/r', paths: ['ignored.txt'], runGit: some }), {
    kind: 'some-ignored', ignored: ['ignored.txt'],
  });

  const none: RunGitLike = async () => ({ code: 1, stdout: '', stderr: '' });
  assert.deepEqual(await classifyIgnored({ repoRoot: '/r', paths: ['x'], runGit: none }), { kind: 'none-ignored' });

  const err: RunGitLike = async () => ({ code: 128, stdout: '', stderr: 'fatal: boom' });
  assert.deepEqual(await classifyIgnored({ repoRoot: '/r', paths: ['x'], runGit: err }), {
    kind: 'error', code: 128, stderr: 'fatal: boom',
  });

  // No paths → never invokes git.
  let called = false;
  const spy: RunGitLike = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await classifyIgnored({ repoRoot: '/r', paths: [], runGit: spy }), { kind: 'none-ignored' });
  assert.equal(called, false);
});

// ── REAL git temp-repo behavior ────────────────────────────────────────────────

testGit('real ls-files: clean tracked + untracked in scope; ignored excluded', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'committed');
  execFileSync(EXE, ['add', 'clean.txt'], { cwd: repo });
  execFileSync(EXE, ['commit', '-qm', 'seed'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'noise');

  const out = await enumerateScope({ repoRoot: repo, workspacePrefix: '', runGit: realRunGit, gitExe: EXE });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  const paths = out.capturable.map((e) => e.path).sort();
  assert.ok(paths.includes('clean.txt'), 'clean tracked file is in scope');
  assert.ok(paths.includes('untracked.txt'), 'non-ignored untracked file is in scope');
  assert.ok(paths.includes('.gitignore'), 'the .gitignore itself is an untracked candidate');
  assert.equal(paths.includes('ignored.log'), false, 'ignored file is excluded (--exclude-standard)');
});

testGit('real sub-prefix pathspec scopes enumeration to the prefix', async () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'inside.txt'), 'in');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'out');

  const out = await enumerateScope({ repoRoot: repo, workspacePrefix: 'sub', runGit: realRunGit, gitExe: EXE });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  const paths = out.capturable.map((e) => e.path);
  assert.deepEqual(paths, ['sub/inside.txt'], 'only files under the prefix are enumerated');
});

testGit('real check-attr over NUL stdin flags a filter-driver path (incl. a spaced name)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.enc filter=secret\n');
  fs.writeFileSync(path.join(repo, 'a.enc'), 'x');
  fs.writeFileSync(path.join(repo, 'plain.txt'), 'y');
  fs.writeFileSync(path.join(repo, 'sp ace.enc'), 'z'); // NUL-safe: space in the name

  const out = await enumerateScope({ repoRoot: repo, workspacePrefix: '', runGit: realRunGit, gitExe: EXE });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.deepEqual(out.filteredPaths.sort(), ['a.enc', 'sp ace.enc']);
  assert.equal(out.beforeRawFilterBypassed, true);
  assert.ok(out.capturable.some((e) => e.path === 'a.enc'), 'filtered path still captured, not skipped');
});

testGit('real check-ignore: some-ignored (exit 0) vs none-ignored (exit 1)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.key\n');

  const someOut = await classifyIgnored({ repoRoot: repo, paths: ['secret.key', 'ok.txt'], runGit: realRunGit, gitExe: EXE });
  assert.equal(someOut.kind, 'some-ignored');
  assert.deepEqual(someOut.kind === 'some-ignored' && someOut.ignored, ['secret.key']);

  const noneOut = await classifyIgnored({ repoRoot: repo, paths: ['ok.txt', 'also-fine.txt'], runGit: realRunGit, gitExe: EXE });
  assert.deepEqual(noneOut, { kind: 'none-ignored' });
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.realGit && !EXE) {
      console.log(`  skip ${t.name} (no compatible git resolved)`);
      skipped++;
      continue;
    }
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
