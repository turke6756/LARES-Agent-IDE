// Workspace state-dir migration tests — the one-time `.dashboard/` → `.lares/`
// rename (Lares rebrand). Exercises every branch of migrateWorkspaceStateDir:
//   1. Only legacy `.dashboard/` exists → renamed in place, contents intact.
//   2. BOTH exist → prefer `.lares`, leave `.dashboard` untouched, warn —
//      never delete or merge.
//   3. Rename blocked (target path occupied → renameSync throws, standing in
//      for Windows locked-file EPERM/EBUSY) → warn and fall back to
//      `.dashboard` for the session; nothing crashes, nothing is lost.
// Plus: fresh/already-migrated workspaces, per-process cache stickiness, and
// translateStateRelPath prefix swapping.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/workspace-state-dir.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  migrateWorkspaceStateDir,
  workspaceStateDirName,
  workspaceStateDir,
  translateStateRelPath,
  resetWorkspaceStateDirCacheForTests,
} from './workspace-state-dir';
import { LARES_DIR_NAME, LEGACY_LARES_DIR_NAME } from '../shared/constants';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

function freshRoot(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lares-migrate-${tag}-`));
  resetWorkspaceStateDirCacheForTests();
  return root;
}

function seedLegacyDir(root: string): void {
  const legacy = path.join(root, LEGACY_LARES_DIR_NAME);
  fs.mkdirSync(path.join(legacy, 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'supervisor', 'CLAUDE.md'), 'legacy content\n', 'utf-8');
  fs.writeFileSync(path.join(legacy, '.scaffold-versions.json'), '{"supervisor/CLAUDE.md": 15}\n', 'utf-8');
}

// ── Branch 1: only `.dashboard/` exists → renamed in place ───────────

test('legacy-only workspace: .dashboard/ is renamed to .lares/ with contents intact', () => {
  const root = freshRoot('rename');
  seedLegacyDir(root);

  const res = migrateWorkspaceStateDir(root);

  assert.equal(res.dirName, LARES_DIR_NAME);
  assert.equal(res.migrated, true);
  assert.equal(res.warning, undefined);
  assert.equal(fs.existsSync(path.join(root, LEGACY_LARES_DIR_NAME)), false, 'legacy dir must be gone');
  // Contents (incl. the scaffold sidecar) traveled with the rename.
  assert.equal(
    fs.readFileSync(path.join(root, LARES_DIR_NAME, 'supervisor', 'CLAUDE.md'), 'utf-8'),
    'legacy content\n',
  );
  assert.equal(
    fs.existsSync(path.join(root, LARES_DIR_NAME, '.scaffold-versions.json')), true,
    'sidecar must travel with the folder',
  );
});

// ── Branch 2: BOTH exist → prefer .lares, leave .dashboard untouched ──

test('both dirs exist: .lares wins, .dashboard is left byte-identical (never merged/deleted)', () => {
  const root = freshRoot('both');
  seedLegacyDir(root);
  fs.mkdirSync(path.join(root, LARES_DIR_NAME, 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(root, LARES_DIR_NAME, 'supervisor', 'CLAUDE.md'), 'live content\n', 'utf-8');

  const res = migrateWorkspaceStateDir(root);

  assert.equal(res.dirName, LARES_DIR_NAME);
  assert.equal(res.migrated, false);
  assert.ok(res.warning && /both .+ exist/.test(res.warning), `expected a both-exist warning; got: ${res.warning}`);
  // Legacy dir untouched — same file, same bytes.
  assert.equal(
    fs.readFileSync(path.join(root, LEGACY_LARES_DIR_NAME, 'supervisor', 'CLAUDE.md'), 'utf-8'),
    'legacy content\n',
  );
  // Live dir NOT overwritten by legacy content.
  assert.equal(
    fs.readFileSync(path.join(root, LARES_DIR_NAME, 'supervisor', 'CLAUDE.md'), 'utf-8'),
    'live content\n',
  );
});

// ── Branch 3: rename fails → warn + fall back to .dashboard ──────────

test('rename failure: session continues on .dashboard, nothing is deleted', () => {
  const root = freshRoot('locked');
  seedLegacyDir(root);
  // Simulate the Windows locked-folder case (EPERM/EBUSY while agent PTYs /
  // watchers hold files open) by making renameSync itself throw — patching is
  // deterministic where a real lock is not, and the branch under test is the
  // catch (fallback), not Windows' locking semantics.
  const origRename = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    throw err;
  };
  let res;
  try {
    res = migrateWorkspaceStateDir(root);
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = origRename;
  }

  assert.equal(res.dirName, LEGACY_LARES_DIR_NAME, 'must fall back to .dashboard for the session');
  assert.equal(res.migrated, false);
  assert.ok(res.warning && /could not rename/.test(res.warning), `expected a rename-failure warning; got: ${res.warning}`);
  // Legacy dir fully intact.
  assert.equal(
    fs.readFileSync(path.join(root, LEGACY_LARES_DIR_NAME, 'supervisor', 'CLAUDE.md'), 'utf-8'),
    'legacy content\n',
  );
  // Path helpers follow the fallback for this session.
  assert.equal(workspaceStateDirName(root), LEGACY_LARES_DIR_NAME);
  assert.equal(workspaceStateDir(root), path.join(root, LEGACY_LARES_DIR_NAME));
  assert.equal(
    translateStateRelPath(root, '.lares/scripts/dashboard-status.mjs'),
    '.dashboard/scripts/dashboard-status.mjs',
  );
});

// ── Fresh + already-migrated workspaces ──────────────────────────────

test('fresh workspace (neither dir): resolves .lares, creates nothing', () => {
  const root = freshRoot('fresh');
  const res = migrateWorkspaceStateDir(root);
  assert.equal(res.dirName, LARES_DIR_NAME);
  assert.equal(res.migrated, false);
  assert.equal(fs.existsSync(path.join(root, LARES_DIR_NAME)), false, 'resolver must not create the dir');
  assert.equal(fs.existsSync(path.join(root, LEGACY_LARES_DIR_NAME)), false);
});

test('already-migrated workspace (.lares only): no-op resolve', () => {
  const root = freshRoot('done');
  fs.mkdirSync(path.join(root, LARES_DIR_NAME), { recursive: true });
  const res = migrateWorkspaceStateDir(root);
  assert.equal(res.dirName, LARES_DIR_NAME);
  assert.equal(res.migrated, false);
  assert.equal(res.warning, undefined);
});

// ── Cache stickiness ─────────────────────────────────────────────────

test('decision is sticky per process (and per spelling of the root)', () => {
  const root = freshRoot('cache');
  seedLegacyDir(root);
  assert.equal(workspaceStateDirName(root), LARES_DIR_NAME); // performs the rename
  // Even if the dir vanishes afterwards, the session decision holds.
  fs.rmSync(path.join(root, LARES_DIR_NAME), { recursive: true, force: true });
  assert.equal(workspaceStateDirName(root), LARES_DIR_NAME);
  // Alternate spelling of the same root hits the same cache entry (no second
  // migration attempt against the now-missing dir).
  const altSpelling = root.replace(/\\/g, '/') + '/';
  assert.equal(workspaceStateDirName(altSpelling), LARES_DIR_NAME);
});

// ── translateStateRelPath ────────────────────────────────────────────

test('translateStateRelPath: identity on migrated workspaces, passthrough off the state dir', () => {
  const root = freshRoot('xlate');
  fs.mkdirSync(path.join(root, LARES_DIR_NAME), { recursive: true });
  assert.equal(
    translateStateRelPath(root, '.lares/workers/claude/CLAUDE.md'),
    '.lares/workers/claude/CLAUDE.md',
  );
  // Non-state-dir rels never touched (incl. lookalike prefixes).
  assert.equal(translateStateRelPath(root, 'src/main/index.ts'), 'src/main/index.ts');
  assert.equal(translateStateRelPath(root, '.laresx/file.txt'), '.laresx/file.txt');
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
