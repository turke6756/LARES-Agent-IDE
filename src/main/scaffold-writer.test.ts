// scaffold-writer free-function tests — plans/persona-productization-impl.md §1.3.
//
// Asserts the D1 extraction is behavior-preserving in isolation: the three core
// version-migration branches exercised directly against the free
// `writeScaffoldMap(workDir, files, 'windows', …)` — no AgentSupervisor.
//   1. Fresh write → file + sidecar.
//   2. Silent upgrade by known previous-version hash (no .bak).
//   3. User-modified (unknown hash) → .bak + overwrite.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/scaffold-writer.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeScaffoldMap,
  sha256Hex,
  SCAFFOLD_SIDECAR_REL,
  type ScaffoldFile,
} from './scaffold-writer';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Fixtures ─────────────────────────────────────────────────────────

const REL = '.dashboard/widget/config.txt';
const KEY = 'widget/config.txt'; // normalizeManagedKey(REL)

const V1_CONTENT = 'widget config — version one\n';
const V2_CONTENT = 'widget config — version TWO (current)\n';

/** A managed map with a single v2 file that knows its v1 hash, so a v1 disk
 *  file upgrades silently and an unknown one is backed up. */
function v2Map(): Record<string, ScaffoldFile> {
  return {
    [REL]: { content: V2_CONTENT, version: 2, previousHashes: { 1: sha256Hex(V1_CONTENT) } },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
}
function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
function filePath(workDir: string): string {
  return path.join(workDir, ...REL.split('/'));
}
function fileDir(workDir: string): string {
  return path.dirname(filePath(workDir));
}
function sidecarPath(workDir: string): string {
  return path.join(workDir, ...SCAFFOLD_SIDECAR_REL.split('/'));
}
function readSidecar(workDir: string): Record<string, number> {
  return JSON.parse(fs.readFileSync(sidecarPath(workDir), 'utf-8'));
}
function listBackups(workDir: string): string[] {
  const dir = fileDir(workDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith('config.txt.bak.'));
}

// ── Tests ────────────────────────────────────────────────────────────

test('1. fresh write: writes content + records version in sidecar, no backup', () => {
  const workDir = mktmp('sw-fresh');
  try {
    assert.equal(fs.existsSync(filePath(workDir)), false, 'precondition: no file yet');

    const changed = writeScaffoldMap(workDir, v2Map(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 1, 'one file should be written');
    assert.equal(fs.readFileSync(filePath(workDir), 'utf-8'), V2_CONTENT, 'file must be exact bundled content');
    assert.equal(readSidecar(workDir)[KEY], 2, 'sidecar must record v2');
    assert.equal(listBackups(workDir).length, 0, 'no .bak on fresh write');
  } finally {
    rmrf(workDir);
  }
});

test('2. silent upgrade by known v1 hash: overwrite to v2, NO backup', () => {
  const workDir = mktmp('sw-known-v1');
  try {
    fs.mkdirSync(fileDir(workDir), { recursive: true });
    fs.writeFileSync(filePath(workDir), V1_CONTENT, 'utf-8');
    // No sidecar — diskVersion defaults to 0, previousHashes[1] still matches.

    const changed = writeScaffoldMap(workDir, v2Map(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 1, 'the upgrade counts as a write');
    assert.equal(fs.readFileSync(filePath(workDir), 'utf-8'), V2_CONTENT, 'file must be upgraded to v2');
    assert.equal(listBackups(workDir).length, 0, 'known-hash upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)[KEY], 2, 'sidecar must record v2');
  } finally {
    rmrf(workDir);
  }
});

test('3. user-modified (unknown hash): backup + overwrite', () => {
  const workDir = mktmp('sw-user-mod');
  try {
    fs.mkdirSync(fileDir(workDir), { recursive: true });
    const userEdited = V1_CONTENT + '// USER ADDED A LINE — DO NOT CLOBBER SILENTLY\n';
    fs.writeFileSync(filePath(workDir), userEdited, 'utf-8');

    const changed = writeScaffoldMap(workDir, v2Map(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 1, 'the overwrite counts as a write');
    assert.equal(fs.readFileSync(filePath(workDir), 'utf-8'), V2_CONTENT, 'active file must be upgraded to v2');

    const backups = listBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(fileDir(workDir), backups[0]), 'utf-8'),
      userEdited,
      'backup must hold the user-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)[KEY], 2, 'sidecar must record v2');
  } finally {
    rmrf(workDir);
  }
});

test('4. already current (sidecar v2 + matching file): no-op, no backup', () => {
  const workDir = mktmp('sw-current');
  try {
    fs.mkdirSync(fileDir(workDir), { recursive: true });
    fs.writeFileSync(filePath(workDir), V2_CONTENT, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [KEY]: 2 }, null, 2) + '\n', 'utf-8');

    const beforeMtime = fs.statSync(filePath(workDir)).mtimeMs;
    const changed = writeScaffoldMap(workDir, v2Map(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 0, 'nothing should change when sidecar says current');
    assert.equal(fs.statSync(filePath(workDir)).mtimeMs, beforeMtime, 'file must not be rewritten');
    assert.equal(listBackups(workDir).length, 0, 'no backup on no-op');
  } finally {
    rmrf(workDir);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
