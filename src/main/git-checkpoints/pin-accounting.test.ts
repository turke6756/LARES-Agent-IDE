// SC-WP-2K — batched logical pin-byte accounting.

import assert from 'node:assert/strict';

import type { GitRunResult } from './git-command';
import type { RunGitLike } from './checkpoint-service';
import { accountAndSelectPins, type PinAccountingCandidate } from './pin-accounting';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const NOW = 20_000;

function edge(
  turnId: string,
  edgeName: 'before' | 'after',
  entries: Array<[string, string | null]>,
): PinAccountingCandidate {
  return {
    turnId,
    edge: edgeName,
    normalPruneEligibleAt: 10_000,
    dirtyEntries: entries.map(([entryId, rawWorktreeBlobOid]) => ({ entryId, rawWorktreeBlobOid })),
  };
}

function fakeGit(
  sizes: Readonly<Record<string, number>>,
  reachable: readonly string[] = [],
): { runGit: RunGitLike; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGitLike = async (_cwd, args, options): Promise<GitRunResult> => {
    calls.push(args);
    if (args[0] === 'rev-list') {
      return { code: 0, stdout: reachable.join('\n') + (reachable.length ? '\n' : ''), stderr: '' };
    }
    if (args[0] === 'cat-file') {
      const queries = (options.stdin ?? '').toString().trim().split('\n').filter(Boolean);
      return {
        code: 0,
        stdout: queries.map((oid) => sizes[oid] === undefined
          ? `${oid} missing`
          : `${oid} blob ${sizes[oid]}`).join('\n') + '\n',
        stderr: '',
      };
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  return { runGit, calls };
}

test('multi-path edge charges one shared blob OID once', async () => {
  const git = fakeGit({ [A]: 40 });
  const result = await accountAndSelectPins({
    repoRoot: '.', candidates: [edge('turn', 'after', [['path-a', A], ['path-b', A]])],
    reachableRoots: ['HEAD'], now: NOW, runGit: git.runGit, quotaBytes: 100,
  });
  assert.equal(result.retainedEdges[0].estimatedBytes, 40);
  assert.deepEqual(result.retainedEdges[0].dirtyEntryIds, ['path-a', 'path-b']);
});

test('shared OIDs are deduped across the retained set without hiding later unique bytes', async () => {
  const git = fakeGit({ [A]: 40, [B]: 30, [C]: 20 });
  const result = await accountAndSelectPins({
    repoRoot: '.',
    candidates: [
      edge('a', 'after', [['a-shared', A], ['a-only', B]]),
      edge('b', 'after', [['b-shared', A], ['b-only', C]]),
    ],
    reachableRoots: ['HEAD'], now: NOW, runGit: git.runGit, quotaBytes: 100,
  });
  assert.deepEqual(result.retainedEdges.map((candidate) => candidate.estimatedBytes), [70, 20]);
  assert.equal(result.retainedEdges.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0), 90);
  assert.equal(git.calls.filter((args) => args[0] === 'cat-file').length, 1, 'all sizes use one batch-check');
});

test('a rejected edge does not make its shared OID free for a later retained edge', async () => {
  const git = fakeGit({ [A]: 60, [B]: 60 });
  const result = await accountAndSelectPins({
    repoRoot: '.',
    candidates: [edge('a', 'after', [['a', A], ['b', B]]), edge('b', 'after', [['shared', A]])],
    reachableRoots: ['HEAD'], now: NOW, runGit: git.runGit, quotaBytes: 100,
  });
  assert.deepEqual(result.releasedEdges.map((candidate) => candidate.turnId), ['a']);
  assert.deepEqual(result.retainedEdges.map((candidate) => [candidate.turnId, candidate.estimatedBytes]), [['b', 60]]);
});

test('HEAD/boundary reachable OIDs cost zero and malformed metadata over-accounts', async () => {
  const git = fakeGit({ [A]: 80 }, [A]);
  const result = await accountAndSelectPins({
    repoRoot: '.',
    candidates: [edge('reachable', 'after', [['head', A]]), edge('uncertain', 'after', [['missing', null]])],
    reachableRoots: ['HEAD', 'refs/lares/finalizations/f'], now: NOW,
    runGit: git.runGit, quotaBytes: 100,
  });
  assert.deepEqual(result.retainedEdges.map((candidate) => [candidate.turnId, candidate.estimatedBytes]), [['reachable', 0]]);
  assert.equal(result.releasedEdges[0].estimatedBytes, 101);
});

(async () => {
  let failures = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`ok - ${current.name}`);
    } catch (error) {
      failures++;
      console.error(`not ok - ${current.name}`);
      console.error(error);
    }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} pin-accounting tests passed`);
})();
