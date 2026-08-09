// Save-card SC-WP-4E — coordinator IPC flag + 4D → 4G response gating.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/commit-coordinator-ipc.test.js

import assert from 'node:assert/strict';

import { COMMIT_COORDINATOR_CHANNEL } from '../../shared/types';
import type { CandidateTokenSnapshot } from './candidate-service';
import {
  consumeCommitCoordinatorForSweep,
  registerCommitCoordinatorIpc,
  type CommitCoordinatorRoutes,
} from './commit-coordinator-ipc';
import type { IpcLike } from './save-card-ipc';
import type { ReconcileCommittedCandidateResult } from '../git-checkpoints/commit-reconciler';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

type Handler = (event: unknown, ...args: unknown[]) => unknown;
class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

const COMMIT_OID = 'c'.repeat(40);
const PARENT_OID = 'a'.repeat(40);

function snapshotFixture(candidateId = 'candidate-1', tokenId = 'token-1'): CandidateTokenSnapshot {
  const pathBytesBase64 = Buffer.from('file.txt').toString('base64');
  const token = {
    tokenId, candidateId, contractVersion: 2, issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  return {
    token,
    candidate: {
      candidateId,
      contractVersion: 2,
      repository: {
        repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1',
        bareRepo: false, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
      },
      componentIds: ['component-1'],
      saveIntentIds: ['intent-1'],
      selectedNamedSaveSetIds: [],
      attributionResolutions: [],
      selectedUnattributedEntryIds: [],
      members: [{
        entryId: 'entry-1',
        path: { pathBytesBase64, displayPath: 'file.txt', utf8Clean: true },
        expectedWorktreeState: 'present',
        rawWorktreeBlobOid: 'd'.repeat(40),
        expectedCommitBlobOid: 'b'.repeat(40),
        expectedCommitMode: '100644',
        checkpointMode: '100644',
        coveringFinalizationIds: [],
        packageVerification: 'verified-match',
        protection: 'checkpoint-protected',
      }],
      finalizations: [],
      eligibility: { eligible: true },
      token,
    },
    repositoryKey: 'repo-1',
    normalizedRequest: {
      selectedIntentIds: ['intent-1'],
      selectedNamedSaveSetIds: [],
      resolutionIds: [],
      finalizationIds: [],
    },
    componentTopologyDigest: 'topology-1',
    pinnedHeadOid: PARENT_OID,
    indexFingerprint: 'index-1',
    indexWriteTreeOid: null,
    finalizationManifests: [],
    associations: [{
      planId: null,
      planItemId: null,
      contributingTurnIds: ['turn-1'],
      memberEntryIds: ['entry-1'],
    }],
  };
}

function committedResult() {
  return {
    kind: 'outcome' as const,
    outcome: {
      status: 'committed' as const,
      commitOid: COMMIT_OID,
      attemptId: 'attempt-1',
      indexIntegrity: 'verified' as const,
    },
  };
}

function successReconciliation(): ReconcileCommittedCandidateResult {
  return {
    ok: true,
    record: {
      repositoryKey: 'repo-1',
      commitOid: COMMIT_OID,
      parentOid: PARENT_OID,
      observedAt: 10,
      source: 'lares',
      pushedRemoteCount: 0,
      lastReconciledAt: 10,
    },
    finalizations: [{
      finalizationId: 'finalization-1',
      closed: true,
      lifecycleStatus: 'committed',
      members: [],
    }],
  };
}

function routesFixture(overrides: Partial<CommitCoordinatorRoutes> = {}): CommitCoordinatorRoutes {
  const snapshot = snapshotFixture();
  return {
    coordinator: { commit: async () => committedResult() },
    resolveCandidateToken: () => snapshot,
    locateRepository: () => ({ repoRoot: 'C:\\repo' }),
    reconcileCommitted: async () => successReconciliation(),
    ...overrides,
  };
}

test('registers a lens-neutral channel rather than a Save-only namespace', () => {
  const ipc = new FakeIpc();
  registerCommitCoordinatorIpc(ipc, () => routesFixture(), () => true);
  assert.equal(COMMIT_COORDINATOR_CHANNEL, 'commit-coordinator:consume');
  assert.deepEqual([...ipc.handlers.keys()], [COMMIT_COORDINATOR_CHANNEL]);
  assert.equal(COMMIT_COORDINATOR_CHANNEL.startsWith('savecard:'), false);
});

test('main-process flag rejects direct IPC before route or token access', async () => {
  const ipc = new FakeIpc();
  let routeReads = 0;
  registerCommitCoordinatorIpc(ipc, () => {
    routeReads++;
    return routesFixture();
  }, () => false);

  await assert.rejects(
    () => ipc.invoke(COMMIT_COORDINATOR_CHANNEL, {
      candidateId: 'candidate-1', tokenId: 'token-1', message: 'Save it',
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes('disabled')
      && (error as Error & { code?: string }).code === 'commit-coordinator-disabled',
  );
  assert.equal(routeReads, 0, 'disabled invocation must not reach injected production routes');
});

test('the injected flag seam alone makes an injected coordinator route reachable', async () => {
  const ipc = new FakeIpc();
  let enabled = false;
  let coordinatorCalls = 0;
  registerCommitCoordinatorIpc(ipc, () => routesFixture({
    coordinator: {
      commit: async () => {
        coordinatorCalls++;
        return { kind: 'outcome', outcome: {
          status: 'aborted-stale', reason: 'fresh route reached', attemptId: 'attempt-flag',
        } };
      },
    },
  }), () => enabled);
  const request = { candidateId: 'candidate-1', tokenId: 'token-1', message: 'Save it' };

  await assert.rejects(() => ipc.invoke(COMMIT_COORDINATOR_CHANNEL, request), /disabled/i);
  assert.equal(coordinatorCalls, 0);
  enabled = true;
  const response = await ipc.invoke(COMMIT_COORDINATOR_CHANNEL, request);
  assert.deepEqual(response, {
    kind: 'outcome',
    outcome: { status: 'aborted-stale', reason: 'fresh route reached', attemptId: 'attempt-flag' },
    refusal: {
      stage: 'commit', code: 'coordinator-stale',
      message: 'Commit stage refused because coordinator state is stale: fresh route reached',
    },
  });
  assert.equal(coordinatorCalls, 1);
});

test('candidateId must bind the token before 4D can consume it', async () => {
  const ipc = new FakeIpc();
  let coordinatorCalls = 0;
  registerCommitCoordinatorIpc(ipc, () => routesFixture({
    coordinator: { commit: async () => { coordinatorCalls++; return committedResult(); } },
  }), () => true);

  const response = await ipc.invoke(COMMIT_COORDINATOR_CHANNEL, {
    candidateId: 'different-candidate', tokenId: 'token-1', message: 'Save it',
  });
  assert.deepEqual(response, {
    kind: 'token-unresolved',
    refusal: {
      stage: 'token-consume', code: 'token-unresolved-or-expired',
      message: 'Token-consume stage refused because the candidate token is unresolved or expired.',
    },
  });
  assert.equal(coordinatorCalls, 0);
});

test('funnel telemetry contains stage and stable code only', async () => {
  const ipc = new FakeIpc();
  const telemetry: Array<{ stage: string; code: string }> = [];
  registerCommitCoordinatorIpc(
    ipc,
    () => routesFixture(),
    () => true,
    (event) => telemetry.push(event),
  );
  await ipc.invoke(COMMIT_COORDINATOR_CHANNEL, {
    candidateId: 'candidate-1', tokenId: 'secret-token', message: 'secret commit message',
  });
  assert.deepEqual(telemetry, [{ stage: 'reconciliation', code: 'save-verified' }]);
  assert.deepEqual(Object.keys(telemetry[0]).sort(), ['code', 'stage']);
  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('secret commit message'), false);
  assert.equal(serialized.includes('C:\\repo'), false);
});

test('a v2 coordinator outcome closes as saved with intent finalizations', async () => {
  const ipc = new FakeIpc();
  const events: string[] = [];
  registerCommitCoordinatorIpc(ipc, () => routesFixture({
    coordinator: {
      commit: async (request) => {
        events.push(`4D:${request.tokenId}`);
        return committedResult();
      },
    },
  }), () => true);

  const response = await ipc.invoke(COMMIT_COORDINATOR_CHANNEL, {
    candidateId: 'candidate-1', tokenId: 'token-1', message: 'Save it',
  });
  assert.deepEqual(events, ['4D:token-1']);
  assert.deepEqual(response, {
    kind: 'saved',
    outcome: committedResult().outcome,
    finalizations: [],
  });
});

test('the sweep adapter distinguishes pre-consumption refusal from an attempt', async () => {
  const result = await consumeCommitCoordinatorForSweep(
    { candidateId: 'candidate-1', tokenId: 'token-1', message: 'Save it' },
    routesFixture({ coordinator: { commit: async () => ({ kind: 'compose-in-flight' }) } }),
    () => undefined,
  );
  assert.deepEqual(result, {
    attempt: { created: false },
    reconciliation: 'not-applicable',
    response: {
      kind: 'compose-in-flight',
      refusal: {
        stage: 'token-consume', code: 'token-consume-busy',
        message: 'Token-consume stage refused because another save holds the repository coordinator.',
      },
    },
  });
});

(async () => {
  let failures = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failures++;
      console.error(`not ok - ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`\nAll ${tests.length} commit-coordinator-ipc tests passed`);
})();
