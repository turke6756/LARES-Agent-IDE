// SC-WP-1B — DirtyInventory producer (bundle contract v1 §2).
//
//   npm run build:main
//   node dist/main/main/commit-candidates/dirty-inventory.test.js
//
// Two fixture styles, both legitimate:
//   • REAL git in throwaway temp repos (never this working tree) — proves the real
//     `status --porcelain=v2 -z` command + byte-split + field extraction + raw
//     hashing for the cases reproducible on the dev platform (modify, add, rename,
//     copy, delete-vs-unavailable-hash, untracked, ignored-excluded, unmerged,
//     junk-dir tolerance, scope pathspec).
//   • SYNTHETIC crafted porcelain bytes via a fake `runGitBytes` — the ONLY way to
//     exercise non-UTF-8 / control-char paths, symlink 120000, gitlink 160000, and
//     submodule state on Windows (NTFS is UTF-16; symlinks need privilege).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  produceDirtyInventory,
  encodeGitPath,
  type DirtyInventoryDraft,
  type RunGitBytesLike,
  type RunGitTextLike,
} from './dirty-inventory';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';
import type { RepositoryIdentity } from '../../shared/commit-candidates';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-dirtyinv-'));
  trash.push(dir);
  return dir;
}
function cleanup(): void {
  for (const dir of trash.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const IDENTITY: RepositoryIdentity = {
  repositoryKey: 'repokey-abc',
  objectDatabaseKey: 'odbkey',
  gitObjectFormat: 'sha1',
  bareRepo: false,
  workspaces: [{ workspaceId: 'ws1', workspacePrefix: '' }],
};

// ── real-git temp repo helpers ────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd, encoding: 'utf8' });
}

function mkRepo(): string {
  const dir = mkTmpDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function commitAll(dir: string, msg: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

/** Run the producer against a REAL repo, binding the real byte + text seams. */
function runReal(repoRoot: string, workspacePrefix = ''): Promise<DirtyInventoryDraft> {
  return produceDirtyInventory({
    repoRoot,
    workspacePrefix,
    repository: { ...IDENTITY, repositoryKey: `key:${repoRoot}` },
    runGitBytes: (cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe: EXE }),
    runGit: (cwd, args, opts) => runGit(cwd, args, { ...opts, gitExe: EXE }),
    gitExe: EXE,
  });
}

const byPath = (draft: DirtyInventoryDraft, p: string) =>
  draft.entries.find((e) => e.path.displayPath === p);

// ── synthetic fixture helpers ─────────────────────────────────────────────────

/** Build a fake `runGitBytes` returning exactly `stdout` (a crafted porcelain
 *  stream). Asserts the producer issues the normative status command + scope. */
function fakeBytes(stdout: Buffer, capture?: { args?: string[] }): RunGitBytesLike {
  return async (_cwd, args, _opts) => {
    if (capture) capture.args = args;
    return { code: 0, stdout, stderr: '' };
  };
}
/** A text seam that returns a fixed OID for any hash-object probe. */
const fakeHash: RunGitTextLike = async (_cwd, _args, _opts) => ({ code: 0, stdout: 'deadbeefcafe0000000000000000000000000000\n', stderr: '' });

function syntheticDraft(records: string[], opts?: { capture?: { args?: string[] }; hash?: RunGitTextLike }): Promise<DirtyInventoryDraft> {
  // Each record is a latin1 string possibly containing an embedded NUL for rename
  // origPaths; join with NUL terminators to mimic `-z`.
  const stdout = Buffer.concat(records.map((r) => Buffer.concat([Buffer.from(r, 'latin1'), Buffer.from([0])])));
  return produceDirtyInventory({
    repoRoot: 'C:/fake',
    workspacePrefix: '',
    repository: IDENTITY,
    runGitBytes: fakeBytes(stdout, opts?.capture),
    runGit: opts?.hash ?? fakeHash,
    gitExe: 'git',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REAL-GIT temp-repo cases
// ════════════════════════════════════════════════════════════════════════════

test('normative status command + scope pathspec are issued', async () => {
  const cap: { args?: string[] } = {};
  await syntheticDraft(['1 M. N... 100644 100644 100644 aaaa bbbb file.txt'], { capture: cap });
  assert.deepEqual(cap.args, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all']);

  const cap2: { args?: string[] } = {};
  await produceDirtyInventory({
    repoRoot: 'C:/fake', workspacePrefix: 'sub/dir', repository: IDENTITY,
    runGitBytes: fakeBytes(Buffer.alloc(0), cap2), runGit: fakeHash, gitExe: 'git',
  });
  assert.deepEqual(cap2.args, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ':(top,literal)sub/dir']);
});

test('modify: ordinary entry, present, raw hash surfaced, supported', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  commitAll(repo, 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');

  const draft = await runReal(repo);
  const e = byPath(draft, 'a.txt');
  assert.ok(e, 'a.txt present');
  assert.equal(e!.entryKind, 'ordinary');
  assert.equal(e!.expectedWorktreeState, 'present');
  assert.equal(e!.worktreeStatus, 'M');
  assert.equal(e!.gitLevelEligibility, 'supported');
  assert.ok(e!.rawWorktreeBlobOid && /^[0-9a-f]{40,64}$/.test(e!.rawWorktreeBlobOid), 'raw hash surfaced');
  // raw hash must equal git's own hash-object of the worktree bytes.
  const expected = git(repo, ['hash-object', '--no-filters', '--', 'a.txt']).trim();
  assert.equal(e!.rawWorktreeBlobOid, expected);
  assert.deepEqual(e!.commitPathspecs.map((p) => p.displayPath), ['a.txt']);
  const expectedId = createHash('sha256')
    .update(draft.repository.repositoryKey + encodeGitPath(Buffer.from('a.txt')).pathBytesBase64)
    .digest('hex');
  assert.equal(e!.entryId, expectedId);
});

test('rename: BOTH paths in commitPathspecs, originalPath preserved', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'old.txt'), 'content that is long enough to detect as a rename\n');
  commitAll(repo, 'init');
  git(repo, ['mv', 'old.txt', 'new.txt']);

  const draft = await runReal(repo);
  const e = byPath(draft, 'new.txt');
  assert.ok(e, 'renamed entry present under new path');
  assert.equal(e!.entryKind, 'rename-or-copy');
  assert.ok(e!.originalPath, 'originalPath set');
  assert.equal(e!.originalPath!.displayPath, 'old.txt');
  const specs = e!.commitPathspecs.map((p) => p.displayPath).sort();
  assert.deepEqual(specs, ['new.txt', 'old.txt'], 'BOTH old and new paths');
  assert.ok(e!.renameOrCopyScore, 'score captured');
});

test('copy: source + destination both surfaced in commitPathspecs', async () => {
  const repo = mkRepo();
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'src.txt'), body);
  commitAll(repo, 'init');
  // Stage an identical copy; -C detection requires --find-copies.
  fs.writeFileSync(path.join(repo, 'dst.txt'), body);
  git(repo, ['add', 'dst.txt']);

  // Use status with copy detection via config so porcelain emits a type-2 'C'.
  git(repo, ['config', 'status.renames', 'copies']);
  const draft = await runReal(repo);
  const e = byPath(draft, 'dst.txt');
  assert.ok(e, 'copy destination present');
  if (e!.entryKind === 'rename-or-copy') {
    assert.ok(e!.originalPath, 'copy source preserved');
    const specs = e!.commitPathspecs.map((p) => p.displayPath).sort();
    assert.deepEqual(specs, ['dst.txt', 'src.txt']);
  } else {
    // Some git builds report the copy as a plain add; still must include dst path.
    assert.deepEqual(e!.commitPathspecs.map((p) => p.displayPath), ['dst.txt']);
  }
});

test('deletion is absent (distinct from unavailable hash) with null raw hash', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(repo, 'kept.txt'), 'stay\n');
  commitAll(repo, 'init');
  fs.rmSync(path.join(repo, 'gone.txt'));

  const draft = await runReal(repo);
  const del = byPath(draft, 'gone.txt');
  assert.ok(del, 'deletion surfaced');
  assert.equal(del!.expectedWorktreeState, 'absent', 'deletion is absent');
  assert.equal(del!.rawWorktreeBlobOid, null, 'absent ⇒ no raw hash (not "unavailable")');
  assert.equal(del!.worktreeMode, null, 'worktree mode 000000 normalized to null');
});

test('untracked included; ignored excluded (--exclude-standard semantics)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  commitAll(repo, 'init');
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');

  const draft = await runReal(repo);
  const u = byPath(draft, 'fresh.txt');
  assert.ok(u, 'untracked included');
  assert.equal(u!.entryKind, 'untracked');
  assert.equal(u!.gitLevelEligibility, 'supported');
  assert.ok(u!.rawWorktreeBlobOid, 'untracked raw hash surfaced');
  assert.equal(byPath(draft, 'ignored.log'), undefined, 'ignored file excluded');
});

test('unmerged conflict → entryKind unmerged, unsupported-git-state', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'c.txt'), 'base\n');
  commitAll(repo, 'base');
  const mainBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repo, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'feature\n');
  commitAll(repo, 'feature');
  git(repo, ['checkout', '-q', mainBranch]);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'main\n');
  commitAll(repo, 'main');
  try { git(repo, ['merge', 'feature']); } catch { /* expected conflict */ }

  const draft = await runReal(repo);
  const e = byPath(draft, 'c.txt');
  assert.ok(e, 'conflicted path surfaced');
  assert.equal(e!.entryKind, 'unmerged');
  assert.equal(e!.gitLevelEligibility, 'unsupported-git-state');
});

test('tolerates repo-root invalid-char / junk dirs without choking', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'base.txt'), 'x\n');
  commitAll(repo, 'init');
  // Mimic this workspace's real `agentdash-codex-wsl-*` junk dirs.
  const junk = path.join(repo, 'agentdash-codex-wsl-1234');
  fs.mkdirSync(junk);
  fs.writeFileSync(path.join(junk, 'weird name (1).tmp'), 'junk\n');
  fs.writeFileSync(path.join(repo, 'normal.txt'), 'ok\n');

  const draft = await runReal(repo);
  assert.ok(byPath(draft, 'normal.txt'), 'normal untracked file still parsed');
  // The junk file appears (untracked) and does not crash parsing.
  assert.ok(draft.entries.some((e) => e.path.displayPath.includes('agentdash-codex-wsl-1234')));
});

test('scope pathspec limits results to the workspace prefix (real repo)', async () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'inside'));
  fs.mkdirSync(path.join(repo, 'outside'));
  fs.writeFileSync(path.join(repo, 'inside', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'outside', 'b.txt'), 'b\n');
  commitAll(repo, 'init');
  fs.writeFileSync(path.join(repo, 'inside', 'a.txt'), 'a2\n');
  fs.writeFileSync(path.join(repo, 'outside', 'b.txt'), 'b2\n');

  const draft = await runReal(repo, 'inside');
  assert.ok(byPath(draft, 'inside/a.txt'), 'in-scope change present');
  assert.equal(byPath(draft, 'outside/b.txt'), undefined, 'out-of-scope change excluded');
});

// ════════════════════════════════════════════════════════════════════════════
// SYNTHETIC crafted-byte cases (non-UTF-8, symlink, gitlink, submodule)
// ════════════════════════════════════════════════════════════════════════════

test('symlink mode 120000 is supported', async () => {
  const draft = await syntheticDraft(['1 M. N... 120000 120000 120000 aaaa bbbb link']);
  const e = draft.entries[0];
  assert.equal(e.worktreeMode, '120000');
  assert.equal(e.gitLevelEligibility, 'supported', 'symlinks are supported');
});

test('gitlink mode 160000 is unsupported-git-state', async () => {
  const draft = await syntheticDraft(['1 M. N... 160000 160000 160000 aaaa bbbb submod']);
  const e = draft.entries[0];
  assert.equal(e.worktreeMode, '160000');
  assert.equal(e.gitLevelEligibility, 'unsupported-git-state', 'gitlink ineligible');
});

test('submodule state (S<c><m><u>) captured + marks unsupported', async () => {
  const draft = await syntheticDraft(['1 .M SCM. 160000 160000 160000 aaaa bbbb sub']);
  const e = draft.entries[0];
  assert.equal(e.submoduleState, 'SCM.');
  assert.equal(e.gitLevelEligibility, 'unsupported-git-state');
});

test('non-UTF-8 path: bytes preserved in base64, utf8Clean false, unsupported', async () => {
  // Craft a type-1 record whose path is the raw bytes 0xff 0xfe (invalid UTF-8).
  const header = Buffer.from('1 M. N... 100644 100644 100644 aaaa bbbb ', 'latin1');
  const badPath = Buffer.from([0xff, 0xfe]);
  const stdout = Buffer.concat([header, badPath, Buffer.from([0])]);
  const draft = await produceDirtyInventory({
    repoRoot: 'C:/fake', workspacePrefix: '', repository: IDENTITY,
    runGitBytes: async () => ({ code: 0, stdout, stderr: '' }),
    runGit: fakeHash, gitExe: 'git',
  });
  const e = draft.entries[0];
  assert.equal(e.path.pathBytesBase64, badPath.toString('base64'), 'raw bytes preserved authoritatively');
  assert.equal(e.path.utf8Clean, false, 'lossy decode marked');
  assert.equal(e.gitLevelEligibility, 'unsupported-git-state', 'non-UTF-8 path ineligible');
  assert.equal(e.rawWorktreeBlobOid, null, 'non-UTF-8 path not hashed via string argv');
});

test('control-char path: bytes preserved, displayPath escaped, still supported/hashed', async () => {
  // A tab inside an otherwise-valid UTF-8 path: utf8Clean true, display escaped.
  const header = Buffer.from('1 M. N... 100644 100644 100644 aaaa bbbb ', 'latin1');
  const p = Buffer.from('a\tb.txt', 'utf8');
  const stdout = Buffer.concat([header, p, Buffer.from([0])]);
  const draft = await produceDirtyInventory({
    repoRoot: 'C:/fake', workspacePrefix: '', repository: IDENTITY,
    runGitBytes: async () => ({ code: 0, stdout, stderr: '' }),
    runGit: fakeHash, gitExe: 'git',
  });
  const e = draft.entries[0];
  assert.equal(e.path.utf8Clean, true);
  assert.equal(e.path.displayPath, 'a\\tb.txt', 'control char escaped for display');
  assert.equal(e.path.pathBytesBase64, p.toString('base64'), 'authoritative bytes are the real path');
  assert.equal(e.gitLevelEligibility, 'supported');
});

test('rename record with embedded-NUL origPath splits correctly (synthetic -z)', async () => {
  // type-2 record: header ... newpath \0 oldpath, then the record-terminator \0.
  const rec = '2 R100 N... 100644 100644 100644 aaaa bbbb R100 new.txt\0old.txt';
  const draft = await syntheticDraft([rec]);
  const e = draft.entries[0];
  assert.equal(e.entryKind, 'rename-or-copy');
  assert.equal(e.path.displayPath, 'new.txt');
  assert.equal(e.originalPath!.displayPath, 'old.txt');
  assert.equal(e.renameOrCopyScore, '100');
  assert.deepEqual(e.commitPathspecs.map((p) => p.displayPath).sort(), ['new.txt', 'old.txt']);
});

test('staged deletion (mW 000000) is absent with no raw hash', async () => {
  const draft = await syntheticDraft(['1 D. N... 100644 000000 000000 aaaa 0000 removed.txt']);
  const e = draft.entries[0];
  assert.equal(e.expectedWorktreeState, 'absent');
  assert.equal(e.rawWorktreeBlobOid, null);
  assert.equal(e.indexStatus, 'D');
});

test('entryId = sha256(repositoryKey + pathBytesBase64)', async () => {
  const draft = await syntheticDraft(['1 M. N... 100644 100644 100644 aaaa bbbb id.txt']);
  const e = draft.entries[0];
  const expected = createHash('sha256')
    .update(IDENTITY.repositoryKey + encodeGitPath(Buffer.from('id.txt')).pathBytesBase64)
    .digest('hex');
  assert.equal(e.entryId, expected);
});

// ── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  FAIL — no compatible git resolved; SC-WP-1B real-git fixtures require git.');
    process.exit(1);
  }
  EXE = internal.execPath;

  let passed = 0, failed = 0;
  try {
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
  } finally {
    cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
