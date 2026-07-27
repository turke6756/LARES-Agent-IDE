// Git-Native WP-G0.1 — MinGit manifest loader + shape validation.
//
//   npm run build:main
//   node dist/main/main/git/mingit-manifest.test.js
//
// Exercises the loader against the REAL checked-in manifest and the validator
// against malformed inputs — no Electron (the plain-node seams take injected
// paths / parsed objects).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadMinGitManifestFrom,
  resolveMinGitManifestPath,
  validateMinGitManifest,
} from './mingit-manifest';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('the checked-in manifest parses and has the expected shape', () => {
  const p = resolveMinGitManifestPath({ isPackaged: false });
  const m = loadMinGitManifestFrom(p);
  // Open decision #1 resolved: the manifest is pinned to a real MinGit release.
  assert.match(m.version, /\.windows\.\d+$/);
  assert.match(m.archiveUrl, /^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\//);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.ok(m.archiveName && m.archiveUrl.endsWith(m.archiveName), 'archiveName matches the tail of archiveUrl');
  // Standard MinGit layout value ships now.
  assert.equal(m.packagedGitExeRelPath, 'cmd/git.exe');
});

test('validation rejects a missing key', () => {
  assert.throws(
    () => validateMinGitManifest({
      version: '', archiveUrl: '', sha256: '', archiveName: '',
      // packagedGitExeRelPath omitted
    }),
    /missing required key 'packagedGitExeRelPath'/
  );
});

test('validation rejects a non-string key', () => {
  assert.throws(
    () => validateMinGitManifest({
      version: 2, archiveUrl: '', sha256: '', archiveName: '', packagedGitExeRelPath: 'cmd/git.exe',
    }),
    /key 'version' must be a string/
  );
});

test('validation rejects non-objects', () => {
  assert.throws(() => validateMinGitManifest(null), /expected a JSON object/);
  assert.throws(() => validateMinGitManifest([]), /expected a JSON object/);
});

test('loadMinGitManifestFrom rejects invalid JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingit-manifest-'));
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  try {
    assert.throws(() => loadMinGitManifestFrom(bad), /invalid JSON/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveMinGitManifestPath: packaged reads resourcesPath/mingit, requires it', () => {
  const packaged = resolveMinGitManifestPath({ isPackaged: true, resourcesPath: '/res' });
  assert.ok(packaged.replace(/\\/g, '/').endsWith('/res/mingit/mingit-manifest.json'), packaged);
  assert.throws(() => resolveMinGitManifestPath({ isPackaged: true }), /resourcesPath is required/);
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
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
