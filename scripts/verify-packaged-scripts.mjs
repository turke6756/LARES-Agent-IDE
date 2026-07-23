#!/usr/bin/env node
// P0.4 (plans/edr-safety-hardening.md) — packaged-manifest assertion for the
// scripts/ allowlist. Standalone for now; intended to be absorbed into
// scripts/check-edr-patterns.mjs when that lint script lands (Worker B).
//
// Checks, in order:
//   1. package.json `build.extraResources` (from: scripts) filter matches
//      scripts/packaged-scripts-allowlist.json exactly (one source of truth).
//   2. Every file under the built resources/scripts is on the allowlist —
//      no test files, no *.ps1, no diagnostics, nothing outside `files` +
//      `dirs` may ship.
//   3. No unexpected executable extension anywhere under resources/scripts
//      (.ps1, .psm1, .bat, .cmd, .exe, .sh, .vbs) — belt-and-braces even for
//      allowlisted dirs.
//   4. Every allowlisted file is actually present (a missing MCP sidecar is a
//      broken package, not a lean one).
//
// Usage: node scripts/verify-packaged-scripts.mjs [path-to-resources-scripts]
//   Default target: release/win-unpacked/resources/scripts
// Exit 0 = clean; exit 1 = violations (listed on stderr).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(root, 'scripts', 'packaged-scripts-allowlist.json');
const packageJsonPath = path.join(root, 'package.json');
const target = path.resolve(
  process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'resources', 'scripts'),
);

const failures = [];
const fail = (msg) => failures.push(msg);

// ── load allowlist ───────────────────────────────────────────────────────────
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
const allowedFiles = new Set(allowlist.files);
const allowedDirs = allowlist.dirs; // top-level dirs whose contents ship (lib)

// ── 1. package.json extraResources filter ⇄ allowlist sync ──────────────────
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const scriptsEntry = (pkg.build?.extraResources ?? []).find((e) => e?.from === 'scripts');
if (!scriptsEntry) {
  fail('package.json: no build.extraResources entry with from:"scripts"');
} else {
  const expected = [...allowlist.files, ...allowlist.dirs.map((d) => `${d}/**`)].sort();
  const actual = [...(scriptsEntry.filter ?? [])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(
      'package.json extraResources scripts filter is out of sync with packaged-scripts-allowlist.json\n' +
      `    allowlist: ${JSON.stringify(expected)}\n` +
      `    package.json: ${JSON.stringify(actual)}`,
    );
  }
}

// ── walk the built resources/scripts ─────────────────────────────────────────
const EXECUTABLE_EXTS = new Set(['.ps1', '.psm1', '.bat', '.cmd', '.exe', '.sh', '.vbs']);

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relPath));
    else out.push(relPath);
  }
  return out;
}

if (!fs.existsSync(target)) {
  fail(`built scripts dir not found: ${target} — run 'npm run pack' (or 'npm run dist:win') first`);
} else {
  const shipped = walk(target);

  // ── 2. everything shipped must be allowlisted ──────────────────────────────
  for (const relPath of shipped) {
    const topDir = relPath.includes('/') ? relPath.split('/')[0] : null;
    const allowed = allowedFiles.has(relPath) || (topDir !== null && allowedDirs.includes(topDir));
    if (!allowed) fail(`unexpected file in packaged scripts: ${relPath}`);

    // ── 3. no executable extensions, allowlisted or not ──────────────────────
    if (EXECUTABLE_EXTS.has(path.extname(relPath).toLowerCase())) {
      fail(`executable extension must not ship in packaged scripts: ${relPath}`);
    }
  }

  // ── 4. every allowlisted file must be present ──────────────────────────────
  const shippedSet = new Set(shipped);
  for (const file of allowedFiles) {
    if (!shippedSet.has(file)) fail(`allowlisted script missing from package: ${file}`);
  }
  for (const dir of allowedDirs) {
    if (!shipped.some((p) => p.startsWith(`${dir}/`))) {
      fail(`allowlisted dir empty or missing from package: ${dir}/`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`verify-packaged-scripts: FAIL (${failures.length} violation${failures.length === 1 ? '' : 's'}) — target: ${target}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`verify-packaged-scripts: OK — ${target} matches the allowlist`);
