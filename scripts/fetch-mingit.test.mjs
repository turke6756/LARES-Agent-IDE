// fetch-mingit.test.mjs — WP-G0.5 fetch/verify/unpack unit tests.
//
// Exercises fetch-mingit's verify + unpack + stage functions against a small
// LOCAL fixture archive built at test time (no network). Covers:
//   • placeholder (unpinned) manifest → clear not-pinned error; pinned → passes
//   • checksum match passes; mismatch fails loud AND deletes the bad download
//   • full stage against a fixture: git.exe lands, manifest copied beside,
//     system-gitconfig copied to etc/gitconfig
//   • idempotent re-run is a no-op (does not re-fetch)
//
// Run via: node scripts/fetch-mingit.test.mjs

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPlaceholderManifest,
  assertManifestPinned,
  readManifest,
  sha256File,
  verifyChecksum,
  copyManifestBeside,
  applySystemGitconfig,
  unpackArchive,
  stageMinGit,
  mingitPaths,
  repoRootFrom,
} from './fetch-mingit.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFrom(scriptDir);

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

// ── Fresh temp workspace ──────────────────────────────────────────────────────
const TMP = path.join(os.tmpdir(), 'lares-fetch-mingit-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const SYSTEM_GITCONFIG = '[core]\n\tlongpaths = true\n';

/** Build a fake MinGit tree + a `.zip` fixture (matching the real payload
 *  format); return {archivePath, treeDir}. */
function buildFixtureArchive(tag) {
  const dir = path.join(TMP, tag);
  const treeDir = path.join(dir, 'tree');
  fs.mkdirSync(path.join(treeDir, 'cmd'), { recursive: true });
  fs.writeFileSync(path.join(treeDir, 'cmd', 'git.exe'), 'fake-git-exe-bytes\n');
  fs.writeFileSync(path.join(treeDir, 'README.txt'), 'fake mingit payload\n');
  const archivePath = path.join(dir, 'MinGit-fixture.zip');
  let r;
  if (process.platform === 'win32') {
    // System32 bsdtar (libarchive) writes zip via -a (format from .zip extension).
    // Run from treeDir with a basename -f so the drive colon isn't read as a host.
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    r = spawnSync(bsdtar, ['-a', '-cf', path.join('..', 'MinGit-fixture.zip'), '.'], {
      cwd: treeDir,
      encoding: 'utf-8',
    });
  } else {
    r = spawnSync('zip', ['-q', '-r', archivePath, '.'], { cwd: treeDir, encoding: 'utf-8' });
  }
  assert.equal(r.status, 0, `zip fixture build failed: ${r.stderr || r.error}`);
  return { archivePath, treeDir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

await test('real checked-in manifest is a placeholder → assertManifestPinned throws not-pinned', () => {
  const p = mingitPaths(repoRoot);
  const real = readManifest(p.manifestPath);
  assert.ok(isPlaceholderManifest(real), 'checked-in manifest should still be unpinned (Open decision #1)');
  assert.throws(() => assertManifestPinned(real), /not yet pinned/i);
  // packagedGitExeRelPath is the one non-placeholder field.
  assert.equal(real.packagedGitExeRelPath, 'cmd/git.exe');
});

await test('a fully pinned manifest passes assertManifestPinned', () => {
  const pinned = {
    version: '2.99.0',
    archiveUrl: 'https://example.invalid/MinGit.zip',
    sha256: 'a'.repeat(64),
    archiveName: 'MinGit.zip',
    packagedGitExeRelPath: 'cmd/git.exe',
  };
  assert.equal(isPlaceholderManifest(pinned), false);
  assert.doesNotThrow(() => assertManifestPinned(pinned));
});

await test('verifyChecksum passes on a matching SHA-256', async () => {
  const f = path.join(TMP, 'good.bin');
  fs.writeFileSync(f, 'hello mingit\n');
  const sha = await sha256File(f);
  const verified = await verifyChecksum(f, sha.toUpperCase()); // case-insensitive
  assert.equal(verified, sha);
  assert.ok(fs.existsSync(f), 'a matching file must NOT be deleted');
});

await test('verifyChecksum fails LOUD on mismatch and deletes the bad download', async () => {
  const f = path.join(TMP, 'bad.bin');
  fs.writeFileSync(f, 'tampered payload\n');
  const wrong = 'b'.repeat(64);
  await assert.rejects(() => verifyChecksum(f, wrong), /SHA-256 MISMATCH/);
  assert.ok(!fs.existsSync(f), 'the unverified download must be deleted on mismatch');
});

await test('verifyChecksum rejects a malformed expected SHA', async () => {
  const f = path.join(TMP, 'x.bin');
  fs.writeFileSync(f, 'x');
  await assert.rejects(() => verifyChecksum(f, 'not-a-sha'), /not a 64-hex/i);
});

await test('unpackArchive extracts a zip fixture', async () => {
  const { archivePath } = buildFixtureArchive('unpack');
  const dest = path.join(TMP, 'unpack-dest');
  unpackArchive(archivePath, dest);
  assert.ok(fs.existsSync(path.join(dest, 'cmd', 'git.exe')), 'cmd/git.exe should be extracted');
});

await test('stageMinGit: full offline stage lands git.exe, manifest, and etc/gitconfig', async () => {
  const { archivePath } = buildFixtureArchive('stage');
  const sha = await sha256File(archivePath);

  const stagingDir = path.join(TMP, 'stage', '.staging');
  const payloadDir = path.join(stagingDir, 'mingit');
  const manifestPath = path.join(TMP, 'stage', 'mingit-manifest.json');
  const systemGitconfigPath = path.join(TMP, 'stage', 'system-gitconfig');

  const manifest = {
    version: '2.99.0-test',
    archiveUrl: 'https://example.invalid/MinGit-fixture.zip',
    sha256: sha,
    archiveName: 'MinGit-fixture.zip',
    packagedGitExeRelPath: 'cmd/git.exe',
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(systemGitconfigPath, SYSTEM_GITCONFIG);

  let fetchCalls = 0;
  const fetchArchive = async (url, dest) => {
    fetchCalls++;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(archivePath, dest);
    return dest;
  };

  const r1 = await stageMinGit({
    manifest,
    stagingDir,
    payloadDir,
    manifestPath,
    systemGitconfigPath,
    fetchArchive,
  });

  assert.equal(r1.status, 'staged');
  assert.equal(fetchCalls, 1);
  assert.ok(fs.existsSync(path.join(payloadDir, 'cmd', 'git.exe')), 'git.exe staged');
  assert.ok(
    fs.existsSync(path.join(payloadDir, 'mingit-manifest.json')),
    'manifest copied beside payload',
  );
  const etcGitconfig = path.join(payloadDir, 'etc', 'gitconfig');
  assert.ok(fs.existsSync(etcGitconfig), 'etc/gitconfig written');
  assert.equal(
    fs.readFileSync(etcGitconfig, 'utf-8'),
    SYSTEM_GITCONFIG,
    'etc/gitconfig must be a verbatim copy of system-gitconfig',
  );

  // ── Idempotent re-run: same SHA already staged → no-op, no re-fetch. ──
  const r2 = await stageMinGit({
    manifest,
    stagingDir,
    payloadDir,
    manifestPath,
    systemGitconfigPath,
    fetchArchive,
  });
  assert.equal(r2.status, 'skipped', 'second run must be a no-op');
  assert.equal(fetchCalls, 1, 'idempotent re-run must NOT re-fetch the archive');
});

await test('stageMinGit: checksum mismatch during stage fails loud and deletes the download', async () => {
  const { archivePath } = buildFixtureArchive('mismatch');

  const stagingDir = path.join(TMP, 'mismatch', '.staging');
  const payloadDir = path.join(stagingDir, 'mingit');
  const manifestPath = path.join(TMP, 'mismatch', 'mingit-manifest.json');
  const systemGitconfigPath = path.join(TMP, 'mismatch', 'system-gitconfig');

  const manifest = {
    version: '2.99.0-test',
    archiveUrl: 'https://example.invalid/MinGit-fixture.zip',
    sha256: 'c'.repeat(64), // deliberately wrong
    archiveName: 'MinGit-fixture.zip',
    packagedGitExeRelPath: 'cmd/git.exe',
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(systemGitconfigPath, SYSTEM_GITCONFIG);

  const fetchArchive = async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(archivePath, dest);
    return dest;
  };

  await assert.rejects(
    () =>
      stageMinGit({
        manifest,
        stagingDir,
        payloadDir,
        manifestPath,
        systemGitconfigPath,
        fetchArchive,
      }),
    /SHA-256 MISMATCH/,
  );
  assert.ok(
    !fs.existsSync(path.join(stagingDir, 'MinGit-fixture.zip')),
    'the mismatched download must be deleted',
  );
  assert.ok(!fs.existsSync(path.join(payloadDir, 'cmd', 'git.exe')), 'no payload on mismatch');
});

await test('copyManifestBeside + applySystemGitconfig are directly composable', () => {
  const payloadDir = path.join(TMP, 'compose', 'mingit');
  fs.mkdirSync(payloadDir, { recursive: true });
  const manifestPath = path.join(TMP, 'compose', 'm.json');
  const sysPath = path.join(TMP, 'compose', 'system-gitconfig');
  fs.writeFileSync(manifestPath, '{"version":"x"}');
  fs.writeFileSync(sysPath, SYSTEM_GITCONFIG);

  const m = copyManifestBeside(manifestPath, payloadDir);
  const g = applySystemGitconfig(sysPath, payloadDir);
  assert.equal(fs.readFileSync(m, 'utf-8'), '{"version":"x"}');
  assert.equal(fs.readFileSync(g, 'utf-8'), SYSTEM_GITCONFIG);
});

// ── Cleanup + summary ─────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
