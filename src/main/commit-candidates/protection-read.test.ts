// SC-WP-1F — exact checkpoint-protection evaluator.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/protection-read.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProtectionRung } from '../../shared/commit-candidates';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import type { LiveEdgeRunGit } from '../git-checkpoints/live-edge';
import {
  evaluateCheckpointProtection,
  weakestProtectionRung,
  type CheckpointTreeEntry,
  type CheckpointTreeReader,
  type ProtectionMember,
  type RunProtectionGitBytes,
} from './protection-read';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
let checkpointOid = '';
let deletionPresentOid = '';
let matchingBlobOid = '';
const CHECKPOINT_REF = 'refs/lares/checkpoints/protection/after';
const DELETION_PRESENT_REF = 'refs/lares/checkpoints/protection/before-deletion';

function git(args: string[]): string {
  return execFileSync(gitExe, args, { cwd: repo, encoding: 'utf8' }).trim();
}

function encodedPath(value: string): ProtectionMember['path'] {
  return {
    pathBytesBase64: Buffer.from(value, 'utf8').toString('base64'),
    displayPath: value,
    utf8Clean: true,
  };
}

function member(
  entryId: string,
  filePath: string,
  state: ProtectionMember['expectedWorktreeState'],
  blob: string | null,
  mode: string | null,
): ProtectionMember {
  return {
    entryId,
    path: encodedPath(filePath),
    expectedWorktreeState: state,
    rawWorktreeBlobOid: blob,
    worktreeMode: mode,
  };
}

const unreachableBytes: RunProtectionGitBytes = async () => {
  throw new Error('unexpected binary Git call');
};

test('real live checkpoint tree protects only the exact path/blob/mode tuple', async () => {
  const exact = member('exact', 'protected.txt', 'present', matchingBlobOid, '100644');
  const wrongBlob = member('wrong-blob', 'protected.txt', 'present', '0'.repeat(matchingBlobOid.length), '100644');
  const wrongMode = member('wrong-mode', 'protected.txt', 'present', matchingBlobOid, '100755');

  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact, wrongBlob, wrongMode],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });

  assert.deepEqual(result.members, [
    { entryId: 'exact', protection: 'checkpoint-protected' },
    { entryId: 'wrong-blob', protection: 'unprotected' },
    { entryId: 'wrong-mode', protection: 'unprotected' },
  ]);
  assert.equal(result.weakest, 'unprotected');
});

test('deletion is protected by recorded absence but not while the path remains in the tree', async () => {
  const deletion = member('deleted', 'deleted.txt', 'absent', null, null);

  const absentResult = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [deletion],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.deepEqual(absentResult, {
    members: [{ entryId: 'deleted', protection: 'checkpoint-protected' }],
    weakest: 'checkpoint-protected',
  });

  const presentResult = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [deletion],
    checkpointEdges: [{ ref: DELETION_PRESENT_REF, oid: deletionPresentOid }],
    runGit,
    runGitBytes,
    gitExe,
  });
  assert.equal(presentResult.members[0].protection, 'unprotected');
});

test('a live ref alone is insufficient when tree lookup fails or returns a different path', async () => {
  const exact = member('member', 'protected.txt', 'present', matchingBlobOid, '100644');
  const readers: CheckpointTreeReader[] = [
    async () => { throw new Error('tree unavailable'); },
    async (): Promise<CheckpointTreeEntry> => ({
      pathBytesBase64: encodedPath('other.txt').pathBytesBase64,
      expectedState: 'present',
      rawBlobOid: matchingBlobOid,
      mode: '100644',
    }),
  ];

  for (const reader of readers) {
    const result = await evaluateCheckpointProtection({
      repoRoot: repo,
      members: [exact],
      checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
      runGit,
      runGitBytes: unreachableBytes,
      readCheckpointTreeEntry: reader,
      gitExe,
    });
    assert.equal(result.members[0].protection, 'unprotected');
  }
});

test('Stage 1 evaluator never emits locally-committed or remote-reachable', async () => {
  const liveRunGit: LiveEdgeRunGit = async () => ({
    code: 0,
    stdout: 'a'.repeat(40),
    stderr: '',
  });
  const reader: CheckpointTreeReader = async ({ path: requestedPath }) => ({
    pathBytesBase64: requestedPath.pathBytesBase64,
    expectedState: 'present',
    rawBlobOid: 'b'.repeat(40),
    mode: '100644',
  });
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [
      member('protected', 'one.txt', 'present', 'b'.repeat(40), '100644'),
      member('unprotected', 'two.txt', 'present', 'c'.repeat(40), '100644'),
    ],
    checkpointEdges: [{ ref: 'refs/fake', oid: 'a'.repeat(40) }],
    runGit: liveRunGit,
    runGitBytes: unreachableBytes,
    readCheckpointTreeEntry: reader,
  });

  const emitted = new Set(result.members.map((item) => item.protection));
  assert.deepEqual([...emitted].sort(), ['checkpoint-protected', 'unprotected']);
  assert.equal(emitted.has('locally-committed' as ProtectionRung), false);
  assert.equal(emitted.has('remote-reachable' as ProtectionRung), false);
});

test('bundle weakest rung is the minimum by PROTECTION_RUNG_ORDER', () => {
  assert.equal(weakestProtectionRung([
    'remote-reachable',
    'locally-committed',
    'checkpoint-protected',
  ]), 'checkpoint-protected');
  assert.equal(weakestProtectionRung([
    'remote-reachable',
    'unprotected',
    'locally-committed',
  ]), 'unprotected');
  assert.throws(() => weakestProtectionRung([]), /empty bundle/);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  FAIL no compatible Git resolved; protection-read tests require real Git.');
    process.exit(1);
  }
  gitExe = internal.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-protection-read-'));

  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@lares.local']);
    git(['config', 'user.name', 'Lares Test']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'protected.txt'), 'checkpoint bytes\n');
    fs.writeFileSync(path.join(repo, 'deleted.txt'), 'present before deletion\n');
    git(['add', '--', 'protected.txt', 'deleted.txt']);
    git(['commit', '-q', '-m', 'before deletion']);
    deletionPresentOid = git(['rev-parse', 'HEAD']);
    git(['update-ref', DELETION_PRESENT_REF, deletionPresentOid]);
    fs.unlinkSync(path.join(repo, 'deleted.txt'));
    git(['add', '--', 'deleted.txt']);
    git(['commit', '-q', '-m', 'checkpoint after deletion']);
    checkpointOid = git(['rev-parse', 'HEAD']);
    matchingBlobOid = git(['rev-parse', 'HEAD:protected.txt']);
    git(['update-ref', CHECKPOINT_REF, checkpointOid]);

    let passed = 0;
    let failed = 0;
    for (const t of tests) {
      try {
        await t.run();
        console.log(`  ok  ${t.name}`);
        passed++;
      } catch (error) {
        console.error(`  FAIL ${t.name}`);
        console.error('       ', error instanceof Error ? error.stack || error.message : error);
        failed++;
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
})();
