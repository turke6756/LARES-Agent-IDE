#!/usr/bin/env node
// verify-package-payloads.mjs — the fail-LOUD packaging preflight.
//
// WHY THIS EXISTS
// ---------------
// electron-builder 26.8.1 does NOT hard-fail when an `extraResources` `from`
// path is missing: it logs a single yellow "file source doesn't exist" warning
// and exits 0 (app-builder-lib/out/fileMatcher.js:272-276). Net effect: a
// declared payload can silently vanish from the shipped package while the build
// still "succeeds". That is exactly how the bundled MinGit payload went missing
// for an entire release cycle.
//
// This preflight makes that impossible. Run BEFORE electron-builder (wired into
// `package:prepare`), it asserts every declared payload source actually exists on
// disk, and refuses the build — non-zero exit, naming the missing path and the
// command that fixes it — if any is absent.
//
// It checks, from package.json `build.extraResources`:
//   1. Every `from` path exists (the directory/file electron-builder will copy).
//   2. The bundled git exe is present at the staged path the manifest declares
//      (<mingit `from`>/<packagedGitExeRelPath>) — a present-but-empty mingit dir
//      is still a broken package.
//
// Dependency-free by design (Node stdlib only) so it can run as the last gate of
// package:prepare with nothing to install.
//
// Usage: node scripts/verify-package-payloads.mjs
// Exit 0 = every declared payload is present; exit 1 = one or more missing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Map an extraResources `from` value to the command that repopulates it, so the
 *  failure message tells the operator exactly how to fix it. */
function fixHintFor(fromRel) {
  const norm = fromRel.replace(/\\/g, '/');
  if (norm.includes('git-for-windows') && norm.includes('mingit')) {
    return "run 'npm run fetch:mingit' (needs third_party/git-for-windows/mingit-manifest.json pinned)";
  }
  if (norm.startsWith('native/')) {
    return "run 'npm run rebuild:native' to build the native addon";
  }
  return `expected a checked-in path at '${fromRel}'`;
}

/**
 * Pure check: given a repo root and the parsed package.json, return every missing
 * declared payload. Exported so the test can drive it against a fixture tree with
 * no real build.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot                repo root the `from` paths resolve against
 * @param {object} opts.pkg                     parsed package.json
 * @param {(p:string)=>boolean} [opts.exists]   fs.existsSync seam (injectable for tests)
 * @param {(p:string)=>string}  [opts.readFile] fs.readFileSync seam (injectable for tests)
 * @returns {{ failures: Array<{payload:string, missing:string, fix:string}> }}
 */
export function checkPayloads(opts) {
  const {
    repoRoot,
    pkg,
    exists = (p) => fs.existsSync(p),
    readFile = (p) => fs.readFileSync(p, 'utf-8'),
  } = opts;

  const failures = [];
  const extraResources = pkg?.build?.extraResources ?? [];

  for (const entry of extraResources) {
    const fromRel = typeof entry === 'string' ? entry : entry?.from;
    if (!fromRel) continue;
    const fromAbs = path.resolve(repoRoot, fromRel);

    // 1. The declared source must exist at all.
    if (!exists(fromAbs)) {
      failures.push({ payload: fromRel, missing: fromAbs, fix: fixHintFor(fromRel) });
      continue; // no point probing inside a dir that isn't there
    }

    // 2. Special case: the bundled MinGit payload must actually contain git.exe
    //    at the path the manifest declares. A present-but-empty mingit dir is a
    //    broken package (the failure mode a bare `from`-exists check would miss).
    const norm = fromRel.replace(/\\/g, '/');
    if (norm.includes('git-for-windows') && norm.endsWith('mingit')) {
      let relExe = 'cmd/git.exe';
      const manifestAbs = path.resolve(repoRoot, 'third_party', 'git-for-windows', 'mingit-manifest.json');
      try {
        const m = JSON.parse(readFile(manifestAbs));
        if (typeof m.packagedGitExeRelPath === 'string' && m.packagedGitExeRelPath.trim()) {
          relExe = m.packagedGitExeRelPath;
        }
      } catch {
        /* fall back to the default cmd/git.exe below */
      }
      const gitExeAbs = path.resolve(fromAbs, ...relExe.split(/[\\/]/));
      if (!exists(gitExeAbs)) {
        failures.push({
          payload: `${fromRel} (bundled git exe)`,
          missing: gitExeAbs,
          fix: "run 'npm run fetch:mingit' to (re)stage the MinGit payload",
        });
      }
    }
  }

  return { failures };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function repoRootFrom(scriptDir) {
  return path.resolve(scriptDir, '..');
}

export function main(scriptDir) {
  const repoRoot = repoRootFrom(scriptDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  const { failures } = checkPayloads({ repoRoot, pkg });

  if (failures.length > 0) {
    console.error(
      `verify-package-payloads: FAIL (${failures.length} missing payload${failures.length === 1 ? '' : 's'}) — ` +
        'electron-builder would SILENTLY ship a package without these. Refusing to build.',
    );
    for (const f of failures) {
      console.error(`  - ${f.payload}`);
      console.error(`      missing: ${f.missing}`);
      console.error(`      fix:     ${f.fix}`);
    }
    process.exit(1);
  }
  console.log('verify-package-payloads: OK — every declared extraResources payload is present.');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(path.dirname(fileURLToPath(import.meta.url)));
}
