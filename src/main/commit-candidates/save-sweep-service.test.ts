import assert from 'node:assert/strict';

import type { PackageFinalization } from '../database';
import type { CommitRepresentation } from './commit-representation';
import type {
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  EncodedGitPath,
  CommitOutcome,
  ReviewedAttributionTopology,
} from '../../shared/commit-candidates';
import type { SaveSweepIntent } from '../../shared/types';
import {
  CommitCandidateService,
  buildCandidate,
  buildReviewedSemanticManifest,
  rememberReviewedSemanticManifest,
  type CandidateBuildContext,
  type CandidateServiceDeps,
} from './candidate-service';
import {
  SaveSweepService,
  type FreshSaveSweepResolution,
} from './save-sweep-service';
import type { SweepConsumableCoordinatorResult } from './commit-coordinator-ipc';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const HEAD = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);
const REPOSITORY_KEY = 'r'.repeat(64);
let sequence = 0;

function pathOf(relative: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(relative, 'utf8').toString('base64'),
    displayPath: relative,
    utf8Clean: true,
  };
}

function entry(relative: string): DirtyEntry {
  const path = pathOf(relative);
  return {
    entryId: `entry-${relative}`,
    path,
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: `raw-${relative}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [path],
  };
}

function componentFor(entries: readonly DirtyEntry[], id: string): ConflictComponent {
  return {
    componentId: id,
    dirtyEntryIds: entries.map((item) => item.entryId),
    associations: [],
    overlap: {
      componentId: id,
      contributingAgentCount: 0,
      mergedGroupCount: 0,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: `topology-${id}`,
  };
}

function finalizationFor(name: string, entries: readonly DirtyEntry[]): PackageFinalization {
  return {
    id: `fin-${name}`,
    packageId: `pkg-${name}`,
    repositoryKey: REPOSITORY_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 1,
    finalizedAt: 1,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'b'.repeat(40),
    boundaryRef: `refs/lares/finalizations/fin-${name}/1`,
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify(entries.map((item) => ({
      pathBytesBase64: item.path.pathBytesBase64,
      expectedState: 'present',
      rawBlobOid: item.rawWorktreeBlobOid,
      commitBlobOid: `commit-${item.path.displayPath}`,
      commitMode: '100644',
    }))),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: 'ws-1',
  };
}

function topology(entries: readonly DirtyEntry[]): ReviewedAttributionTopology {
  return {
    componentPathSets: [entries.map((item) => item.path.pathBytesBase64).sort()],
    contributors: [],
    ownershipGroupKeys: [],
    componentEdges: [],
    requiresOverlapAck: false,
    selectedUnattributedPathBytesBase64: [],
  };
}

function contextFor(
  allFrozenEntries: readonly DirtyEntry[],
  pendingEntries: readonly DirtyEntry[] = allFrozenEntries,
  options: { hasUnmerged?: boolean; ledger?: CandidateBuildContext['ledger'] } = {},
): { context: CandidateBuildContext; finalization: PackageFinalization; component: ConflictComponent } {
  const name = allFrozenEntries.map((item) => item.path.displayPath).join('-');
  const finalization = finalizationFor(name, allFrozenEntries);
  const component = componentFor(pendingEntries, `component-${name}-${++sequence}`);
  const frozenByPath = new Map(
    (JSON.parse(finalization.memberManifestJson) as Array<{
      pathBytesBase64: string;
      expectedState: 'present';
      rawBlobOid: string;
      commitBlobOid: string;
      commitMode: string;
    }>).map((member) => [member.pathBytesBase64, member]),
  );
  const currentCommitReps = new Map<string, CommitRepresentation>();
  for (const item of pendingEntries) {
    const frozen = frozenByPath.get(item.path.pathBytesBase64)!;
    currentCommitReps.set(item.entryId, {
      expectedState: frozen.expectedState,
      rawBlobOid: frozen.rawBlobOid,
      commitBlobOid: frozen.commitBlobOid,
      commitMode: frozen.commitMode,
    });
  }
  const repository = {
    repositoryKey: REPOSITORY_KEY,
    objectDatabaseKey: `odb-${REPOSITORY_KEY}`,
    gitObjectFormat: 'sha1' as const,
    bareRepo: false as const,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
  return {
    finalization,
    component,
    context: {
      repository,
      inventory: {
        repository,
        entries: [...pendingEntries],
        unattributedEntryIds: [],
        topologyDigest: `inventory-${sequence}`,
      },
      components: pendingEntries.length > 0 ? [component] : [],
      finalizations: [finalization],
      currentCommitReps,
      ledger: options.ledger ?? [],
      pinnedHeadOid: HEAD,
      indexFingerprint: {
        fingerprint: `index-${sequence}`,
        entries: [],
        hasUnmerged: options.hasUnmerged ?? false,
        writeTreeOid: 'd'.repeat(40),
      },
      reviewedAttributionTopology: topology(pendingEntries),
      reviewChallengeAtoms: [],
      contractVersion: 1,
    },
  };
}

function reviewedIntent(name: string, entries = [entry(`${name}.txt`)]) {
  const state = contextFor(entries);
  const selection = {
    selectedComponentIds: [state.component.componentId],
    selectedUnattributedEntryIds: [],
    finalizationIds: [state.finalization.id],
  };
  const candidate = buildCandidate(selection, state.context);
  assert.ok('candidateId' in candidate && candidate.eligibility.eligible);
  const manifest = buildReviewedSemanticManifest(candidate as CommitCandidate, state.context);
  const reviewedManifestDigest = rememberReviewedSemanticManifest(manifest);
  const intent: SaveSweepIntent = {
    repositoryKey: REPOSITORY_KEY,
    finalizationId: state.finalization.id,
    packageId: state.finalization.packageId,
    packageRevision: state.finalization.packageRevision,
    frozenMemberManifestDigest: manifest.finalizations[0].frozenMemberManifestDigest,
    reviewedManifestDigest,
    message: `Save ${name}`,
  };
  return { ...state, selection, intent, manifest };
}

function sweepRequest(items: Array<ReturnType<typeof reviewedIntent>>) {
  return {
    intents: items.map((item) => item.intent),
    reviewedManifestDigests: items.map((item) => item.intent.reviewedManifestDigest),
    acknowledgedChallengeAtoms: items.flatMap((item) => item.manifest.challengeAtoms),
  };
}

function candidateService(now: () => number = () => 0): CommitCandidateService {
  let token = 0;
  return new CommitCandidateService({
    tokenStore: {
      now,
      randomTokenBytes: () => Buffer.alloc(32, ++token),
    },
  } as CandidateServiceDeps);
}

function saved(attemptId = 'attempt-1', commitOid = COMMIT): SweepConsumableCoordinatorResult {
  return {
    attempt: { created: true, attemptId, commitOid },
    reconciliation: 'succeeded',
    response: {
      kind: 'saved',
      outcome: { status: 'committed', attemptId, commitOid, indexIntegrity: 'verified' },
      finalizations: [],
    },
  };
}

function ready(value: ReturnType<typeof reviewedIntent>): FreshSaveSweepResolution {
  return {
    kind: 'candidate',
    indexFingerprint: value.context.indexFingerprint,
    context: value.context,
    selection: value.selection,
  };
}

test('mints only just in time even when the fake clock advances beyond five minutes', async () => {
  let now = 0;
  const one = reviewedIntent('clock-a');
  const two = reviewedIntent('clock-b');
  const candidates = candidateService(() => now);
  const issuedAt: number[] = [];
  const service = new SaveSweepService({
    candidateService: candidates,
    resolveIntent: async (intent) => ready(intent.finalizationId === one.intent.finalizationId ? one : two),
    consume: async (request) => {
      const snapshot = candidates.resolveCandidateToken(request.tokenId);
      assert.ok(snapshot, 'the just-minted token must be live when consumed');
      issuedAt.push(snapshot.token.issuedAt);
      assert.ok(snapshot.token.expiresAt > now);
      candidates.tryMarkTokenConsuming(request.tokenId);
      candidates.markTokenConsumed(request.tokenId);
      if (issuedAt.length === 1) now += (5 * 60 * 1000) + 1;
      return saved(`attempt-${issuedAt.length}`, COMMIT);
    },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([two, one]));
  assert.deepEqual(result.results.map((item) => item.kind), ['saved', 'saved']);
  assert.deepEqual(issuedAt, [0, (5 * 60 * 1000) + 1]);
});

test('already-saved emits proving commits and never mints', async () => {
  const item = reviewedIntent('already');
  const candidates = candidateService();
  let consumes = 0;
  const service = new SaveSweepService({
    candidateService: candidates,
    resolveIntent: async () => ({
      kind: 'already-saved',
      indexFingerprint: item.context.indexFingerprint,
      provingCommitOids: [COMMIT, COMMIT],
    }),
    consume: async () => { consumes++; return saved(); },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([item]));
  assert.deepEqual(result.results, [{
    repositoryKey: REPOSITORY_KEY,
    finalizationId: item.intent.finalizationId,
    packageId: item.intent.packageId,
    packageRevision: 1,
    kind: 'already-saved',
    provingCommitOids: [COMMIT],
  }]);
  assert.equal(consumes, 0);
});

test('partial satisfaction invokes WP-4 discharge proof and commits only the pending remainder', async () => {
  const first = entry('partial-a.txt');
  const second = entry('partial-b.txt');
  const reviewed = reviewedIntent('partial', [first, second]);
  const firstPath = first.path.pathBytesBase64;
  const fresh = contextFor([first, second], [second], {
    ledger: [{
      commitOid: HEAD,
      pathBytesBase64: firstPath,
      expectedState: 'present',
      rawBlobOidAtCommit: first.rawWorktreeBlobOid,
      commitBlobOid: `commit-${first.path.displayPath}`,
      commitMode: '100644',
    }],
  });
  const selection = {
    selectedComponentIds: [fresh.component.componentId],
    selectedUnattributedEntryIds: [],
    finalizationIds: [fresh.finalization.id],
  };
  const candidates = candidateService();
  let committedMembers: string[] = [];
  const service = new SaveSweepService({
    candidateService: candidates,
    resolveIntent: async () => ({
      kind: 'candidate',
      indexFingerprint: fresh.context.indexFingerprint,
      context: fresh.context,
      selection,
    }),
    consume: async (request) => {
      const snapshot = candidates.resolveCandidateToken(request.tokenId);
      assert.ok(snapshot);
      committedMembers = snapshot.candidate.members.map((member) => member.path.pathBytesBase64);
      return saved();
    },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([reviewed]));
  assert.deepEqual(result.results.map((item) => item.kind), ['saved']);
  assert.deepEqual(committedMembers, [second.path.pathBytesBase64]);
});

test('a pre-consumption refusal needs attention and the next package proceeds freshly', async () => {
  const one = reviewedIntent('pre-a');
  const two = reviewedIntent('pre-b');
  const candidates = candidateService();
  let consumeCount = 0;
  const service = new SaveSweepService({
    candidateService: candidates,
    resolveIntent: async (intent) => ready(intent.finalizationId === one.intent.finalizationId ? one : two),
    consume: async () => {
      consumeCount++;
      if (consumeCount === 1) return {
        attempt: { created: false },
        reconciliation: 'not-applicable',
        response: {
          kind: 'compose-in-flight',
          refusal: { stage: 'token-consume', code: 'token-consume-busy', message: 'busy' },
        },
      };
      return saved('attempt-2');
    },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([one, two]));
  assert.deepEqual(result.results.map((item) => item.kind), ['needs-attention', 'saved']);
});

test('an unmerged stage anywhere blocks the current and every remaining intent before mint', async () => {
  const one = reviewedIntent('merge-a');
  const two = reviewedIntent('merge-b');
  const unmerged = structuredClone(one.context.indexFingerprint);
  unmerged.hasUnmerged = true;
  const unmergedContext = { ...one.context, indexFingerprint: unmerged };
  let consumes = 0;
  const service = new SaveSweepService({
    candidateService: candidateService(),
    resolveIntent: async () => ({ ...ready(one), context: unmergedContext }),
    consume: async () => { consumes++; return saved(); },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([one, two]));
  assert.deepEqual(result.results.map((item) => item.kind), ['blocked-unmerged', 'blocked-unmerged']);
  assert.equal(consumes, 0);
});

const postConsumeCases: Array<[string, Exclude<CommitOutcome, { status: 'committed' }>]> = [
  ['aborted-stale', { status: 'aborted-stale', reason: 'stale', attemptId: 'attempt-x' }],
  ['aborted-error', { status: 'aborted-error', reason: 'error', attemptId: 'attempt-x' }],
  ['repository-state-uncertain', {
    status: 'repository-state-uncertain',
    pinnedHeadOid: HEAD,
    resolvedHeadOid: 'b'.repeat(40),
    attemptId: 'attempt-x',
  }],
  ['committed-integrity-mismatch', {
    status: 'committed-integrity-mismatch',
    commitOid: COMMIT,
    attemptId: 'attempt-x',
    mismatchedPaths: [],
    indexIntegrity: 'mismatch',
  }],
];

for (const [name, outcome] of postConsumeCases) {
  test(`${name} halts after consumption and does not attempt the remainder`, async () => {
    const one = reviewedIntent(`halt-${name}-a`);
    const two = reviewedIntent(`halt-${name}-b`);
    const service = new SaveSweepService({
      candidateService: candidateService(),
      resolveIntent: async (intent) => ready(intent.finalizationId === one.intent.finalizationId ? one : two),
      consume: async () => ({
        attempt: {
          created: true,
          attemptId: outcome.attemptId,
          ...('commitOid' in outcome ? { commitOid: outcome.commitOid } : {}),
        },
        reconciliation: 'not-applicable',
        response: {
          kind: 'outcome',
          outcome,
          refusal: { stage: 'commit', code: name, message: name },
        },
      }),
      refreshInventory: async () => undefined,
    });
    const result = await service.sweep(sweepRequest([one, two]));
    assert.deepEqual(result.results.map((item) => item.kind), ['halted-uncertain', 'not-attempted']);
  });
}

test('commit transport uncertainty halts without retry', async () => {
  const one = reviewedIntent('transport-a');
  const two = reviewedIntent('transport-b');
  let calls = 0;
  const service = new SaveSweepService({
    candidateService: candidateService(),
    resolveIntent: async (intent) => ready(intent.finalizationId === one.intent.finalizationId ? one : two),
    consume: async () => { calls++; throw new Error('connection lost'); },
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([one, two]));
  assert.deepEqual(result.results.map((item) => item.kind), ['halted-uncertain', 'not-attempted']);
  assert.equal(calls, 1);
});

test('reconciliation failure halts with the known attempt and commit OIDs', async () => {
  const one = reviewedIntent('reconcile-a');
  const two = reviewedIntent('reconcile-b');
  const service = new SaveSweepService({
    candidateService: candidateService(),
    resolveIntent: async (intent) => ready(intent.finalizationId === one.intent.finalizationId ? one : two),
    consume: async () => ({
      attempt: { created: true, attemptId: 'attempt-r', commitOid: COMMIT },
      reconciliation: 'failed',
      response: {
        kind: 'reconciliation-error',
        outcome: { status: 'committed', attemptId: 'attempt-r', commitOid: COMMIT, indexIntegrity: 'verified' },
        error: { code: 'tree-mismatch', message: 'tree mismatch' },
        refusal: { stage: 'reconciliation', code: 'tree-mismatch', message: 'tree mismatch' },
      },
    }),
    refreshInventory: async () => undefined,
  });
  const result = await service.sweep(sweepRequest([one, two]));
  assert.deepEqual(result.results.map((item) => item.kind), ['halted-uncertain', 'not-attempted']);
  assert.deepEqual(result.results[0], {
    repositoryKey: REPOSITORY_KEY,
    finalizationId: one.intent.finalizationId,
    packageId: one.intent.packageId,
    packageRevision: 1,
    kind: 'halted-uncertain',
    code: 'tree-mismatch',
    message: 'tree mismatch',
    attemptId: 'attempt-r',
    commitOid: COMMIT,
  });
});

test('successful packages advance through fresh resolution without full post-save inventory refreshes', async () => {
  const one = reviewedIntent('refresh-a');
  const two = reviewedIntent('refresh-b');
  let resolutions = 0;
  let fullRefreshes = 0;
  const service = new SaveSweepService({
    candidateService: candidateService(),
    resolveIntent: async (intent) => {
      resolutions++;
      return ready(intent.finalizationId === one.intent.finalizationId ? one : two);
    },
    consume: async () => saved('attempt-refresh', COMMIT),
    refreshInventory: async () => { fullRefreshes++; },
  });
  const result = await service.sweep(sweepRequest([one, two]));
  assert.deepEqual(result.results.map((item) => item.kind), ['saved', 'saved']);
  assert.equal(resolutions, 2, 'each package is incrementally re-resolved');
  assert.equal(fullRefreshes, 0, 'no redundant full status + attribution refresh runs after a package');
});

test('production IPC registration invokes savecard:sweep on a real SaveSweepService', async () => {
  type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, RegisteredHandler>();
  const ipcMain = {
    handle(channel: string, handler: RegisteredHandler) { handlers.set(channel, handler); },
    on() { /* registration-only fake */ },
  };
  const noop = () => undefined;
  const electronPath = require.resolve('electron');
  const priorElectron = require.cache[electronPath];
  const ipcHandlersPath = require.resolve('../ipc-handlers');
  const priorIpcHandlers = require.cache[ipcHandlersPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain,
      app: { getPath: () => process.cwd(), isPackaged: false, on: noop },
      dialog: { showOpenDialog: noop, showMessageBox: noop },
      shell: { openExternal: noop, trashItem: noop },
      BrowserWindow: class {},
      nativeTheme: { on: noop, themeSource: 'system', shouldUseDarkColors: false },
    },
    children: [],
    paths: [],
  } as unknown as NodeModule;
  delete require.cache[ipcHandlersPath];

  try {
    const bridge = require('../ipc-handlers') as typeof import('../ipc-handlers');
    const service = new SaveSweepService({
      candidateService: candidateService(),
      resolveIntent: async () => { throw new Error('empty sweep must not resolve an intent'); },
      consume: async () => { throw new Error('empty sweep must not consume'); },
      refreshInventory: async () => { throw new Error('empty sweep must not refresh'); },
    });
    bridge.setSaveSweepService(service);
    const supervisor = new Proxy({}, { get: () => noop });
    const mainWindow = new Proxy({
      isDestroyed: () => false,
      webContents: new Proxy({ send: noop }, { get: () => noop }),
    }, { get: (target, property) => property in target
      ? target[property as keyof typeof target]
      : noop });
    bridge.registerIpcHandlers(
      supervisor as Parameters<typeof bridge.registerIpcHandlers>[0],
      mainWindow as unknown as Parameters<typeof bridge.registerIpcHandlers>[1],
      {} as Parameters<typeof bridge.registerIpcHandlers>[2],
    );

    const handler = handlers.get('savecard:sweep');
    assert.ok(handler, 'the production registerIpcHandlers path must register savecard:sweep');
    const result = await handler({}, {
      intents: [],
      reviewedManifestDigests: [],
      acknowledgedChallengeAtoms: [],
    });
    assert.deepEqual(result, { results: [], halted: false, haltKind: null });
  } finally {
    if (priorElectron) require.cache[electronPath] = priorElectron;
    else delete require.cache[electronPath];
    if (priorIpcHandlers) require.cache[ipcHandlersPath] = priorIpcHandlers;
    else delete require.cache[ipcHandlersPath];
  }
});

(async () => {
  let failures = 0;
  let executed = 0;
  for (const entry of tests) {
    try {
      executed++;
      await entry.run();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failures++;
      console.error(`not ok - ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  assert.equal(executed, tests.length, 'every declared sweep case must execute');
  if (failures > 0) process.exitCode = 1;
  else console.log(`\nAll ${tests.length} save-sweep tests passed (no cases skipped)`);
})();
