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
import crypto from 'node:crypto';
import {
  migrateWorkspaceStateDir,
  workspaceStateDirName,
  workspaceStateDir,
  translateStateRelPath,
  resetWorkspaceStateDirCacheForTests,
  isLegacyLauncherContent,
  detectLegacyLauncher,
  checkWorkspaceSecurityOnOpen,
  listPendingSecurityNotices,
  removeLegacyLauncher,
  resetWorkspaceSecurityCacheForTests,
  LEGACY_LAUNCHER_NOTICE_TITLE,
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

// ── P0.2 legacy launcher `.vbs` sweep ────────────────────────────────
//   Detection is CONTENT-based (WScript.Shell + a cmd invocation) over ALL
//   top-level `*.vbs` in the workspace root — the filename is arbitrary
//   (the real incident's file was `Launch-Lares.vbs`), never name-only;
//   detection never mutates; removal is explicit, sweep-flagged-only,
//   content-revalidated, Recycle-Bin-only (injected trashItem seam), logged.

// The exact shape early builds wrote: WScript.Shell spawning a hidden cmd.
const MATCHING_LAUNCH_VBS = [
  'Set shell = CreateObject("WScript.Shell")',
  'shell.Run "cmd /c start /min powershell -WindowStyle Hidden -File launch.ps1", 0, False',
  '',
].join('\r\n');

// A user's unrelated VBS that happens to be named launch.vbs — no cmd spawn.
const UNRELATED_LAUNCH_VBS = [
  "' backs up my savegames",
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'fso.CopyFile "saves\\*.sav", "backup\\"',
  '',
].join('\r\n');

function freshSecurityRoot(tag: string): string {
  const root = freshRoot(tag);
  resetWorkspaceSecurityCacheForTests();
  return root;
}

test('predicate: needs BOTH WScript.Shell and a cmd invocation (normalized content)', () => {
  assert.equal(isLegacyLauncherContent(MATCHING_LAUNCH_VBS), true);
  assert.equal(isLegacyLauncherContent(UNRELATED_LAUNCH_VBS), false);
  // One marker alone is never enough.
  assert.equal(isLegacyLauncherContent('Set s = CreateObject("WScript.Shell")\ns.Run "notepad.exe"'), false);
  assert.equal(isLegacyLauncherContent('run cmd /c echo hi'), false);
  // Case/whitespace-insensitive: normalization is lowercase + collapsed runs.
  assert.equal(isLegacyLauncherContent('CreateObject("WSCRIPT.Shell")\r\n\ts.Run "CMD.EXE /c x"'), true);
  // `cmd` must be a word, not a substring of an unrelated token.
  assert.equal(isLegacyLauncherContent('WScript.Shell mycmdlet'), false);
});

test('matching launch.vbs: detected with notice (path + sha256), file untouched', () => {
  const root = freshSecurityRoot('vbs-hit');
  const vbsPath = path.join(root, 'launch.vbs');
  fs.writeFileSync(vbsPath, MATCHING_LAUNCH_VBS, 'utf-8');
  const before = fs.statSync(vbsPath).mtimeMs;

  const notices = checkWorkspaceSecurityOnOpen(root);

  assert.equal(notices.length, 1, 'expected exactly one security notice');
  const notice = notices[0];
  assert.equal(notice.filePath, vbsPath);
  assert.equal(notice.title, LEGACY_LAUNCHER_NOTICE_TITLE);
  assert.equal(
    notice.sha256,
    crypto.createHash('sha256').update(Buffer.from(MATCHING_LAUNCH_VBS)).digest('hex'),
  );
  // Detection never mutates: same bytes, same mtime.
  assert.equal(fs.readFileSync(vbsPath, 'utf-8'), MATCHING_LAUNCH_VBS);
  assert.equal(fs.statSync(vbsPath).mtimeMs, before);
  // Notice is pending for the renderer pull.
  assert.ok(listPendingSecurityNotices().some((n) => n.filePath === vbsPath));
  // Sweep is cached per process: second open call returns the same notice.
  assert.equal(checkWorkspaceSecurityOnOpen(root)[0]?.filePath, vbsPath);
});

test('arbitrary filename (Launch-Lares.vbs, the real incident): detected by content', () => {
  const root = freshSecurityRoot('vbs-incident-name');
  const vbsPath = path.join(root, 'Launch-Lares.vbs');
  fs.writeFileSync(vbsPath, MATCHING_LAUNCH_VBS, 'utf-8');

  const notices = checkWorkspaceSecurityOnOpen(root);

  assert.equal(notices.length, 1, 'content match must flag regardless of filename');
  assert.equal(notices[0].filePath, vbsPath);
  assert.equal(
    notices[0].sha256,
    crypto.createHash('sha256').update(Buffer.from(MATCHING_LAUNCH_VBS)).digest('hex'),
  );
  assert.equal(fs.readFileSync(vbsPath, 'utf-8'), MATCHING_LAUNCH_VBS, 'file untouched');
});

test('two matching .vbs files in the root: BOTH noticed', () => {
  const root = freshSecurityRoot('vbs-two');
  const a = path.join(root, 'Launch-Lares.vbs');
  const b = path.join(root, 'launch.vbs');
  fs.writeFileSync(a, MATCHING_LAUNCH_VBS, 'utf-8');
  fs.writeFileSync(b, MATCHING_LAUNCH_VBS + "' second copy\r\n", 'utf-8');
  // Distractors: non-matching .vbs and a matching .vbs BELOW the root
  // (sweep is top-level only, no recursion).
  fs.writeFileSync(path.join(root, 'unrelated.vbs'), UNRELATED_LAUNCH_VBS, 'utf-8');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'nested.vbs'), MATCHING_LAUNCH_VBS, 'utf-8');

  const notices = checkWorkspaceSecurityOnOpen(root);

  assert.deepEqual(
    notices.map((n) => n.filePath).sort(),
    [a, b].sort(),
    'both matching root-level launchers, nothing else',
  );
  assert.equal(listPendingSecurityNotices().length, 2);
});

test('non-matching .vbs files (user files): left alone, NO notice', () => {
  const root = freshSecurityRoot('vbs-miss');
  const vbsPath = path.join(root, 'launch.vbs');
  const otherPath = path.join(root, 'backup-saves.vbs');
  fs.writeFileSync(vbsPath, UNRELATED_LAUNCH_VBS, 'utf-8');
  fs.writeFileSync(otherPath, UNRELATED_LAUNCH_VBS, 'utf-8');

  const notices = checkWorkspaceSecurityOnOpen(root);

  assert.deepEqual(notices, [], 'name-only must never flag');
  assert.equal(listPendingSecurityNotices().length, 0);
  assert.equal(fs.readFileSync(vbsPath, 'utf-8'), UNRELATED_LAUNCH_VBS, 'file untouched');
  assert.equal(fs.readFileSync(otherPath, 'utf-8'), UNRELATED_LAUNCH_VBS, 'file untouched');
});

test('no .vbs at all: sweep is a quiet no-op', () => {
  const root = freshSecurityRoot('vbs-none');
  assert.deepEqual(checkWorkspaceSecurityOnOpen(root), []);
  assert.equal(listPendingSecurityNotices().length, 0);
});

test('removal action: trashes via the injected seam, logs, and clears the pending notice', async () => {
  const root = freshSecurityRoot('vbs-remove');
  const vbsPath = path.join(root, 'launch.vbs');
  fs.writeFileSync(vbsPath, MATCHING_LAUNCH_VBS, 'utf-8');
  assert.equal(checkWorkspaceSecurityOnOpen(root).length, 1);

  // Recycle-Bin seam: production passes Electron shell.trashItem; the test
  // moves the file into a "bin" dir so we can assert move-not-delete.
  const bin = path.join(root, '_bin');
  fs.mkdirSync(bin);
  const trashed: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  let res;
  try {
    res = await removeLegacyLauncher(vbsPath, {
      trashItem: async (p) => {
        trashed.push(p);
        fs.renameSync(p, path.join(bin, path.basename(p)));
      },
    });
  } finally {
    console.log = origLog;
  }

  assert.equal(res.removed, true);
  assert.deepEqual(trashed, [vbsPath]);
  assert.equal(fs.existsSync(vbsPath), false, 'gone from the workspace root');
  assert.equal(
    fs.readFileSync(path.join(bin, 'launch.vbs'), 'utf-8'),
    MATCHING_LAUNCH_VBS,
    'moved (recoverable), not destroyed',
  );
  assert.ok(
    logs.some((l) => l.includes('user-authorized removal') && l.includes(vbsPath) && l.includes(res.sha256!)),
    `expected a user-authorized-removal log with path + sha256; got: ${logs.join(' | ')}`,
  );
  assert.equal(listPendingSecurityNotices().length, 0, 'pending notice cleared');
});

test('removal of an arbitrary-named flagged launcher (Launch-Lares.vbs) works', async () => {
  const root = freshSecurityRoot('vbs-remove-incident');
  const vbsPath = path.join(root, 'Launch-Lares.vbs');
  fs.writeFileSync(vbsPath, MATCHING_LAUNCH_VBS, 'utf-8');
  assert.equal(checkWorkspaceSecurityOnOpen(root).length, 1);

  const trashed: string[] = [];
  const res = await removeLegacyLauncher(vbsPath, {
    trashItem: async (p) => { trashed.push(p); fs.rmSync(p); },
  });

  assert.equal(res.removed, true);
  assert.deepEqual(trashed, [vbsPath]);
  assert.equal(listPendingSecurityNotices().length, 0, 'pending notice cleared');
});

test('removal refuses unflagged paths and revalidates content', async () => {
  const root = freshSecurityRoot('vbs-refuse');
  const neverCalled = { trashItem: async () => { throw new Error('must not be called'); } };

  // Matching content but NEVER flagged by the sweep (written after it ran):
  // refused — removal only accepts paths main itself flagged.
  assert.deepEqual(checkWorkspaceSecurityOnOpen(root), []);
  const unflagged = path.join(root, 'evil.vbs');
  fs.writeFileSync(unflagged, MATCHING_LAUNCH_VBS, 'utf-8');
  const refused = await removeLegacyLauncher(unflagged, neverCalled);
  assert.equal(refused.removed, false, 'removal is scoped to sweep-flagged files only');
  assert.equal(fs.existsSync(unflagged), true);

  // Flagged, but content changed to something benign before removal ran:
  // the re-read revalidation refuses.
  const root2 = freshSecurityRoot('vbs-refuse-mutated');
  const mutated = path.join(root2, 'launch.vbs');
  fs.writeFileSync(mutated, MATCHING_LAUNCH_VBS, 'utf-8');
  assert.equal(checkWorkspaceSecurityOnOpen(root2).length, 1);
  fs.writeFileSync(mutated, UNRELATED_LAUNCH_VBS, 'utf-8');
  const stale = await removeLegacyLauncher(mutated, neverCalled);
  assert.equal(stale.removed, false, 'content revalidation must refuse');
  assert.equal(fs.existsSync(mutated), true, 'user file untouched');

  // Non-.vbs path is refused outright, flagged or not.
  const notVbs = await removeLegacyLauncher(path.join(root, 'launch.ps1'), neverCalled);
  assert.equal(notVbs.removed, false);
});

test('inert scaffold .bak sweep: recipe-bearing backups reported in the notice, innocent ones not', () => {
  const root = freshSecurityRoot('bak-sweep');
  fs.writeFileSync(path.join(root, 'launch.vbs'), MATCHING_LAUNCH_VBS, 'utf-8');
  const supDir = path.join(root, LARES_DIR_NAME, 'supervisor');
  const skillDir = path.join(root, LARES_DIR_NAME, 'workers', 'claude', '.claude', 'skills', 'run-orchestration');
  fs.mkdirSync(supDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  const recipeBak = path.join(supDir, 'CLAUDE.md.bak.v11');
  fs.writeFileSync(recipeBak, 'Launch with Start-Process powershell -WindowStyle Hidden ...', 'utf-8');
  const skillBak = path.join(skillDir, 'SKILL.md.bak.v12');
  fs.writeFileSync(skillBak, 'CreateObject("WScript.Shell") hidden spawn recipe', 'utf-8');
  const innocentBak = path.join(supDir, 'CLAUDE.md.bak.v14');
  fs.writeFileSync(innocentBak, 'plain scaffold text, nothing launch-related', 'utf-8');

  const notices = checkWorkspaceSecurityOnOpen(root);

  assert.equal(notices.length, 1);
  const notice = notices[0];
  assert.ok(notice.inertBackups.includes(recipeBak), 'supervisor CLAUDE.md.bak with recipe text');
  assert.ok(notice.inertBackups.includes(skillBak), 'nested SKILL.md.bak with recipe text');
  assert.ok(!notice.inertBackups.includes(innocentBak), 'innocent backup not reported');
  // Reported only — the sweep never touches them.
  assert.equal(fs.existsSync(recipeBak), true);
  assert.equal(fs.existsSync(innocentBak), true);
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
