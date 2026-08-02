// Save-card SC-WP-2G — exact Lares commit ledger + conservative external HEAD.

import assert from 'node:assert/strict';

import type { CommitLedgerWrite, CommitRecord } from '../database';
import {
  countConfiguredRemoteRefsContainingCommit,
  reconcileCommitHead,
  recordLaresCommit,
  type CommitLedgerStore,
  type CommitReconcilerRunGit,
} from './commit-reconciler';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const COMMIT = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

class MemoryStore implements CommitLedgerStore {
  records = new Map<string, CommitRecord>();
  writes: CommitLedgerWrite[] = [];
  getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null {
    return this.records.get(`${repositoryKey}:${commitOid}`) ?? null;
  }
  recordCommitLedger(write: CommitLedgerWrite): void {
    this.writes.push(write);
    this.records.set(`${write.record.repositoryKey}:${write.record.commitOid}`, write.record);
  }
}

function fakeGit(remoteRefs: string[] = []): CommitReconcilerRunGit {
  return async (_cwd, args) => {
    if (args[0] === 'for-each-ref') {
      return { code: 0, stdout: `${remoteRefs.join('\n')}${remoteRefs.length ? '\n' : ''}`, stderr: '' };
    }
    if (args[0] === 'rev-list') {
      return { code: 0, stdout: `${COMMIT} ${PARENT}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${COMMIT}\n`, stderr: '' };
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
}

test('records exact Lares turn/path links and a cached pushed-remote hint', async () => {
  const store = new MemoryStore();
  const record = await recordLaresCommit({
    repositoryKey: 'repo', repoRoot: '/repo', commitOid: COMMIT, parentOid: PARENT,
    runGit: fakeGit(['refs/remotes/origin/main', 'refs/remotes/upstream/main']),
    store, now: () => 123,
    turnLinks: [{
      turnId: 'turn-1', planId: 'plan-1', planItemId: null,
      relation: 'candidate_member', captureQuality: 'hook',
    }],
    pathLinks: [{
      pathBytesBase64: Buffer.from('file.txt').toString('base64'),
      expectedState: 'present', rawBlobOidAtCommit: 'c'.repeat(40),
      commitBlobOid: 'd'.repeat(40), commitMode: '100644',
      contributingTurnIds: ['turn-1'], overlapCount: 1,
    }],
  });
  assert.equal(record.source, 'lares');
  assert.equal(record.pushedRemoteCount, 2);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].turnLinks?.[0].relation, 'candidate_member');
  assert.equal(store.writes[0].pathLinks?.[0].commitBlobOid, 'd'.repeat(40));
});

test('rejects non-exact Lares path rows and metadata-only Lares turn rows', async () => {
  const common = {
    repositoryKey: 'repo', repoRoot: '/repo', commitOid: COMMIT, parentOid: PARENT,
    runGit: fakeGit(), store: new MemoryStore(), pathLinks: [],
  };
  await assert.rejects(recordLaresCommit({
    ...common,
    turnLinks: [{ turnId: 'turn', planId: null, planItemId: null, relation: 'metadata_only', captureQuality: null }],
  }), /metadata_only/);
  await assert.rejects(recordLaresCommit({
    ...common,
    turnLinks: [],
    pathLinks: [{
      pathBytesBase64: 'Zg==', expectedState: 'present', rawBlobOidAtCommit: null,
      commitBlobOid: null, commitMode: null, contributingTurnIds: [], overlapCount: 0,
    }],
  }), /state must agree/);
});

test('external HEAD movement records metadata only and never path evidence', async () => {
  const store = new MemoryStore();
  const result = await reconcileCommitHead({
    repositoryKey: 'repo', repoRoot: '/repo', previousHeadOid: PARENT,
    currentHeadOid: COMMIT, runGit: fakeGit(), store, now: () => 456,
    inferredTurns: [{ turnId: 'overlapping-turn', planId: 'plan', captureQuality: 'late' }],
  });
  assert.equal(result.moved, true);
  assert.equal(result.record?.source, 'external');
  assert.equal(store.writes[0].turnLinks?.[0].relation, 'metadata_only');
  assert.deepEqual(store.writes[0].pathLinks, []);
});

test('unchanged HEAD is a no-op and remote counting stays one batched ref query', async () => {
  const commands: string[][] = [];
  const runGit: CommitReconcilerRunGit = async (cwd, args, options) => {
    commands.push(args);
    return fakeGit(['refs/remotes/origin/main'])(cwd, args, options);
  };
  const count = await countConfiguredRemoteRefsContainingCommit(COMMIT, {
    repoRoot: '/repo', runGit,
  });
  assert.equal(count, 1);
  assert.equal(commands.length, 1);
  const store = new MemoryStore();
  const unchanged = await reconcileCommitHead({
    repositoryKey: 'repo', repoRoot: '/repo', previousHeadOid: COMMIT,
    currentHeadOid: COMMIT, runGit, store,
  });
  assert.deepEqual(unchanged, { moved: false, currentHeadOid: COMMIT, record: null });
  assert.equal(store.writes.length, 0);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed++;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
