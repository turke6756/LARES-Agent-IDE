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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
  // Pre-create `.lares/` so the state-dir first-touch migration takes the
  // deterministic "both exist → use .lares, leave .dashboard untouched" branch.
  // Without this, a fixture planted under the legacy `.dashboard/` REL gets
  // RENAMED to `.lares/` by the migration mid-writeScaffoldMap (the legacy-
  // prefixed relPath is not translated), and the planted file is silently
  // orphaned — an intermittent failure in tests 2/3.
  fs.mkdirSync(path.join(dir, '.lares'));
  return dir;
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

// ── Retirement entries (removed: true) — EDR hardening P0.1 ──────────
//
// A removal entry's bundled "content" is the file's absence: a pristine managed
// copy (hash in previousHashes) is deleted silently; a user-modified copy is
// .bak'd first; the sidecar records the removal version so a file the user
// later creates at the path is never touched.

// The removal tests create BOTH the target file and a sidecar. Using the legacy
// `.dashboard/`-prefixed REL would make the state-dir translation resolve reads
// to `.lares/` (both dirs exist once the sidecar is written) and miss the planted
// file — so these use a `.lares/`-native path.
const RM_REL = '.lares/gadget/config.txt';
const RM_KEY = 'gadget/config.txt'; // normalizeManagedKey(RM_REL)
function rmFilePath(workDir: string): string {
  return path.join(workDir, ...RM_REL.split('/'));
}
function rmFileDir(workDir: string): string {
  return path.dirname(rmFilePath(workDir));
}
function rmListBackups(workDir: string): string[] {
  const dir = rmFileDir(workDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith('config.txt.bak.'));
}

/** A v3 map that RETIRES the gadget file: known v1 + v2 hashes, no content. */
function removalMap(): Record<string, ScaffoldFile> {
  return {
    [RM_REL]: {
      content: '',
      removed: true,
      version: 3,
      previousHashes: { 1: sha256Hex(V1_CONTENT), 2: sha256Hex(V2_CONTENT) },
    },
  };
}

test('R1. removal: pristine v2 copy is deleted silently (no .bak), sidecar records v3', () => {
  const workDir = mktmp('sw-remove-pristine');
  try {
    fs.mkdirSync(rmFileDir(workDir), { recursive: true });
    fs.writeFileSync(rmFilePath(workDir), V2_CONTENT, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [RM_KEY]: 2 }, null, 2) + '\n', 'utf-8');

    const changed = writeScaffoldMap(workDir, removalMap(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 1, 'the removal counts as a change');
    assert.equal(fs.existsSync(rmFilePath(workDir)), false, 'pristine managed file must be deleted');
    assert.equal(fs.existsSync(rmFileDir(workDir)), false, 'empty parent dir is removed best-effort');
    assert.equal(readSidecar(workDir)[RM_KEY], 3, 'sidecar must record the removal version');
  } finally {
    rmrf(workDir);
  }
});

test('R2. removal: user-modified copy is .bak\'d then deleted', () => {
  const workDir = mktmp('sw-remove-usermod');
  try {
    fs.mkdirSync(rmFileDir(workDir), { recursive: true });
    const userEdited = V2_CONTENT + '// USER ADDED A LINE\n';
    fs.writeFileSync(rmFilePath(workDir), userEdited, 'utf-8');

    const changed = writeScaffoldMap(workDir, removalMap(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 1, 'the removal counts as a change');
    assert.equal(fs.existsSync(rmFilePath(workDir)), false, 'user-modified file is still removed');
    const backups = rmListBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(rmFileDir(workDir), backups[0]), 'utf-8'),
      userEdited,
      'backup must hold the user-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)[RM_KEY], 3, 'sidecar must record the removal version');
  } finally {
    rmrf(workDir);
  }
});

test('R3. removal: file already absent → sidecar stamped v3, nothing else', () => {
  const workDir = mktmp('sw-remove-absent');
  try {
    const changed = writeScaffoldMap(workDir, removalMap(), 'windows', { logPrefix: '[test]' });
    assert.equal(changed, 1, 'stamping the sidecar counts as a change');
    assert.equal(fs.existsSync(rmFilePath(workDir)), false);
    assert.equal(readSidecar(workDir)[RM_KEY], 3, 'sidecar must record the removal version');
  } finally {
    rmrf(workDir);
  }
});

test('R4. removal already applied: a file the user later creates at the path is NEVER touched', () => {
  const workDir = mktmp('sw-remove-recreated');
  try {
    // Sidecar says the removal (v3) was applied; the user then made their own file here.
    fs.mkdirSync(rmFileDir(workDir), { recursive: true });
    const usersOwn = '# my own new file at the retired path\n';
    fs.writeFileSync(rmFilePath(workDir), usersOwn, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [RM_KEY]: 3 }, null, 2) + '\n', 'utf-8');

    const changed = writeScaffoldMap(workDir, removalMap(), 'windows', { logPrefix: '[test]' });

    assert.equal(changed, 0, 'an applied removal must be a no-op forever after');
    assert.equal(fs.readFileSync(rmFilePath(workDir), 'utf-8'), usersOwn, 'user\'s new file must be untouched');
    assert.equal(rmListBackups(workDir).length, 0, 'no backup on no-op');
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
