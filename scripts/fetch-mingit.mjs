#!/usr/bin/env node
// fetch-mingit.mjs — download + SHA-256-verify + unpack the bundled MinGit
// payload (Git-Native WP-G0.5).
//
// WHAT THIS DOES
// --------------
// Reads the single source of truth, third_party/git-for-windows/mingit-manifest.json,
// downloads the pinned Git-for-Windows MinGit archive, verifies its SHA-256
// against the manifest (fail LOUD on mismatch — the bad download is deleted),
// unpacks it into an in-repo, gitignored staging dir, copies the manifest in
// beside the payload, and writes the bundled system git config to
// <payload>/etc/gitconfig. The result is what build.extraResources ships as
// `mingit/`.
//
//   staging root : third_party/git-for-windows/.staging        (gitignored)
//   payload dir  : third_party/git-for-windows/.staging/mingit  (== extraResources `from`)
//   git.exe      : .staging/mingit/<packagedGitExeRelPath>       (git-runtime dev fallback)
//
// The payload is fetched in release CI, never committed. This script is
// idempotent: a re-run whose staging already matches the pinned SHA is a no-op.
//
// RELEASE HOLD / Open decision #1: the manifest ships with PLACEHOLDER empty
// strings for version/archiveUrl/sha256 until Edward pins a version. Until then
// this script exits with a clear "manifest not yet pinned" error rather than
// attempting a download — it does NOT invent pin values.
//
// TESTABILITY: the download / verify / unpack steps are exported pure-ish
// functions so scripts/fetch-mingit.test.js can exercise checksum-verify and
// unpack against a small LOCAL fixture archive with no network. `stageMinGit`
// takes an injectable `fetchArchive` so the whole flow runs offline in tests.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────────────────

/** Repo root = parent of this script's directory. */
export function repoRootFrom(scriptDir) {
  return path.resolve(scriptDir, '..');
}

/** Locations derived from the repo root. Kept in one place so the script, the
 *  tests, and package.json's extraResources agree on the layout. */
export function mingitPaths(repoRoot) {
  const thirdParty = path.join(repoRoot, 'third_party', 'git-for-windows');
  const stagingDir = path.join(thirdParty, '.staging');
  const payloadDir = path.join(stagingDir, 'mingit');
  return {
    thirdParty,
    manifestPath: path.join(thirdParty, 'mingit-manifest.json'),
    systemGitconfigPath: path.join(thirdParty, 'system-gitconfig'),
    stagingDir,
    payloadDir,
    // Marker recording the SHA that was successfully staged → drives idempotency.
    stampPath: path.join(stagingDir, '.staged-sha256'),
  };
}

// ── Manifest ────────────────────────────────────────────────────────────────

/** Read + minimally validate the manifest JSON. (The rich schema validation
 *  lives in src/main/git/mingit-manifest.ts; this .mjs script cannot import the
 *  compiled TS at fetch time, so it re-reads the raw JSON and checks the fields
 *  it actually uses.) */
export function readManifest(manifestPath) {
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new Error(`fetch-mingit: cannot read manifest '${manifestPath}': ${errMsg(err)}`);
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (err) {
    throw new Error(`fetch-mingit: invalid JSON in '${manifestPath}': ${errMsg(err)}`);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('fetch-mingit: manifest must be a JSON object');
  }
  for (const key of ['version', 'archiveUrl', 'sha256', 'archiveName', 'packagedGitExeRelPath']) {
    if (typeof m[key] !== 'string') {
      throw new Error(`fetch-mingit: manifest key '${key}' must be a string`);
    }
  }
  return m;
}

/** The manifest is "not yet pinned" while version / archiveUrl / sha256 are
 *  placeholder empty strings (WP-G0.1 ships them empty; Open decision #1). */
export function isPlaceholderManifest(m) {
  return !m.version.trim() || !m.archiveUrl.trim() || !m.sha256.trim();
}

/** Throw a clear, actionable error if the manifest has not been pinned yet. */
export function assertManifestPinned(m) {
  if (isPlaceholderManifest(m)) {
    throw new Error(
      'fetch-mingit: manifest not yet pinned (Open decision #1). ' +
        'third_party/git-for-windows/mingit-manifest.json still holds placeholder ' +
        'empty strings for version/archiveUrl/sha256. Pin the Git-for-Windows MinGit ' +
        'version (fill version, archiveUrl, sha256, archiveName) before fetching. ' +
        'This script will not invent pin values.',
    );
  }
}

// ── Checksum ──────────────────────────────────────────────────────────────────

/** Streaming SHA-256 of a file → lowercase hex. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Verify `filePath` against `expectedHex`. On mismatch: DELETE the bad file and
 *  throw loudly (a corrupt/tampered download must never reach unpack). Returns
 *  the verified digest on success. Comparison is case-insensitive on the hex. */
export async function verifyChecksum(filePath, expectedHex) {
  const expected = String(expectedHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`fetch-mingit: expected sha256 is not a 64-hex string: '${expectedHex}'`);
  }
  const actual = (await sha256File(filePath)).toLowerCase();
  if (actual !== expected) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best-effort cleanup; the throw below is the real signal */
    }
    throw new Error(
      `fetch-mingit: SHA-256 MISMATCH for '${path.basename(filePath)}'.\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        'The downloaded archive was deleted. Refusing to unpack an unverified payload.',
    );
  }
  return actual;
}

// ── Download ──────────────────────────────────────────────────────────────────

/** Download `url` to `dest` using the global fetch (Node ≥ 18). Streams to disk.
 *  Not used by tests — the flow is exercised offline via an injected fetchArchive. */
export async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res || !res.ok) {
    throw new Error(`fetch-mingit: download failed (${res ? res.status : 'no response'}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

// ── Unpack ────────────────────────────────────────────────────────────────────

/** The Windows System32 `tar.exe` — bsdtar/libarchive, which reads `.zip`. We
 *  invoke it by absolute path (not bare `tar`) so a GNU tar earlier on PATH, e.g.
 *  Git-for-Windows', which cannot extract zip, is never picked. */
function windowsBsdTar() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/** Unpack a `.zip` `archivePath` into `destDir` (created fresh). The real MinGit
 *  payload is a `.zip`. On Windows we use the System32 bsdtar (libarchive reads
 *  zip natively); on POSIX dev we fall back to `unzip`. `destDir` is removed
 *  first so unpack is a clean overwrite (idempotent staging). */
export function unpackArchive(archivePath, destDir) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`fetch-mingit: archive to unpack does not exist: ${archivePath}`);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  let r;
  if (process.platform === 'win32') {
    // bsdtar treats a `-f` value like `C:\…` as a remote `host:path`, so run from
    // the archive's own directory and pass just the basename for `-f`. `-C` may
    // stay absolute — remote detection only applies to the archive argument.
    r = spawnSync(windowsBsdTar(), ['-xf', path.basename(archivePath), '-C', destDir], {
      cwd: path.dirname(archivePath),
      encoding: 'utf-8',
    });
  } else {
    r = spawnSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { encoding: 'utf-8' });
  }
  if (r.error) {
    throw new Error(`fetch-mingit: failed to spawn the unzip tool: ${errMsg(r.error)}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `fetch-mingit: unpack of '${archivePath}' failed (exit ${r.status}).\n${(r.stderr || '').trim()}`,
    );
  }
  return destDir;
}

// ── Post-unpack payload shaping ───────────────────────────────────────────────

/** Copy the manifest JSON in beside the payload, so the packaged loader can read
 *  <resourcesPath>/mingit/mingit-manifest.json. */
export function copyManifestBeside(manifestPath, payloadDir) {
  const dest = path.join(payloadDir, 'mingit-manifest.json');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.copyFileSync(manifestPath, dest);
  return dest;
}

/** Write the bundled system git config to <payloadDir>/etc/gitconfig from the
 *  checked-in system-gitconfig ([core] longpaths = true). This is the bundled
 *  Program's OWN system config (invariant §5) — inert when Lares/the shell use a
 *  system-installed git, never the user's real system config. */
export function applySystemGitconfig(systemGitconfigPath, payloadDir) {
  const etcDir = path.join(payloadDir, 'etc');
  const dest = path.join(etcDir, 'gitconfig');
  fs.mkdirSync(etcDir, { recursive: true });
  fs.copyFileSync(systemGitconfigPath, dest);
  return dest;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Stage the MinGit payload end-to-end. Idempotent: if the staging stamp already
 * records the pinned SHA and the payload git.exe is present, it is a no-op.
 *
 * @param {object} opts
 * @param {object} opts.manifest              pinned manifest (caller asserts pinned)
 * @param {string} opts.stagingDir            .staging root
 * @param {string} opts.payloadDir            .staging/mingit
 * @param {string} opts.manifestPath          source manifest JSON path
 * @param {string} opts.systemGitconfigPath   source system-gitconfig path
 * @param {(url:string,dest:string)=>Promise<string>} [opts.fetchArchive]
 *        download seam; defaults to the real network download. Tests inject a
 *        local copy so the flow runs offline.
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{status:'staged'|'skipped', payloadDir:string, sha256:string, gitExe:string}>}
 */
export async function stageMinGit(opts) {
  const {
    manifest,
    stagingDir,
    payloadDir,
    manifestPath,
    systemGitconfigPath,
    fetchArchive = downloadFile,
    log = () => {},
  } = opts;

  const expectedSha = String(manifest.sha256 || '').trim().toLowerCase();
  const gitExeRel = manifest.packagedGitExeRelPath || 'cmd/git.exe';
  const gitExe = path.join(payloadDir, ...gitExeRel.split(/[\\/]/));
  const stampPath = path.join(stagingDir, '.staged-sha256');

  // Idempotency: prior successful stage recorded this SHA and the payload is intact.
  if (fs.existsSync(stampPath) && fs.existsSync(gitExe)) {
    const prev = fs.readFileSync(stampPath, 'utf-8').trim().toLowerCase();
    if (prev === expectedSha) {
      log(`fetch-mingit: staging already matches ${expectedSha} — no-op.`);
      return { status: 'skipped', payloadDir, sha256: expectedSha, gitExe };
    }
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  const archivePath = path.join(stagingDir, manifest.archiveName || 'mingit-archive');

  log(`fetch-mingit: downloading ${manifest.archiveUrl} → ${archivePath}`);
  await fetchArchive(manifest.archiveUrl, archivePath);

  log('fetch-mingit: verifying SHA-256…');
  const sha = await verifyChecksum(archivePath, expectedSha);

  log(`fetch-mingit: unpacking → ${payloadDir}`);
  unpackArchive(archivePath, payloadDir);

  copyManifestBeside(manifestPath, payloadDir);
  applySystemGitconfig(systemGitconfigPath, payloadDir);

  if (!fs.existsSync(gitExe)) {
    throw new Error(
      `fetch-mingit: unpack completed but expected git.exe not found at '${gitExe}' ` +
        `(packagedGitExeRelPath='${gitExeRel}'). The archive layout may not be a MinGit payload.`,
    );
  }

  fs.writeFileSync(stampPath, sha + '\n');
  log(`fetch-mingit: staged ${manifest.version} at ${payloadDir}`);
  return { status: 'staged', payloadDir, sha256: sha, gitExe };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

export async function main(scriptDir) {
  const repoRoot = repoRootFrom(scriptDir);
  const p = mingitPaths(repoRoot);
  const manifest = readManifest(p.manifestPath);
  assertManifestPinned(manifest); // throws the clear not-pinned error until Edward pins

  const result = await stageMinGit({
    manifest,
    stagingDir: p.stagingDir,
    payloadDir: p.payloadDir,
    manifestPath: p.manifestPath,
    systemGitconfigPath: p.systemGitconfigPath,
    log: (m) => console.log(m),
  });

  console.log(
    result.status === 'skipped'
      ? `fetch-mingit: OK (already staged) — ${result.payloadDir}`
      : `fetch-mingit: OK — staged MinGit ${manifest.version} (sha256 ${result.sha256}) at ${result.payloadDir}`,
  );
}

// Run only when invoked directly (not when imported by the test).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  main(scriptDir).catch((err) => {
    console.error('\n' + errMsg(err));
    process.exit(1);
  });
}
