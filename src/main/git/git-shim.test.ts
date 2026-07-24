// Unit tests for the git shim (Git-Native WP-G0.4).
//
// The contract under test is narrow but load-bearing:
//   1. In the BUNDLED case the shim points at the given git.exe (both the .cmd
//      and the extensionless POSIX variant).
//   2. It is idempotent — a rerun with identical content does not rewrite
//      (writeIfChanged), asserted by an untouched mtime.
//   3. Both shims land in the EXACT getNodeShimDir() path, so windows-runner's
//      single appended dir covers them — one appended dir, not two.
//   4. It is NOT written when the internal resolution chose system git (nor when
//      there is no git), and a previously-written stale shim is removed.
//
// All exercised with injected seams (resolution + shim dir) so no real git and
// no real userData are touched.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/git/git-shim.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GitResolution } from '../../shared/types';
import { ensureGitShimDir } from './git-shim';
import { getNodeShimDir } from '../node-shim';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

const FAKE_GIT_EXE = 'C:\\Lares\\resources\\mingit\\cmd\\git.exe';

function bundled(execPath = FAKE_GIT_EXE): GitResolution['internal'] {
  return { source: 'bundled', execPath, semver: { major: 2, minor: 45, patch: 2 } };
}
function system(execPath = 'C:\\Program Files\\Git\\cmd\\git.exe'): GitResolution['internal'] {
  return { source: 'system', execPath, semver: { major: 2, minor: 45, patch: 2 } };
}

function tmpShimDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-git-shim-'));
}

// ── 1. BUNDLED → shim content points at the given exe ───────────────────────
test('bundled resolution → git.cmd and git point at the given exe', async () => {
  const dir = tmpShimDir();
  try {
    const returned = await ensureGitShimDir({ internal: bundled(), shimDir: dir });
    assert.equal(returned, dir, 'returns the shim dir it wrote into');

    const cmd = fs.readFileSync(path.join(dir, 'git.cmd'), 'utf-8');
    assert.match(cmd, /@echo off/);
    assert.ok(cmd.includes(`"${FAKE_GIT_EXE}"`), 'git.cmd must invoke the exact exe path');

    const posix = fs.readFileSync(path.join(dir, 'git'), 'utf-8');
    assert.match(posix, /^#!\/bin\/sh/);
    // The POSIX shim backslash-escapes the Windows path.
    assert.ok(posix.includes(FAKE_GIT_EXE.replace(/\\/g, '\\\\')), 'POSIX shim must escape the exe path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Idempotent (writeIfChanged no-op on rerun) ───────────────────────────
test('rerun with identical content does not rewrite (mtime unchanged)', async () => {
  const dir = tmpShimDir();
  try {
    await ensureGitShimDir({ internal: bundled(), shimDir: dir });
    const cmdPath = path.join(dir, 'git.cmd');
    // Stamp a fixed past mtime; if the second call rewrites, mtime advances.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(cmdPath, past, past);
    const before = fs.statSync(cmdPath).mtimeMs;

    await ensureGitShimDir({ internal: bundled(), shimDir: dir });
    const after = fs.statSync(cmdPath).mtimeMs;
    assert.equal(after, before, 'identical content must not trigger a rewrite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. Written into the EXACT getNodeShimDir() (one appended dir) ────────────
test('default target is getNodeShimDir() itself — a single appended dir covers both shims', async () => {
  // No shimDir override → must resolve to getNodeShimDir(), the same dir
  // node-shim appends to agent PATHs. Under the test runner (no Electron app)
  // this falls back under cwd; clean it up afterward.
  const expected = getNodeShimDir();
  try {
    const dir = await ensureGitShimDir({ internal: bundled() });
    assert.equal(dir, expected, 'git shim must target the node-shim dir, not a second dir');
    assert.ok(fs.existsSync(path.join(expected, 'git.cmd')), 'git.cmd lands in the node-shim dir');
  } finally {
    // getNodeShimDir() is <base>/node-shim; remove the whole runtime fallback root.
    const runtimeRoot = path.join(process.cwd(), '.lares-runtime');
    if (getNodeShimDir().startsWith(runtimeRoot)) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    } else {
      fs.rmSync(path.join(expected, 'git.cmd'), { force: true });
      fs.rmSync(path.join(expected, 'git'), { force: true });
    }
  }
});

// ── 4. System git wins → NOT written; stale shim removed ─────────────────────
test('system resolution → no shim is written', async () => {
  const dir = tmpShimDir();
  try {
    await ensureGitShimDir({ internal: system(), shimDir: dir });
    assert.ok(!fs.existsSync(path.join(dir, 'git.cmd')), 'must not shadow a real git with a shim');
    assert.ok(!fs.existsSync(path.join(dir, 'git')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no git at all (internal=null) → no shim is written', async () => {
  const dir = tmpShimDir();
  try {
    await ensureGitShimDir({ internal: null, shimDir: dir });
    assert.ok(!fs.existsSync(path.join(dir, 'git.cmd')));
    assert.ok(!fs.existsSync(path.join(dir, 'git')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switching bundled → system removes a previously-written stale shim', async () => {
  const dir = tmpShimDir();
  try {
    await ensureGitShimDir({ internal: bundled(), shimDir: dir });
    assert.ok(fs.existsSync(path.join(dir, 'git.cmd')), 'precondition: bundled shim exists');

    // User installs a real git → next resolution is system → shim must vanish.
    await ensureGitShimDir({ internal: system(), shimDir: dir });
    assert.ok(!fs.existsSync(path.join(dir, 'git.cmd')), 'stale bundled shim must be removed');
    assert.ok(!fs.existsSync(path.join(dir, 'git')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\ngit-shim: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
