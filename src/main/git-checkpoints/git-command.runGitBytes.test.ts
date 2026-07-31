// Save-card SC-WP-1P — bounded binary git command seam.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/git-command.runGitBytes.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitCommandError, runGitBytes } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-gitbytes-'));
  trash.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of trash.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function mkRepo(): string {
  const dir = mkTmpDir();
  execFileSync(EXE, ['init', '-q'], { cwd: dir });
  return dir;
}

function gb(
  cwd: string,
  args: string[],
  extra: Partial<Parameters<typeof runGitBytes>[2]> = {},
) {
  return runGitBytes(cwd, args, {
    gitExe: EXE,
    maxBytes: 8 << 20,
    timeoutMs: 10_000,
    ...extra,
  });
}

test('returns non-UTF-8 blob stdout byte-exactly', async () => {
  const repo = mkRepo();
  const expected = Buffer.from([0x00, 0x41, 0x80, 0xc0, 0xc1, 0xf5, 0xfe, 0xff, 0x0a]);
  const oid = execFileSync(EXE, ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    input: expected,
  }).toString('ascii').trim();

  const result = await gb(repo, ['cat-file', 'blob', oid]);
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual(result.stdout, expected);
  assert.equal(result.code, 0);
});

test('maxBytes overflow remains a bounded nonzero failure', async () => {
  const repo = mkRepo();
  const oid = execFileSync(EXE, ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    input: Buffer.alloc(4096, 0xab),
  }).toString('ascii').trim();

  await assert.rejects(
    () => gb(repo, ['cat-file', 'blob', oid], { maxBytes: 100 }),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.equal(err.kind, 'nonzero');
      assert.equal(err.code, null);
      assert.match(err.message, /output exceeded maxBytes/);
      return true;
    },
  );
});

test('timeout kills a command through the shared execution path', async () => {
  const repo = mkRepo();
  const started = Date.now();
  await assert.rejects(
    () => gb(repo, ['hash-object', '--stdin'], { timeoutMs: 300 }),
    (err: unknown) => err instanceof GitCommandError && err.kind === 'timeout',
  );
  assert.ok(Date.now() - started < 5000, 'timeout path must not hang');
});

test('index.lock errors retain lock classification', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'content');
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');

  await assert.rejects(
    () => gb(repo, ['add', '--', 'a.txt']),
    (err: unknown) => err instanceof GitCommandError && err.kind === 'lock',
  );
});

test('Git routing env is sanitized and an explicit index is injected afterward', async () => {
  const repo = mkRepo();
  const poisonDir = path.join(mkTmpDir(), 'poison.git');
  const poisonIndex = path.join(mkTmpDir(), 'poison.index');
  const explicitIndex = path.join(mkTmpDir(), 'explicit.index');
  const env = {
    ...process.env,
    GIT_DIR: poisonDir,
    GIT_INDEX_FILE: poisonIndex,
  };

  const gitDirResult = await gb(repo, ['rev-parse', '--absolute-git-dir'], { env });
  const gitDir = gitDirResult.stdout.toString('utf8').trim().replace(/\//g, path.sep);
  assert.equal(fs.realpathSync(gitDir), fs.realpathSync(path.join(repo, '.git')));

  const defaultIndexResult = await gb(repo, ['rev-parse', '--git-path', 'index'], { env });
  const defaultIndex = defaultIndexResult.stdout.toString('utf8').trim().replace(/\//g, path.sep);
  assert.equal(path.resolve(repo, defaultIndex), path.join(repo, '.git', 'index'));
  assert.notEqual(path.resolve(repo, defaultIndex), poisonIndex);

  const explicitResult = await gb(repo, ['rev-parse', '--git-path', 'index'], {
    env,
    indexFile: explicitIndex,
  });
  const resolvedExplicit = explicitResult.stdout.toString('utf8').trim().replace(/\//g, path.sep);
  assert.equal(path.resolve(repo, resolvedExplicit), explicitIndex);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  FAIL — no compatible git resolved; SC-WP-1P requires real git.');
    process.exit(1);
  }
  EXE = internal.execPath;

  let passed = 0;
  let failed = 0;
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
