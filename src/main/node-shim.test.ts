// Unit tests for the Windows node shim (bundled-node-exposure plan §1.6).
//
// These cover the shim's GENERATION and the PATH-append helper. What they cannot
// cover: whether the generated node.cmd actually re-execs Lares.exe as Node on a
// Node-free machine — that needs the packaged app and is scripted in
// scripts/verify-bundled-node.ps1. The Git-Bash POSIX-shim contract (§1.5) has
// its own gate in node-shim.git-bash.test.ts.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/node-shim.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureNodeShimDir, getNodeShimDir, withNodeShimOnPath } from './node-shim';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

/** Run `fn` with cwd pointed at a fresh temp dir. Under the plain-node runner
 *  `app` is undefined, so getNodeShimDir() falls back to <cwd>/.lares-runtime —
 *  chdir'ing gives each test an isolated, disposable shim dir. */
function inTempCwd(fn: (shimDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-node-shim-'));
  const savedCwd = process.cwd();
  process.chdir(root);
  try {
    fn(getNodeShimDir());
  } finally {
    process.chdir(savedCwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const FAKE_EXE = 'C:\\Program Files\\Lares\\Lares.exe';

test('ensureNodeShimDir writes node.cmd with setlocal, the flag, and the quoted exe path', () => {
  inTempCwd((shimDir) => {
    const returned = ensureNodeShimDir(FAKE_EXE);
    assert.equal(returned, shimDir, 'returns the shim dir it wrote to');
    const cmd = fs.readFileSync(path.join(shimDir, 'node.cmd'), 'utf-8');
    assert.ok(cmd.includes('setlocal'), 'node.cmd must scope with setlocal');
    assert.ok(cmd.includes('set "ELECTRON_RUN_AS_NODE=1"'), 'node.cmd must set the runtime flag');
    assert.ok(cmd.includes(`"${FAKE_EXE}" %*`), 'node.cmd must invoke the quoted exe with all args');
    // CRLF: this is a .cmd that cmd.exe parses.
    assert.ok(cmd.includes('\r\n'), 'node.cmd must use CRLF line endings');
  });
});

test('ensureNodeShimDir is idempotent — a second identical call rewrites nothing', () => {
  inTempCwd((shimDir) => {
    ensureNodeShimDir(FAKE_EXE);
    const cmdPath = path.join(shimDir, 'node.cmd');
    const shPath = path.join(shimDir, 'node');
    const before = fs.readFileSync(cmdPath, 'utf-8');
    // Backdate mtime; a needless rewrite would bump it back to ~now.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(cmdPath, old, old);
    fs.utimesSync(shPath, old, old);
    const cmdMtime = fs.statSync(cmdPath).mtimeMs;
    const shMtime = fs.statSync(shPath).mtimeMs;

    ensureNodeShimDir(FAKE_EXE);

    assert.equal(fs.readFileSync(cmdPath, 'utf-8'), before, 'content is byte-identical');
    assert.equal(fs.statSync(cmdPath).mtimeMs, cmdMtime, 'node.cmd was not rewritten');
    assert.equal(fs.statSync(shPath).mtimeMs, shMtime, 'node (posix) was not rewritten');
  });
});

test('ensureNodeShimDir rewrites node.cmd when execPath changes (self-heals on upgrade/relocation)', () => {
  inTempCwd((shimDir) => {
    ensureNodeShimDir(FAKE_EXE);
    const cmdPath = path.join(shimDir, 'node.cmd');
    const NEW_EXE = 'D:\\Apps\\Lares\\Lares.exe';
    ensureNodeShimDir(NEW_EXE);
    const cmd = fs.readFileSync(cmdPath, 'utf-8');
    assert.ok(cmd.includes(`"${NEW_EXE}" %*`), 'node.cmd must point at the new exe');
    assert.ok(!cmd.includes(FAKE_EXE), 'the stale exe path must be gone');
  });
});

test('ensureNodeShimDir writes a POSIX node shim with a backslash-escaped exe path', () => {
  inTempCwd((shimDir) => {
    ensureNodeShimDir(FAKE_EXE);
    const sh = fs.readFileSync(path.join(shimDir, 'node'), 'utf-8');
    assert.ok(sh.startsWith('#!/bin/sh\n'), 'posix shim needs a shebang');
    assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1 exec'), 'posix shim scopes the flag to the exec');
    // Backslashes doubled for /bin/sh double-quote context.
    assert.ok(sh.includes('C:\\\\Program Files\\\\Lares\\\\Lares.exe'), 'exe path backslashes must be escaped');
    assert.ok(sh.includes('"$@"'), 'posix shim must forward all args');
  });
});

test('withNodeShimOnPath appends the shim dir LAST (system node keeps precedence)', () => {
  const out = withNodeShimOnPath({ PATH: 'C:\\Windows\\system32;C:\\nodejs' }, 'C:\\shim');
  const parts = out.PATH!.split(';');
  assert.equal(parts[parts.length - 1], 'C:\\shim', 'shim dir must be at the tail');
  assert.deepEqual(parts, ['C:\\Windows\\system32', 'C:\\nodejs', 'C:\\shim']);
});

test('withNodeShimOnPath is a no-op when the shim dir is already present (case-insensitive)', () => {
  const out = withNodeShimOnPath({ PATH: 'C:\\Windows;C:\\SHIM' }, 'c:\\shim');
  const count = out.PATH!.split(';').filter((p) => p.toLowerCase() === 'c:\\shim').length;
  assert.equal(count, 1, 'no duplicate shim entry');
  assert.equal(out.PATH, 'C:\\Windows;C:\\SHIM', 'existing spelling is preserved verbatim');
});

test('withNodeShimOnPath honors a lowercase `Path` key and preserves that spelling', () => {
  const out = withNodeShimOnPath({ Path: 'C:\\Windows' } as NodeJS.ProcessEnv, 'C:\\shim');
  assert.equal('Path' in out, true, 'the original key spelling is kept');
  assert.equal('PATH' in out, false, 'no second PATH-cased key is introduced');
  assert.equal((out as { Path?: string }).Path, 'C:\\Windows;C:\\shim');
});

test('withNodeShimOnPath synthesizes PATH when the env has none', () => {
  const out = withNodeShimOnPath({}, 'C:\\shim');
  assert.equal(out.PATH, 'C:\\shim');
});

test('withNodeShimOnPath returns a new object and never mutates the input', () => {
  const input: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' };
  const out = withNodeShimOnPath(input, 'C:\\shim');
  assert.notEqual(out, input, 'a new object is returned');
  assert.equal(input.PATH, 'C:\\Windows', 'the input env is untouched');
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
