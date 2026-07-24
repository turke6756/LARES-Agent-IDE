// Git-Native WP-G1.1 — git-command bounded exec + binary streaming.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/git-command.test.js
//
// Unlike the pure-logic layers, THIS layer is exactly where real-process behavior
// matters, so these tests drive a REAL git in throwaway temp repos: arg-array
// integrity (no shell splitting), the timeout/deadline kill paths, lock
// classification, env sanitization, the injectable exe seam, and byte-exact blob
// streaming. Every temp dir/file lives under os.tmpdir() and is cleaned up.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GitBlobError,
  GitCommandError,
  runGit,
  runGitBlobToFile,
} from './git-command';
import { resolveInternalGit } from '../git/git-runtime';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// Resolved once in main(); the real git this machine will actually checkpoint with.
let EXE = '';

const trash: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-gitcmd-'));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** A throwaway git repo with a committer identity configured. */
function mkRepo(): string {
  const dir = mkTmpDir();
  execFileSync(EXE, ['init', '-q'], { cwd: dir });
  execFileSync(EXE, ['config', 'user.email', 't@lares.local'], { cwd: dir });
  execFileSync(EXE, ['config', 'user.name', 'Lares Test'], { cwd: dir });
  return dir;
}

/** runGit with the resolved exe + generous default bounds. */
function g(cwd: string, args: string[], extra: Partial<Parameters<typeof runGit>[2]> = {}) {
  return runGit(cwd, args, { gitExe: EXE, maxBytes: 8 << 20, timeoutMs: 10_000, ...extra });
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ── arg-array integrity ───────────────────────────────────────────────────────

test('arg array preserved — leading-dash / space / Unicode names, no shell splitting', async () => {
  const repo = mkRepo();
  const names = ['-dash.txt', 'with space.txt', 'ünïcödé-文件.txt'];
  for (const n of names) fs.writeFileSync(path.join(repo, n), 'x');

  // The leading-dash path would be parsed as an option without the `--` guard;
  // the space/Unicode names would be re-split by any shell. Neither happens here.
  await g(repo, ['add', '--', ...names]);
  const listed = await g(repo, ['ls-files', '-z']);
  const got = listed.stdout.split('\0').filter(Boolean).sort();
  assert.deepEqual(got, [...names].sort());
});

// ── timeout / deadline ────────────────────────────────────────────────────────

test('timeout kills a hung git and returns a typed timeout failure (not a hang)', async () => {
  const repo = mkRepo();
  // `hash-object --stdin` blocks until stdin EOF; we never send stdin, so it hangs
  // until our timer hard-kills it.
  const started = Date.now();
  await assert.rejects(
    () => runGit(repo, ['hash-object', '--stdin'], { gitExe: EXE, maxBytes: 1 << 20, timeoutMs: 400 }),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.kind, 'timeout');
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'should not hang');
});

test('deadline already past → kind:deadline without spawning', async () => {
  const repo = mkRepo();
  await assert.rejects(
    () => runGit(repo, ['status'], { gitExe: EXE, maxBytes: 1 << 20, deadlineAt: Date.now() - 1 }),
    (err: unknown) => err instanceof GitCommandError && err.kind === 'deadline',
  );
});

test('deadline expiry mid-op → kind:deadline (distinct from timeout)', async () => {
  const repo = mkRepo();
  await assert.rejects(
    () => runGit(repo, ['hash-object', '--stdin'], { gitExe: EXE, maxBytes: 1 << 20, deadlineAt: Date.now() + 400 }),
    (err: unknown) => err instanceof GitCommandError && err.kind === 'deadline',
  );
});

// ── lock classification ───────────────────────────────────────────────────────

test('index.lock contention → kind:lock', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
  // Pre-create the lock git itself would take, forcing a "File exists" failure.
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  await assert.rejects(
    () => g(repo, ['add', '--', 'a.txt']),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.kind, 'lock');
      return true;
    },
  );
});

// ── env sanitization ──────────────────────────────────────────────────────────

test('env sanitized — a poisoned GIT_DIR in the parent env does not leak', async () => {
  const repo = mkRepo();
  const poisoned = path.join(mkTmpDir(), 'poison.git');
  const prev = process.env.GIT_DIR;
  process.env.GIT_DIR = poisoned;
  try {
    // If GIT_DIR leaked, git would resolve the poisoned dir (or fail); instead it
    // must resolve THIS repo's own .git.
    const res = await g(repo, ['rev-parse', '--absolute-git-dir']);
    const resolved = res.stdout.trim().replace(/\//g, path.sep);
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(repo, '.git')));
    assert.notEqual(fs.realpathSync(resolved), poisoned);
  } finally {
    if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev;
  }
});

// ── injectable exe seam ───────────────────────────────────────────────────────

test('injected exe path honored — a bogus exe → kind:spawn', async () => {
  const repo = mkRepo();
  const bogus = path.join(repo, 'no-such-git.exe');
  await assert.rejects(
    () => runGit(repo, ['--version'], { gitExe: bogus, maxBytes: 1 << 20, timeoutMs: 5000 }),
    (err: unknown) => err instanceof GitCommandError && err.kind === 'spawn',
  );
});

test('injected exe path honored — the real resolved exe runs', async () => {
  const repo = mkRepo();
  const res = await g(repo, ['--version']);
  assert.match(res.stdout, /git version/);
});

// ── allowNonzero ──────────────────────────────────────────────────────────────

test('allowNonzero resolves a legitimate non-zero exit (unborn HEAD)', async () => {
  const repo = mkRepo();
  const res = await g(repo, ['rev-parse', '--verify', 'HEAD'], { allowNonzero: true });
  assert.notEqual(res.code, 0);
});

// ── stdin ─────────────────────────────────────────────────────────────────────

test('stdin is delivered — hash-object --stdin hashes piped bytes', async () => {
  const repo = mkRepo();
  const res = await g(repo, ['hash-object', '--stdin'], { stdin: 'hello\n' });
  // Well-known blob OID for "hello\n".
  assert.equal(res.stdout.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

// ── runGitBlobToFile ──────────────────────────────────────────────────────────

test('runGitBlobToFile streams a >64 MiB binary blob byte-exactly', async () => {
  const repo = mkRepo();
  const srcPath = path.join(mkTmpDir(), 'big.bin');

  // Generate ~65 MiB of binary content programmatically (never committed as a
  // fixture): a rolling byte pattern including 0x00/0xFF, hashed as we write.
  const CHUNK = 1 << 20; // 1 MiB
  const CHUNKS = 65; // > 64 MiB
  const expect = createHash('sha256');
  const fd = fs.openSync(srcPath, 'w');
  try {
    for (let c = 0; c < CHUNKS; c++) {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let i = 0; i < CHUNK; i++) buf[i] = (i + c * 7) & 0xff;
      fs.writeSync(fd, buf);
      expect.update(buf);
    }
  } finally {
    fs.closeSync(fd);
  }
  const expectHex = expect.digest('hex');
  const totalBytes = CHUNK * CHUNKS;

  const oid = execFileSync(EXE, ['hash-object', '-w', '--', srcPath], { cwd: repo }).toString().trim();

  const dest = path.join(mkTmpDir(), 'out.bin');
  const { bytesWritten } = await runGitBlobToFile(repo, oid, dest, { gitExe: EXE, maxBytes: 128 << 20 });

  assert.equal(bytesWritten, totalBytes);
  assert.equal(fs.statSync(dest).size, totalBytes);
  assert.equal(sha256File(dest), expectHex);
});

test('runGitBlobToFile rejects a tree OID (not-a-blob)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'f.txt'), 'content');
  await g(repo, ['add', '--', 'f.txt']);
  const treeOid = (await g(repo, ['write-tree'])).stdout.trim();

  const dest = path.join(mkTmpDir(), 'tree-out.bin');
  await assert.rejects(
    () => runGitBlobToFile(repo, treeOid, dest, { gitExe: EXE, maxBytes: 1 << 20 }),
    (err: unknown) => {
      assert.ok(err instanceof GitBlobError);
      assert.equal(err.reason, 'not-a-blob');
      return true;
    },
  );
  assert.equal(fs.existsSync(dest), false, 'no dest file written for a non-blob');
});

test('runGitBlobToFile rejects an over-cap blob without buffering (dest never opened)', async () => {
  const repo = mkRepo();
  const srcPath = path.join(mkTmpDir(), 'small.bin');
  fs.writeFileSync(srcPath, Buffer.alloc(4096, 0xab));
  const oid = execFileSync(EXE, ['hash-object', '-w', '--', srcPath], { cwd: repo }).toString().trim();

  const dest = path.join(mkTmpDir(), 'capped-out.bin');
  await assert.rejects(
    () => runGitBlobToFile(repo, oid, dest, { gitExe: EXE, maxBytes: 100 }),
    (err: unknown) => {
      assert.ok(err instanceof GitBlobError);
      assert.equal(err.reason, 'over-cap');
      return true;
    },
  );
  assert.equal(fs.existsSync(dest), false, 'over-cap must reject before opening the dest stream');
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved on this machine; WP-G1.1 tests need real git.');
    process.exit(1);
  }
  EXE = internal.execPath;

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
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
