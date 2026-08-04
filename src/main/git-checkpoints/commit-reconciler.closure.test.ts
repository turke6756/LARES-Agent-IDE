// Save-card SC-WP-4G — exact ledger persistence + whole-finalization closure.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/commit-reconciler.closure.test.js

import assert from 'node:assert/strict';

import type { CandidateMember, CommitOutcome } from '../../shared/commit-candidates';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type { FrozenManifestMember } from '../commit-candidates/finalization-service';
import type {
  CommitLedgerWrite,
  CommitPathLink,
  CommitRecord,
  PackageFinalization,
} from '../database';
import {
  reconcileCommittedCandidate,
  type CommitClosureStore,
  type CommitReconcilerRunGit,
  type CommitReconcilerRunGitBytes,
} from './commit-reconciler';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const COMMIT = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const BLOB_A = 'c'.repeat(40);
const BLOB_B = 'd'.repeat(40);
const RAW_A = 'e'.repeat(40);
const RAW_B = 'f'.repeat(40);
const PATH_A = Buffer.from('a.txt').toString('base64');
const PATH_B = Buffer.from('b.txt').toString('base64');

function frozen(pathBytesBase64: string, rawBlobOid: string, commitBlobOid: string): FrozenManifestMember {
  return {
    pathBytesBase64,
    expectedState: 'present',
    rawBlobOid,
    commitBlobOid,
    commitMode: '100644',
  };
}

function member(
  entryId: string,
  pathBytesBase64: string,
  rawWorktreeBlobOid: string,
  expectedCommitBlobOid: string,
  finalizationId = 'fin-1',
): CandidateMember {
  return {
    entryId,
    path: { pathBytesBase64, displayPath: Buffer.from(pathBytesBase64, 'base64').toString('utf8'), utf8Clean: true },
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid,
    expectedCommitBlobOid,
    expectedCommitMode: '100644',
    checkpointMode: '100644',
    coveringFinalizationIds: [finalizationId],
    packageVerification: 'verified-match',
    protection: 'checkpoint-protected',
  };
}

function finalization(manifest: FrozenManifestMember[]): PackageFinalization {
  return {
    id: 'fin-1',
    packageId: 'pkg-1',
    repositoryKey: 'repo-1',
    finalizationKind: 'plan-package',
    planId: 'plan-1',
    planItemId: 'wp-1',
    packageRevision: 1,
    finalizedAt: 10,
    finalizedBy: 'human-ipc',
    checkpointTurnId: 'turn-1',
    checkpointOid: PARENT,
    boundaryRef: 'refs/lares/finalizations/pkg-1/1',
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify(manifest),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: 'ws-1',
  };
}

function snapshot(selected: CandidateMember[], row: PackageFinalization): CandidateTokenSnapshot {
  return {
    token: { tokenId: 'token-1', candidateId: 'candidate-1', contractVersion: 1, issuedAt: 1, expiresAt: 2 },
    candidate: {
      candidateId: 'candidate-1',
      contractVersion: 1,
      repository: {
        repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1', bareRepo: false,
        workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
      },
      componentIds: ['component-1'],
      selectedUnattributedEntryIds: [],
      members: selected,
      finalizations: [{ finalizationId: row.id, packageId: row.packageId, packageRevision: 1, boundaryStatus: 'ready' }],
      eligibility: { eligible: true },
      token: null,
    },
    repositoryKey: 'repo-1',
    normalizedRequest: {
      selectedComponentIds: ['component-1'], selectedUnattributedEntryIds: [], finalizationIds: [row.id],
      acknowledgeTopologyDigest: 'topology-1', acknowledgeUnattributedEntryIds: [],
    },
    componentTopologyDigest: 'topology-1',
    pinnedHeadOid: PARENT,
    indexFingerprint: 'index-1',
    indexWriteTreeOid: null,
    finalizationManifests: [{ finalizationId: row.id, memberManifestJson: row.memberManifestJson }],
    associations: [{
      planId: 'plan-1', planItemId: 'wp-1', contributingTurnIds: ['turn-1'],
      memberEntryIds: selected.map((item) => item.entryId),
    }],
  };
}

class MemoryStore implements CommitClosureStore {
  records = new Map<string, CommitRecord>();
  writes: CommitLedgerWrite[] = [];
  finalizations = new Map<string, PackageFinalization>();
  priorLinks: CommitPathLink[] = [];
  closed: Array<{ id: string; releasedAt: number }> = [];

  getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null {
    return this.records.get(`${repositoryKey}:${commitOid}`) ?? null;
  }
  recordCommitLedger(write: CommitLedgerWrite): void {
    this.writes.push(write);
    this.records.set(`${write.record.repositoryKey}:${write.record.commitOid}`, write.record);
  }
  getPackageFinalization(id: string): PackageFinalization | null {
    return this.finalizations.get(id) ?? null;
  }
  listCommitPathLinks(repositoryKey: string, paths: readonly string[]): CommitPathLink[] {
    return this.priorLinks.filter((link) => link.repositoryKey === repositoryKey && paths.includes(link.pathBytesBase64));
  }
  markPackageFinalizationCommitted(id: string, releasedAt: number): void {
    const row = this.finalizations.get(id);
    if (!row) throw new Error(`missing finalization ${id}`);
    this.finalizations.set(id, { ...row, lifecycleStatus: 'committed', releasedAt });
    this.closed.push({ id, releasedAt });
  }
}

function treeBytes(selected: readonly CandidateMember[]): Buffer {
  return Buffer.concat(selected
    .filter((item) => item.expectedWorktreeState === 'present')
    .flatMap((item) => [
      Buffer.from(`${item.expectedCommitMode} blob ${item.expectedCommitBlobOid}\t`, 'ascii'),
      Buffer.from(item.path.pathBytesBase64, 'base64'),
      Buffer.from([0]),
    ]));
}

function gitSeams(
  selected: readonly CandidateMember[],
  over: { parent?: string; tree?: Buffer } = {},
): { runGit: CommitReconcilerRunGit; runGitBytes: CommitReconcilerRunGitBytes } {
  return {
    runGit: async (_cwd, args) => {
      if (args[0] === 'rev-list') {
        return { code: 0, stdout: `${COMMIT} ${over.parent ?? PARENT}\n`, stderr: '' };
      }
      if (args[0] === 'for-each-ref') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    },
    runGitBytes: async (_cwd, args) => {
      assert.equal(args[0], 'ls-tree');
      return { code: 0, stdout: over.tree ?? treeBytes(selected), stderr: '' };
    },
  };
}

const outcome: CommitOutcome = {
  status: 'committed', commitOid: COMMIT, attemptId: 'attempt-1', indexIntegrity: 'verified',
};

async function reconcile(
  selected: CandidateMember[],
  manifest: FrozenManifestMember[],
  configure?: (store: MemoryStore) => void,
  gitOverride?: { parent?: string; tree?: Buffer },
) {
  const row = finalization(manifest);
  const store = new MemoryStore();
  store.finalizations.set(row.id, row);
  configure?.(store);
  return {
    store,
    result: await reconcileCommittedCandidate({
      repoRoot: '/repo', outcome, snapshot: snapshot(selected, row), store,
      ...gitSeams(selected, gitOverride), now: () => 1_000,
    }),
  };
}

test('§14 partial no-release: one selected member cannot close the entire manifest', async () => {
  const a = member('entry-a', PATH_A, RAW_A, BLOB_A);
  const { result, store } = await reconcile(
    [a],
    [frozen(PATH_A, RAW_A, BLOB_A), frozen(PATH_B, RAW_B, BLOB_B)],
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalizations[0].closed, false);
  assert.deepEqual(result.finalizations[0].members.map((item) => item.disposition?.state ?? null), [
    'selected-in-candidate', null,
  ]);
  assert.equal(store.closed.length, 0);
  assert.equal(store.finalizations.get('fin-1')?.lifecycleStatus, 'active');
  assert.equal(store.finalizations.get('fin-1')?.releasedAt, null);
  assert.equal(store.writes.length, 1, 'the landed exact member is still ledgered');
  assert.equal(store.writes[0].pathLinks?.[0].commitBlobOid, BLOB_A);
  assert.equal(store.writes[0].turnLinks?.[0].relation, 'candidate_member');
});

test('§14 all-members-close: every newly selected exact member closes and releases', async () => {
  const selected = [
    member('entry-a', PATH_A, RAW_A, BLOB_A),
    member('entry-b', PATH_B, RAW_B, BLOB_B),
  ];
  const { result, store } = await reconcile(
    selected,
    [frozen(PATH_A, RAW_A, BLOB_A), frozen(PATH_B, RAW_B, BLOB_B)],
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalizations[0].closed, true);
  assert.deepEqual(result.finalizations[0].members.map((item) => item.disposition?.state), [
    'selected-in-candidate', 'selected-in-candidate',
  ]);
  assert.deepEqual(store.closed, [{ id: 'fin-1', releasedAt: 1_000 }]);
  assert.equal(store.finalizations.get('fin-1')?.lifecycleStatus, 'committed');
  assert.equal(store.finalizations.get('fin-1')?.releasedAt, 1_000);
  assert.deepEqual(store.writes[0].pathLinks?.map((link) => link.pathBytesBase64), [PATH_A, PATH_B]);
});

test('§14 prior exact commit closes the finalization when the remaining member lands', async () => {
  const b = member('entry-b', PATH_B, RAW_B, BLOB_B);
  const { result, store } = await reconcile(
    [b],
    [frozen(PATH_A, RAW_A, BLOB_A), frozen(PATH_B, RAW_B, BLOB_B)],
    (memory) => memory.priorLinks.push({
      repositoryKey: 'repo-1', commitOid: '9'.repeat(40), pathBytesBase64: PATH_A,
      expectedState: 'present', rawBlobOidAtCommit: '0'.repeat(40),
      commitBlobOid: BLOB_A, commitMode: '100644', contributingTurnIds: ['old-turn'], overlapCount: 1,
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalizations[0].closed, true);
  assert.deepEqual(result.finalizations[0].members.map((item) => item.disposition), [
    { state: 'already-locally-committed', commitOid: '9'.repeat(40) },
    { state: 'selected-in-candidate', entryId: 'entry-b' },
  ]);
  assert.equal(store.closed.length, 1);
});

test('raw match alone never closes without matching clean-filtered blob and mode', async () => {
  const b = member('entry-b', PATH_B, RAW_B, BLOB_B);
  const { result, store } = await reconcile(
    [b],
    [frozen(PATH_A, RAW_A, BLOB_A), frozen(PATH_B, RAW_B, BLOB_B)],
    (memory) => memory.priorLinks.push({
      repositoryKey: 'repo-1', commitOid: '8'.repeat(40), pathBytesBase64: PATH_A,
      expectedState: 'present', rawBlobOidAtCommit: RAW_A,
      commitBlobOid: '7'.repeat(40), commitMode: '100644', contributingTurnIds: [], overlapCount: 0,
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalizations[0].closed, false);
  assert.equal(result.finalizations[0].members[0].disposition, null);
  assert.equal(store.closed.length, 0);
});

test('parent verification failure returns an explicit error and writes no ledger', async () => {
  const a = member('entry-a', PATH_A, RAW_A, BLOB_A);
  const { result, store } = await reconcile(
    [a], [frozen(PATH_A, RAW_A, BLOB_A)], undefined, { parent: '6'.repeat(40) },
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'parent-mismatch', message: 'Marked commit parent does not match the pinned HEAD.' },
  });
  assert.equal(store.writes.length, 0);
});

test('tree verification failure returns an explicit error and writes no ledger', async () => {
  const a = member('entry-a', PATH_A, RAW_A, BLOB_A);
  const wrongTree = treeBytes([{ ...a, expectedCommitBlobOid: '5'.repeat(40) }]);
  const { result, store } = await reconcile(
    [a], [frozen(PATH_A, RAW_A, BLOB_A)], undefined, { tree: wrongTree },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'tree-mismatch');
  assert.equal(store.writes.length, 0);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
