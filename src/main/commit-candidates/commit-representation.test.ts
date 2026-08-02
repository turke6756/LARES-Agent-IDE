// SC-WP-2J — read-only current commit representation.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/commit-representation.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseStageEntries,
  readCurrentCommitRepresentation,
  type CommitRepresentationEntry,
} from './commit-representation';
import { encodeGitPath } from './dirty-inventory';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let EXE = '';
const trash: string[] = [];

function tmp(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(value);
  return value;
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync(EXE, args, { cwd, input, encoding: 'utf8' });
}

function repo(): string {
  const root = tmp('lares-commit-repr-test-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@lares.invalid']);
  git(root, ['config', 'user.name', 'Lares Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

function commit(root: string, message = 'fixture'): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function rawOid(root: string, relativePath: string): string {
  return git(root, ['hash-object', '--no-filters', '--', relativePath]).trim();
}

function entry(
  relativePath: string,
  expectedState: 'present' | 'absent',
  rawBlobOid: string | null,
  commitPathspecs = [relativePath],
): CommitRepresentationEntry {
  return {
    path: encodeGitPath(Buffer.from(relativePath)),
    commitPathspecs: commitPathspecs.map((value) => encodeGitPath(Buffer.from(value))),
    expectedWorktreeState: expectedState,
    rawWorktreeBlobOid: rawBlobOid,
  };
}

async function realIndex(root: string): Promise<Buffer> {
  return (await runGitBytes(root, ['ls-files', '--stage', '-z'], {
    gitExe: EXE,
    maxBytes: 64 << 20,
    timeoutMs: 10_000,
  })).stdout;
}

async function readAndProve(
  root: string,
  pinnedHeadOid: string | null,
  selected: CommitRepresentationEntry,
  observeTempIndex?: (stdout: Buffer) => void,
): ReturnType<typeof readCurrentCommitRepresentation> {
  // The acceptance proof deliberately lives outside the helper too: these are
  // COMPLETE raw binary real-index snapshots, not parsed/canonical fingerprints.
  const before = await realIndex(root);
  const isolatedTmp = tmp('lares-commit-repr-files-');
  const observedRunGit = observeTempIndex
    ? async (cwd: string, args: string[], options: Parameters<typeof runGit>[2]) => {
        const result = await runGit(cwd, args, { ...options, gitExe: EXE });
        if (args[0] === 'add') {
          const staged = await runGitBytes(cwd, ['ls-files', '--stage', '-z'], {
            ...options,
            gitExe: EXE,
          });
          observeTempIndex(staged.stdout);
        }
        return result;
      }
    : undefined;
  const result = await readCurrentCommitRepresentation({
    repoRoot: root,
    pinnedHeadOid,
    entry: selected,
    gitExe: EXE,
    tmpDir: isolatedTmp,
    runGit: observedRunGit,
  });
  const after = await realIndex(root);
  assert.ok(before.equals(after), 'complete raw real-index snapshots must be byte-for-byte identical');
  assert.deepEqual(fs.readdirSync(isolatedTmp), [], 'temp index and pathspec files cleaned');
  return result;
}

test('modify returns the HEAD+worktree clean representation and preserves unrelated staging', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'before\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'base\n');
  const head = commit(root);
  fs.writeFileSync(path.join(root, 'selected.txt'), 'after\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged foreign content\n');
  git(root, ['add', '--', 'unrelated.txt']);

  const raw = rawOid(root, 'selected.txt');
  const result = await readAndProve(root, head, entry('selected.txt', 'present', raw));
  assert.deepEqual(result, {
    expectedState: 'present',
    rawBlobOid: raw,
    commitBlobOid: raw,
    commitMode: '100644',
  });
});

test('add works against an unborn empty seed', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'new.txt'), 'new file\n');
  const raw = rawOid(root, 'new.txt');
  const result = await readAndProve(root, null, entry('new.txt', 'present', raw));
  assert.equal(result.expectedState, 'present');
  assert.equal(result.rawBlobOid, raw);
  assert.equal(result.commitBlobOid, raw);
  assert.equal(result.commitMode, '100644');
});

test('delete returns an absent representation', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'gone.txt'), 'delete me\n');
  const head = commit(root);
  fs.unlinkSync(path.join(root, 'gone.txt'));

  const result = await readAndProve(root, head, entry('gone.txt', 'absent', null));
  assert.deepEqual(result, {
    expectedState: 'absent',
    rawBlobOid: null,
    commitBlobOid: null,
    commitMode: null,
  });
});

test('rename applies both commitPathspecs: old absent and new clean entry present', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'old.txt'), 'renamed bytes\n');
  const head = commit(root);
  git(root, ['mv', 'old.txt', 'new.txt']);

  const raw = rawOid(root, 'new.txt');
  let modeledIndex: Buffer | null = null;
  const result = await readAndProve(
    root,
    head,
    entry('new.txt', 'present', raw, ['new.txt', 'old.txt']),
    (stdout) => { modeledIndex = stdout; },
  );
  assert.equal(result.commitBlobOid, raw);
  assert.equal(result.commitMode, '100644');

  assert.ok(modeledIndex, 'temp index observed immediately after git add');
  const modeledPaths = parseStageEntries(modeledIndex!).map((value) => value.pathBytesBase64);
  assert.ok(modeledPaths.includes(Buffer.from('new.txt').toString('base64')), 'new path added');
  assert.ok(!modeledPaths.includes(Buffer.from('old.txt').toString('base64')), 'old path deleted');
});

test('clean-filter divergence surfaces distinct raw and commit blob OIDs', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt text eol=lf\n');
  fs.writeFileSync(path.join(root, 'filtered.txt'), 'base\n');
  const head = commit(root);
  fs.writeFileSync(path.join(root, 'filtered.txt'), Buffer.from('line one\r\nline two\r\n'));

  const raw = rawOid(root, 'filtered.txt');
  const clean = git(root, ['hash-object', '--path=filtered.txt', '--', 'filtered.txt']).trim();
  const result = await readAndProve(root, head, entry('filtered.txt', 'present', raw));
  assert.equal(result.rawBlobOid, raw);
  assert.equal(result.commitBlobOid, clean);
  assert.notEqual(result.rawBlobOid, result.commitBlobOid, 'clean filter must materially diverge');
});

test('binary stage parser keys paths by authoritative bytes', () => {
  const rawPath = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const oid = 'a'.repeat(40);
  const parsed = parseStageEntries(Buffer.concat([
    Buffer.from(`100755 ${oid} 0\t`, 'ascii'),
    rawPath,
    Buffer.from([0]),
  ]));
  assert.deepEqual(parsed, [{
    mode: '100755',
    oid,
    stage: '0',
    pathBytesBase64: rawPath.toString('base64'),
  }]);
});

test('arbitrary path bytes are written to the NUL file and never placed in argv', async () => {
  const rawPath = Buffer.from([0x66, 0x6f, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  const encoded = encodeGitPath(rawPath);
  const oid = 'b'.repeat(40);
  let observedPathspec: Buffer | null = null;
  const argsSeen: string[][] = [];
  const fakeText = async (_cwd: string, args: string[], _options: Parameters<typeof runGit>[2]) => {
    argsSeen.push(args);
    const pathspecArg = args.find((arg) => arg.startsWith('--pathspec-from-file='));
    if (pathspecArg) observedPathspec = fs.readFileSync(pathspecArg.slice('--pathspec-from-file='.length));
    return { code: 0, stdout: '', stderr: '' };
  };
  let binaryReads = 0;
  const fakeBytes = async (_cwd: string, args: string[], options: Parameters<typeof runGitBytes>[2]) => {
    argsSeen.push(args);
    binaryReads++;
    if (options.indexFile) {
      return {
        code: 0,
        stdout: Buffer.concat([Buffer.from(`100644 ${oid} 0\t`, 'ascii'), rawPath, Buffer.from([0])]),
        stderr: '',
      };
    }
    return { code: 0, stdout: Buffer.from('real-index\0', 'ascii'), stderr: '' };
  };

  const result = await readCurrentCommitRepresentation({
    repoRoot: 'C:/synthetic-repo',
    pinnedHeadOid: 'c'.repeat(40),
    entry: {
      path: encoded,
      commitPathspecs: [encoded],
      expectedWorktreeState: 'present',
      rawWorktreeBlobOid: 'd'.repeat(40),
    },
    tmpDir: tmp('lares-commit-repr-byte-safe-'),
    runGit: fakeText,
    runGitBytes: fakeBytes,
  });
  assert.equal(binaryReads, 3, 'real-index before + temp index + real-index after');
  assert.deepEqual(observedPathspec, Buffer.concat([rawPath, Buffer.from([0])]));
  assert.ok(argsSeen.flat().every((arg) => !arg.includes('\ufffd')), 'lossy path decode never reaches argv');
  assert.equal(result.commitBlobOid, oid);
});

test('temp index and pathspec files are cleaned when git add fails', async () => {
  const tempParent = tmp('lares-commit-repr-failure-cleanup-');
  const selected = entry('failure.txt', 'present', 'e'.repeat(40));
  const fakeText = async (_cwd: string, args: string[], _options: Parameters<typeof runGit>[2]) => {
    if (args[0] === 'add') throw new Error('injected add failure');
    return { code: 0, stdout: '', stderr: '' };
  };
  const fakeBytes = async () => ({ code: 0, stdout: Buffer.from('unchanged'), stderr: '' });
  await assert.rejects(
    readCurrentCommitRepresentation({
      repoRoot: 'C:/synthetic-repo',
      pinnedHeadOid: 'f'.repeat(40),
      entry: selected,
      tmpDir: tempParent,
      runGit: fakeText,
      runGitBytes: fakeBytes,
    }),
    /injected add failure/,
  );
  assert.deepEqual(fs.readdirSync(tempParent), [], 'failure cleanup leaves no temp artifacts');
});

async function main(): Promise<void> {
  const resolved = await resolveInternalGit();
  assert.ok(resolved, 'a compatible Git executable is required');
  EXE = resolved.execPath;
  let failed = 0;
  try {
    for (const current of tests) {
      try {
        await current.run();
        console.log(`ok - ${current.name}`);
      } catch (error) {
        failed++;
        console.error(`not ok - ${current.name}`);
        console.error(error);
      }
    }
  } finally {
    for (const value of trash.splice(0)) {
      try { fs.rmSync(value, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  if (failed > 0) process.exitCode = 1;
}

void main();
