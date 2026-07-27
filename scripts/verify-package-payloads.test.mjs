// verify-package-payloads.test.mjs — unit tests for the fail-loud packaging
// preflight. Drives the pure checkPayloads() against a fixture tree with an
// injected `exists` seam so no real build is needed.
//
// Run via: node scripts/verify-package-payloads.test.mjs

import assert from 'node:assert';
import * as path from 'node:path';

import { checkPayloads } from './verify-package-payloads.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
    passed++;
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error('       ', e && e.stack ? e.stack : e);
    failed++;
  }
}

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';

// A package.json shaped like the real one: scripts/assets/mingit/native payloads.
const PKG = {
  build: {
    extraResources: [
      { from: 'scripts', to: 'scripts' },
      { from: 'assets', to: 'assets' },
      { from: 'third_party/git-for-windows/.staging/mingit', to: 'mingit' },
      { from: 'native/lares-native', to: 'native/lares-native' },
    ],
  },
};

const manifestAbs = path.resolve(ROOT, 'third_party', 'git-for-windows', 'mingit-manifest.json');
const mingitAbs = path.resolve(ROOT, 'third_party/git-for-windows/.staging/mingit');
const gitExeAbs = path.resolve(mingitAbs, 'cmd', 'git.exe');

const readManifest = () => JSON.stringify({ packagedGitExeRelPath: 'cmd/git.exe' });

// ── Tests ─────────────────────────────────────────────────────────────────────

await test('all payloads present (incl. staged git.exe) → no failures', () => {
  const present = new Set([
    path.resolve(ROOT, 'scripts'),
    path.resolve(ROOT, 'assets'),
    mingitAbs,
    gitExeAbs,
    path.resolve(ROOT, 'native/lares-native'),
  ]);
  const { failures } = checkPayloads({
    repoRoot: ROOT,
    pkg: PKG,
    exists: (p) => present.has(p),
    readFile: readManifest,
  });
  assert.deepEqual(failures, [], 'a fully-present tree must pass');
});

await test('missing mingit `from` dir → failure names the path and the fetch:mingit fix', () => {
  const present = new Set([
    path.resolve(ROOT, 'scripts'),
    path.resolve(ROOT, 'assets'),
    path.resolve(ROOT, 'native/lares-native'),
    // mingit dir + exe absent
  ]);
  const { failures } = checkPayloads({
    repoRoot: ROOT,
    pkg: PKG,
    exists: (p) => present.has(p),
    readFile: readManifest,
  });
  assert.equal(failures.length, 1, 'exactly the mingit dir is missing');
  assert.equal(failures[0].missing, mingitAbs);
  assert.match(failures[0].fix, /fetch:mingit/);
});

await test('mingit dir present but git.exe missing → still fails (empty payload is broken)', () => {
  const present = new Set([
    path.resolve(ROOT, 'scripts'),
    path.resolve(ROOT, 'assets'),
    mingitAbs, // dir exists...
    path.resolve(ROOT, 'native/lares-native'),
    // ...but gitExeAbs is NOT present
  ]);
  const { failures } = checkPayloads({
    repoRoot: ROOT,
    pkg: PKG,
    exists: (p) => present.has(p),
    readFile: readManifest,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].missing, gitExeAbs);
  assert.match(failures[0].payload, /bundled git exe/);
  assert.match(failures[0].fix, /fetch:mingit/);
});

await test('missing native addon → failure names rebuild:native fix', () => {
  const present = new Set([
    path.resolve(ROOT, 'scripts'),
    path.resolve(ROOT, 'assets'),
    mingitAbs,
    gitExeAbs,
    // native/lares-native absent
  ]);
  const { failures } = checkPayloads({
    repoRoot: ROOT,
    pkg: PKG,
    exists: (p) => present.has(p),
    readFile: readManifest,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].missing, path.resolve(ROOT, 'native/lares-native'));
  assert.match(failures[0].fix, /rebuild:native/);
});

await test('multiple missing payloads are all reported', () => {
  const present = new Set([path.resolve(ROOT, 'assets')]); // only assets present
  const { failures } = checkPayloads({
    repoRoot: ROOT,
    pkg: PKG,
    exists: (p) => present.has(p),
    readFile: readManifest,
  });
  // scripts missing, mingit dir missing, native missing = 3 (mingit exe skipped
  // because its dir is already flagged and we continue past it).
  assert.equal(failures.length, 3);
  const missingPaths = failures.map((f) => f.missing);
  assert.ok(missingPaths.includes(path.resolve(ROOT, 'scripts')));
  assert.ok(missingPaths.includes(mingitAbs));
  assert.ok(missingPaths.includes(path.resolve(ROOT, 'native/lares-native')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
