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
import {
  evaluateCheckpointProtection,
  weakestProtectionRung,
  type CheckpointTreePresence,
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

test('a live ref + blob hit is insufficient when the mode-confirm read fails or differs', async () => {
  // The real batch probe (runGitBytes) finds protected.txt's blob in the live
  // checkpoint → a candidate. Only the injected Phase-2 mode-confirm reader varies.
  const exact = member('member', 'protected.txt', 'present', matchingBlobOid, '100644');
  const readers: CheckpointTreeReader[] = [
    // Read failure for the edge → null → never protection proof.
    async () => null,
    async () => { throw new Error('tree unavailable'); },
    // Tree records a DIFFERENT path only → the member's path is absent from the map.
    async (): Promise<Map<string, CheckpointTreePresence>> => new Map([
      [encodedPath('other.txt').pathBytesBase64, { rawBlobOid: matchingBlobOid, mode: '100644' }],
    ]),
  ];

  for (const reader of readers) {
    const result = await evaluateCheckpointProtection({
      repoRoot: repo,
      members: [exact],
      checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
      runGit,
      runGitBytes,
      readCheckpointTree: reader,
      gitExe,
    });
    assert.equal(result.members[0].protection, 'unprotected');
  }
});

test('a Git failure during the batched membership probe degrades to unprotected', async () => {
  const exact = member('member', 'protected.txt', 'present', matchingBlobOid, '100644');
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [exact],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes: unreachableBytes, // Phase-1 batch probe throws → no proof, no throw
    gitExe,
  });
  assert.equal(result.members[0].protection, 'unprotected');
});

test('Stage 1 evaluator never emits locally-committed or remote-reachable', async () => {
  const result = await evaluateCheckpointProtection({
    repoRoot: repo,
    members: [
      member('protected', 'protected.txt', 'present', matchingBlobOid, '100644'),
      member('unprotected', 'ghost.txt', 'present', matchingBlobOid, '100644'),
    ],
    checkpointEdges: [{ ref: CHECKPOINT_REF, oid: checkpointOid }],
    runGit,
    runGitBytes,
    gitExe,
  });

  assert.equal(result.members.find((m) => m.entryId === 'protected')!.protection, 'checkpoint-protected');
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
