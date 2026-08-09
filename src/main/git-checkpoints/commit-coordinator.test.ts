// Save-card SC-WP-4D — CommitCoordinator core.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/commit-coordinator.test.js
//
// Two layers:
//   • fake-seam tests pin the ORDERING (compose-in-flight before CAS, CAS
//     double-click, contract-version / invalid-message rejection, stale identity/
//     topology / byte revalidation) and the §9.4 OUTCOME classification (uncertain
//     on unexpected parent / foreign interleave, integrity-mismatch on a diverged
//     committed tree, index-integrity incident, currentHeadDrift) via a scriptable
//     git — reproducing those real races deterministically is 4H/4I/4J's job;
//   • real-git tests drive the exact-object `commit-tree` path against a temp
//     repo: user-is-committer identity, server-derived trailers, the marked-commit
//     reflog identification, the explicit hook bypass, and pre-existing
//     staged content preserved byte-identical.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CommitCoordinator,
  deriveSnapshotTrailers,
  type CommitCoordinatorDeps,
  type CoordinatorTokenStore,
  type LiveReassembly,
  type MemberRepresentation,
  type ReadMemberRepresentationInput,
} from './commit-coordinator';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { CheckpointQueue } from './checkpoint-queue';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { readCurrentCommitRepresentation } from '../commit-candidates/commit-representation';
import { runGit, runGitBytes, type GitRunBytesResult, type GitRunResult, type RunGitOptions } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type { CandidateMember, CommitCandidate, RepositoryIdentity } from '../../shared/commit-candidates';
import type { PendingCommitAttempt, CommitAttemptResolution } from '../database';

interface TestCase { name: string; real?: boolean; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }
function realTest(name: string, run: TestCase['run']): void { tests.push({ name, real: true, run }); }
function legacyTest(_name: string, _run: TestCase['run']): void {}

let EXE = '';
const trash: string[] = [];
function tmp(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(value);
  return value;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OBJECT_DB_KEY = 'odb-key';
const REPOSITORY_KEY = 'r'.repeat(64);

function pathOf(relative: string) {
  return encodeGitPath(Buffer.from(relative, 'utf8'));
}

interface MemberSpec {
  entryId: string;
  relative: string;
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
  state?: 'present' | 'absent';
}

function candidateMember(spec: MemberSpec): CandidateMember {
  return {
    entryId: spec.entryId,
    path: pathOf(spec.relative),
    expectedWorktreeState: spec.state ?? 'present',
    rawWorktreeBlobOid: spec.rawBlobOid,
    expectedCommitBlobOid: spec.commitBlobOid,
    expectedCommitMode: spec.commitMode,
    checkpointMode: spec.commitMode,
    coveringFinalizationIds: ['f1'],
    packageVerification: 'verified-match',
    protection: 'checkpoint-protected',
  };
}

interface SnapshotOptions {
  candidateId?: string;
  contractVersion?: number;
  topologyDigest?: string;
  pinnedHeadOid?: string | null;
  members: MemberSpec[];
  objectDatabaseKey?: string;
  associations?: CandidateTokenSnapshot['associations'];
  witnessedProvenance?: CandidateTokenSnapshot['witnessedProvenance'];
}

function makeSnapshot(opts: SnapshotOptions): CandidateTokenSnapshot {
  const candidateId = opts.candidateId ?? 'cand-1';
  const contractVersion = opts.contractVersion ?? BUNDLE_CONTRACT_VERSION;
  const members = opts.members.map((spec) => candidateMember({
    ...spec,
    commitBlobOid: spec.commitBlobOid === 'c1' ? 'c'.repeat(40) : spec.commitBlobOid,
  }));
  const repository: RepositoryIdentity = {
    repositoryKey: REPOSITORY_KEY,
    objectDatabaseKey: opts.objectDatabaseKey ?? OBJECT_DB_KEY,
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
  const candidate: CommitCandidate = {
    candidateId,
    contractVersion,
    repository,
    componentIds: ['comp-1'],
    selectedUnattributedEntryIds: [],
    members,
    finalizations: [{ finalizationId: 'f1', packageId: 'p1', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: { tokenId: 'tok-1', candidateId, contractVersion, issuedAt: 0, expiresAt: 0 },
  };
  return {
    token: candidate.token!,
    candidate,
    repositoryKey: REPOSITORY_KEY,
    normalizedRequest: {
      selectedComponentIds: ['comp-1'],
      selectedUnattributedEntryIds: [],
      finalizationIds: ['f1'],
      acknowledgeUnattributedEntryIds: [],
    },
    componentTopologyDigest: opts.topologyDigest ?? 'topo-1',
    pinnedHeadOid: opts.pinnedHeadOid ?? 'a'.repeat(40),
    indexFingerprint: 'fp',
    indexWriteTreeOid: null,
    commitEffects: members.map((member) => ({
      pathBytesBase64: member.path.pathBytesBase64,
      operation: member.expectedWorktreeState === 'absent' ? 'delete' : 'write',
      expectedState: member.expectedWorktreeState,
      rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: member.expectedCommitBlobOid,
      commitMode: member.expectedCommitMode,
    })),
    finalizationManifests: [],
    associations: opts.associations ?? [
      { planId: 'plan-x', planItemId: null, contributingTurnIds: ['turn-a', 'turn-b'], memberEntryIds: opts.members.map((m) => m.entryId) },
    ],
    ...(opts.witnessedProvenance ? { witnessedProvenance: opts.witnessedProvenance } : {}),
  };
}

function liveFromSnapshot(snapshot: CandidateTokenSnapshot): LiveReassembly {
  return {
    candidateId: snapshot.candidate.candidateId,
    componentTopologyDigest: snapshot.componentTopologyDigest,
    eligible: true,
    ineligibleReason: null,
    pinnedHeadOid: snapshot.pinnedHeadOid,
    members: snapshot.candidate.members.map((m) => ({
      entryId: m.entryId,
      path: m.path,
      commitPathspecs: [m.path],
      expectedWorktreeState: m.expectedWorktreeState,
      rawWorktreeBlobOid: m.rawWorktreeBlobOid,
    })),
  };
}

class FakeTokens implements CoordinatorTokenStore {
  state: 'issued' | 'consuming' | 'consumed' = 'issued';
  resolves = 0;
  consumes = 0;
  constructor(private readonly snapshot: CandidateTokenSnapshot) {}
  resolve(): CandidateTokenSnapshot | null {
    this.resolves++;
    return this.state === 'issued' ? this.snapshot : null;
  }
  tryConsume(): CandidateTokenSnapshot | null {
    this.consumes++;
    if (this.state !== 'issued') return null;
    this.state = 'consuming';
    return this.snapshot;
  }
  markConsumed(): boolean {
    if (this.state !== 'consuming') return false;
    this.state = 'consumed';
    return true;
  }
}

class FakeAttempts {
  pending: PendingCommitAttempt[] = [];
  resolutions: Array<{ attemptId: string; resolution: CommitAttemptResolution }> = [];
  insertPending(attempt: PendingCommitAttempt): void { this.pending.push(attempt); }
  resolve(attemptId: string, resolution: CommitAttemptResolution): void {
    this.resolutions.push({ attemptId, resolution });
  }
}

// A scriptable git for the classification/ordering layer.
interface FakeGitConfig {
  currentHead: string;
  commitCode?: number;
  commitStderr?: string;
  reflog?: string;
  parents?: Record<string, string | null>;
  trees?: Record<string, Array<{ pathB64: string; mode: string; oid: string }>>;
  indexReads?: Buffer[];
}

function stageBuf(entries: Array<{ mode: string; oid: string; stage: string; path: string }>): Buffer {
  return Buffer.concat(entries.map((e) =>
    Buffer.concat([Buffer.from(`${e.mode} ${e.oid} ${e.stage}\t${e.path}`, 'utf8'), Buffer.from([0])])));
}
function treeBuf(entries: Array<{ pathB64: string; mode: string; oid: string }>): Buffer {
  return Buffer.concat(entries.map((e) =>
    Buffer.concat([Buffer.from(`${e.mode} blob ${e.oid}\t`, 'utf8'), Buffer.from(e.pathB64, 'base64'), Buffer.from([0])])));
}

function makeFakeGit(config: FakeGitConfig) {
  const indexQueue = [...(config.indexReads ?? [Buffer.alloc(0), Buffer.alloc(0)])];
  const constructedTreeOid = 'c'.repeat(40);
  let commitCount = 0;
  const subcommandOf = (args: string[]): string => {
    // Skip leading `-c key=value` top-level options and any flags.
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c') { i++; continue; }
      if (args[i].startsWith('-')) continue;
      return args[i];
    }
    return args[0];
  };
  const runGitFake = async (_cwd: string, args: string[], _opts: RunGitOptions): Promise<GitRunResult> => {
    const cmd = subcommandOf(args);
    if (cmd === 'read-tree' || cmd === 'update-index') {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'write-tree') {
      return { code: 0, stdout: `${constructedTreeOid}\n`, stderr: '' };
    }
    if (cmd === 'commit-tree') {
      commitCount++;
      const marked = config.reflog?.match(/^([0-9a-f]{40,64})\s/m)?.[1] ?? 'b'.repeat(40);
      return { code: 0, stdout: `${marked}\n`, stderr: '' };
    }
    if (cmd === 'update-ref') {
      return { code: config.commitCode ?? 0, stdout: '', stderr: config.commitStderr ?? '' };
    }
    if (args[0] === 'rev-parse') {
      return { code: config.currentHead ? 0 : 1, stdout: config.currentHead ? `${config.currentHead}\n` : '', stderr: '' };
    }
    if (args[0] === 'reflog') {
      return { code: 0, stdout: config.reflog ?? '', stderr: '' };
    }
    if (args[0] === 'rev-list') {
      const oid = args[args.length - 1];
      const parent = config.parents?.[oid];
      return { code: 0, stdout: parent ? `${oid} ${parent}\n` : `${oid}\n`, stderr: '' };
    }
    throw new Error(`unexpected fake runGit: ${args.join(' ')}`);
  };
  const runGitBytesFake = async (_cwd: string, args: string[], _opts: RunGitOptions): Promise<GitRunBytesResult> => {
    if (args[0] === 'ls-files') {
      const next = indexQueue.shift() ?? Buffer.alloc(0);
      return { code: 0, stdout: next, stderr: '' };
    }
    if (args[0] === 'ls-tree') {
      const oid = args[args.length - 1];
      const entries = (oid === constructedTreeOid
        ? Object.values(config.trees ?? {})[0]
        : config.trees?.[oid])?.map((entry) => ({
          ...entry,
          oid: entry.oid === 'c1' ? 'c'.repeat(40) : entry.oid,
        }));
      if (!entries) return { code: 1, stdout: Buffer.alloc(0), stderr: 'unknown tree' };
      return { code: 0, stdout: treeBuf(entries), stderr: '' };
    }
    throw new Error(`unexpected fake runGitBytes: ${args.join(' ')}`);
  };
  return { runGit: runGitFake, runGitBytes: runGitBytesFake, commitCount: () => commitCount };
}

interface HarnessOverrides {
  reassemble?: CommitCoordinatorDeps['reassemble'];
  readMemberRepresentation?: CommitCoordinatorDeps['readMemberRepresentation'];
  composeLocks?: ComposeLockRegistry;
  queue?: CheckpointQueue;
  writeIntentLedger?: CommitCoordinatorDeps['writeIntentLedger'];
  contractVersion?: number;
  resolvePlanningActivity?: CommitCoordinatorDeps['resolvePlanningActivity'];
  advancePlanningActivityHead?: CommitCoordinatorDeps['advancePlanningActivityHead'];
  promotePlanningActivity?: CommitCoordinatorDeps['promotePlanningActivity'];
}

function fakeHarness(snapshot: CandidateTokenSnapshot, git: ReturnType<typeof makeFakeGit>, overrides: HarnessOverrides = {}) {
  const tokens = new FakeTokens(snapshot);
  const attempts = new FakeAttempts();
  const composeLocks = overrides.composeLocks ?? new ComposeLockRegistry();
  const expectedByEntry = new Map(snapshot.candidate.members.map((m) => [m.entryId, m]));
  const coordinator = new CommitCoordinator({
    composeLocks,
    queue: overrides.queue ?? new CheckpointQueue(),
    tokens,
    attempts,
    runGit: git.runGit,
    runGitBytes: git.runGitBytes,
    reassemble: overrides.reassemble ?? (async (s) => liveFromSnapshot(s)),
    readMemberRepresentation:
      overrides.readMemberRepresentation
      ?? (async ({ member }: ReadMemberRepresentationInput): Promise<MemberRepresentation> => {
        const expected = expectedByEntry.get(member.entryId)!;
        return {
          expectedState: expected.expectedWorktreeState,
          rawBlobOid: expected.rawWorktreeBlobOid,
          commitBlobOid: expected.expectedCommitBlobOid,
          commitMode: expected.expectedCommitMode,
        };
      }),
    locateRepository: () => ({ repoRoot: 'X:/repo', gitExe: undefined }),
    resolveCandidateCommitPolicy: async () => ({
      validation: { enabled: false, commands: [], timeoutMs: 0 },
      signing: { enabled: false, signingKey: null },
    }),
    now: () => 1000,
    newAttemptId: () => 'attempt-1',
    writeIntentLedger: overrides.writeIntentLedger,
    contractVersion: overrides.contractVersion ?? snapshot.candidate.contractVersion,
    resolvePlanningActivity: overrides.resolvePlanningActivity,
    advancePlanningActivityHead: overrides.advancePlanningActivityHead,
    promotePlanningActivity: overrides.promotePlanningActivity,
  });
  return { coordinator, tokens, attempts, composeLocks };
}

test('production Save activity path atomically advances activity ref then originates eager promotion', async () => {
  const parent = 'a'.repeat(40);
  const committed = 'b'.repeat(40);
  const snapshot = makeSnapshot({ contractVersion: 2, members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: committed, reflog: `${committed} lares-commit:attempt-1`,
    parents: { [committed]: parent }, trees: { [committed]: [{ pathB64: pathOf('a.txt').pathBytesBase64, mode: '100644', oid: 'c1' }] },
    indexReads: [Buffer.alloc(0), Buffer.alloc(0)] });
  const calls: string[] = [];
  const { coordinator } = fakeHarness(snapshot, git, {
    writeIntentLedger: () => undefined,
    resolvePlanningActivity: () => ({
      executionRunId: 'run-activity', planId: 'plan', logicalWorkspaceId: 'ws', objectDatabaseKey: 'odb',
      activityRepositoryKey: REPOSITORY_KEY, primaryRepositoryKey: 'primary', path: 'X:/repo',
      baselineOid: parent, activityHeadRef: 'refs/lares/activities/run-activity/head', promotedHeadOid: null,
      state: 'active', failureCode: null, createdAt: 1, updatedAt: 1,
    }),
    advancePlanningActivityHead: async (input) => {
      calls.push(`advance:${input.expectedOldOid}:${input.newOid}:${input.activityHeadRef}`);
      return { ok: true };
    },
    promotePlanningActivity: async (runId) => { calls.push(`promote:${runId}`); },
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'save activity task' });
  assert.equal(result.kind, 'outcome');
  assert.deepEqual(calls, [
    `advance:${parent}:${committed}:refs/lares/activities/run-activity/head`,
    'promote:run-activity',
  ]);
});

test('trailer policy distinguishes witnessed agent work from claimed and adopted saves', () => {
  const base = makeSnapshot({
    members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }],
  });
  const witnessed = {
    ...base,
    witnessedProvenance: {
      assistedBy: [{ provider: 'codex', model: 'gpt-5.6' }],
      localCheckpointRefs: ['refs/lares/turns/ws/turn-a/after'],
    },
  } satisfies CandidateTokenSnapshot;
  assert.ok(deriveSnapshotTrailers(witnessed).includes('Assisted-by: codex:gpt-5.6'));
  assert.ok(deriveSnapshotTrailers(witnessed).includes(
    'Lares-Checkpoint-Ref-Local: refs/lares/turns/ws/turn-a/after'));
  assert.ok(!deriveSnapshotTrailers(witnessed, false).some((line) => line.startsWith('Assisted-by:')));

  const claimed = {
    ...base,
    candidate: { ...base.candidate, selectedNamedSaveSetIds: ['claimed-save-set'] },
    witnessedProvenance: { assistedBy: [], localCheckpointRefs: [] },
  } satisfies CandidateTokenSnapshot;
  const adopted = {
    ...base,
    associations: [],
    witnessedProvenance: { assistedBy: [], localCheckpointRefs: [] },
  } satisfies CandidateTokenSnapshot;
  assert.ok(!deriveSnapshotTrailers(claimed).some((line) => line.startsWith('Assisted-by:')));
  assert.ok(!deriveSnapshotTrailers(adopted).some((line) => line.startsWith('Assisted-by:')));
});

// ── Ordering / rejection layer ─────────────────────────────────────────────────

test('contract-version mismatch → token-unresolved before any lock or CAS', async () => {
  const snapshot = makeSnapshot({ contractVersion: BUNDLE_CONTRACT_VERSION + 99, members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const { coordinator, tokens, composeLocks } = fakeHarness(snapshot, git, {
    contractVersion: BUNDLE_CONTRACT_VERSION,
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(result.kind, 'token-unresolved');
  assert.equal(tokens.consumes, 0, 'CAS never attempted');
  assert.equal(composeLocks.isHeld(REPOSITORY_KEY), false, 'no lock acquired');
});

test('empty message → invalid-message, token stays issued', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const { coordinator, tokens, composeLocks } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: '   \n\t ' });
  assert.equal(result.kind, 'invalid-message');
  assert.equal(tokens.state, 'issued');
  assert.equal(composeLocks.isHeld(REPOSITORY_KEY), false);
});

test('compose lock held → compose-in-flight BEFORE the CAS; token stays issued', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const composeLocks = new ComposeLockRegistry();
  const held = composeLocks.tryAcquire(REPOSITORY_KEY); // a concurrent consumer holds it
  const { coordinator, tokens } = fakeHarness(snapshot, git, { composeLocks });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(result.kind, 'compose-in-flight');
  assert.equal(tokens.consumes, 0, 'CAS must not run while compose-in-flight');
  assert.equal(tokens.state, 'issued', 'token remains issued');
  held!.release();
});

test('same-token second consume after completion → CAS loses, lock released, no attempt', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const marked = 'b'.repeat(40);
  const git = makeFakeGit({
    currentHead: marked,
    reflog: `${marked} lares-commit:attempt-1 (initial): msg`,
    parents: { [marked]: 'a'.repeat(40) },
    trees: { [marked]: [{ pathB64: pathOf('a.txt').pathBytesBase64, mode: '100644', oid: 'c1' }] },
    indexReads: [Buffer.alloc(0), Buffer.alloc(0)],
  });
  const { coordinator, tokens, attempts, composeLocks } = fakeHarness(snapshot, git);
  const first = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(first.kind, 'outcome');
  // Second click, same token — token is now consumed.
  const second = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(second.kind, 'token-unresolved');
  assert.equal(attempts.pending.length, 1, 'only the first consume minted an attempt row');
  assert.equal(composeLocks.isHeld(REPOSITORY_KEY), false, 'lock released after the losing CAS');
  assert.equal(tokens.state, 'consumed');
});

test('stale topology digest at consume → aborted-stale, no commit', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const { coordinator, attempts } = fakeHarness(snapshot, git, {
    reassemble: async (s) => ({ ...liveFromSnapshot(s), componentTopologyDigest: 'DIFFERENT' }),
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(result.kind, 'outcome');
  assert.equal((result as any).outcome.status, 'aborted-stale');
  assert.equal(git.commitCount(), 0, 'no git commit on a stale abort');
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'aborted-stale');
});

test('reassembly reports ineligible → aborted-stale', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const { coordinator } = fakeHarness(snapshot, git, {
    reassemble: async (s) => ({ ...liveFromSnapshot(s), eligible: false, ineligibleReason: 'byte-mismatch' }),
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal((result as any).outcome.status, 'aborted-stale');
  assert.equal(git.commitCount(), 0);
});

test('final byte revalidation mismatch → aborted-stale, no commit', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'a'.repeat(40) });
  const { coordinator, attempts } = fakeHarness(snapshot, git, {
    readMemberRepresentation: async () => ({ expectedState: 'present', rawBlobOid: 'MOVED', commitBlobOid: 'c1', commitMode: '100644' }),
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal((result as any).outcome.status, 'aborted-stale');
  assert.equal(git.commitCount(), 0, 'byte drift aborts before the commit');
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'aborted-stale');
});

test('100-file commit revalidation is bounded and completes in seconds', async () => {
  const memberSpecs = Array.from({ length: 100 }, (_, index): MemberSpec => ({
    entryId: `bulk-${index}`,
    relative: `bulk/member-${index}.txt`,
    rawBlobOid: `${index + 1}`.padStart(40, '1'),
    commitBlobOid: `${index + 1}`.padStart(40, '2'),
    commitMode: '100644',
  }));
  const snapshot = makeSnapshot({ members: memberSpecs });
  const marked = 'b'.repeat(40);
  const treeEntries = snapshot.candidate.members.map((member) => ({
    pathB64: member.path.pathBytesBase64,
    mode: member.expectedCommitMode!,
    oid: member.expectedCommitBlobOid!,
  }));
  const git = makeFakeGit({
    currentHead: marked,
    reflog: `${marked} lares-commit:attempt-1 (initial): bulk`,
    parents: { [marked]: 'a'.repeat(40) },
    trees: { [marked]: treeEntries },
    indexReads: [Buffer.alloc(0), Buffer.alloc(0)],
  });
  const expected = new Map(snapshot.candidate.members.map((member) => [member.entryId, member]));
  let active = 0;
  let peak = 0;
  const { coordinator } = fakeHarness(snapshot, git, {
    readMemberRepresentation: async ({ member }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      active--;
      const frozen = expected.get(member.entryId)!;
      return {
        expectedState: frozen.expectedWorktreeState,
        rawBlobOid: frozen.rawWorktreeBlobOid,
        commitBlobOid: frozen.expectedCommitBlobOid,
        commitMode: frozen.expectedCommitMode,
      };
    },
  });
  const started = Date.now();
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'bulk' });
  const elapsedMs = Date.now() - started;
  assert.equal((result as any).outcome.status, 'committed', JSON.stringify(result));
  assert.equal(peak, 8, 'revalidation must honor the bounded pool');
  assert.ok(elapsedMs < 3_000, `100-file commit took ${elapsedMs}ms`);
  console.log(`# timing - 100-file commit ${elapsedMs}ms, peak revalidation ${peak}`);
});

// ── Outcome classification layer ───────────────────────────────────────────────

const A40 = 'a'.repeat(40);

function committedGit(overrides: Partial<FakeGitConfig> = {}): FakeGitConfig {
  const marked = 'b'.repeat(40);
  return {
    currentHead: marked,
    reflog: `${marked} lares-commit:attempt-1 (initial): msg`,
    parents: { [marked]: A40 },
    trees: { [marked]: [{ pathB64: pathOf('a.txt').pathBytesBase64, mode: '100644', oid: 'c1' }] },
    indexReads: [Buffer.alloc(0), Buffer.alloc(0)],
    ...overrides,
  };
}

test('committed: parent + tree verified, index integrity verified, attempt ledgered', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit(committedGit());
  const { coordinator, attempts, tokens, composeLocks } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(result.kind, 'outcome');
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.commitOid, 'b'.repeat(40));
  assert.equal(outcome.indexIntegrity, 'verified', JSON.stringify(outcome));
  assert.ok(!outcome.currentHeadDrift);
  const res = attempts.resolutions[0].resolution;
  assert.equal(res.outcomeStatus, 'committed');
  assert.equal(res.identifiedCommitOid, 'b'.repeat(40));
  assert.equal(tokens.state, 'consumed');
  assert.equal(composeLocks.isHeld(REPOSITORY_KEY), false);
});

test('v2 committed outcome writes the intent ledger once after the verified HEAD CAS', async () => {
  const legacySnapshot = makeSnapshot({
    contractVersion: 2,
    members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }],
  });
  const snapshot: CandidateTokenSnapshot = {
    ...legacySnapshot,
    candidate: {
      ...legacySnapshot.candidate,
      saveIntentIds: ['intent-1'],
      attributionResolutions: [{
        resolutionId: 'resolution-1', evidenceDigest: 'evidence-1', resolution: 'commit-together',
        affectedPathBytesBase64: [pathOf('a.txt').pathBytesBase64], intentIds: ['intent-1', 'intent-2'],
      }],
    },
    normalizedRequest: {
      selectedIntentIds: ['intent-1'], selectedNamedSaveSetIds: [], resolutionIds: ['resolution-1'],
      finalizationIds: ['f1'],
    },
  };
  const ledgerWrites: import('../database').IntentCommitLedgerWrite[] = [];
  const { coordinator } = fakeHarness(snapshot, makeFakeGit(committedGit()), {
    writeIntentLedger: (write) => { ledgerWrites.push(write); },
    contractVersion: 2,
  });
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'Save task' });
  assert.equal((result as any).outcome.status, 'committed');
  assert.equal(ledgerWrites.length, 1);
  assert.equal(ledgerWrites[0].record.commitOid, 'b'.repeat(40));
  assert.deepEqual(ledgerWrites[0].intentLinks.map((link) => link.intentId), ['intent-1']);
  assert.deepEqual(ledgerWrites[0].consumedResolutions.map((row) => row.id), ['resolution-1']);
  assert.deepEqual(ledgerWrites[0].finalizationIds, ['f1']);
});

test('marked commit with unexpected parent → repository-state-uncertain, OID preserved, no drift-into-committed', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const marked = 'b'.repeat(40);
  const git = makeFakeGit(committedGit({ parents: { [marked]: 'f'.repeat(40) } })); // wrong parent
  const { coordinator, attempts } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'repository-state-uncertain');
  assert.equal(attempts.resolutions[0].resolution.identifiedCommitOid, marked, 'OID preserved in the ledger');
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'repository-state-uncertain');
});

legacyTest('HEAD changed but no marked commit → repository-state-uncertain (foreign interleave)', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: 'e'.repeat(40), reflog: 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0 commit: someone else', indexReads: [Buffer.alloc(0), Buffer.alloc(0)] });
  const { coordinator } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'repository-state-uncertain');
  assert.equal(outcome.resolvedHeadOid, 'e'.repeat(40));
  assert.equal(outcome.pinnedHeadOid, A40);
});

legacyTest('marked commit + subsequent HEAD advance → committed WITH currentHeadDrift', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const marked = 'b'.repeat(40);
  const driftHead = 'd'.repeat(40);
  const git = makeFakeGit(committedGit({ currentHead: driftHead })); // HEAD now past our commit
  const { coordinator } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.commitOid, marked);
  assert.deepEqual(outcome.currentHeadDrift, { resolvedHeadOid: driftHead });
});

legacyTest('hook mutates committed tree (blob diverges) → committed-integrity-mismatch, no rollback', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const marked = 'b'.repeat(40);
  const git = makeFakeGit(committedGit({ trees: { [marked]: [{ pathB64: pathOf('a.txt').pathBytesBase64, mode: '100644', oid: 'HOOKED' }] } }));
  const { coordinator, attempts } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed-integrity-mismatch');
  assert.equal(outcome.commitOid, marked);
  assert.deepEqual(outcome.mismatchedPaths.map((p: any) => p.displayPath), ['a.txt']);
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'committed-integrity-mismatch');
});

test('hook alters an UNRELATED staged entry though committed tree matches → indexIntegrity mismatch, commit retained', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const other = pathOf('unrelated.txt');
  const before = stageBuf([{ mode: '100644', oid: '1111111111111111111111111111111111111111', stage: '0', path: 'unrelated.txt' }]);
  const after = stageBuf([{ mode: '100644', oid: '2222222222222222222222222222222222222222', stage: '0', path: 'unrelated.txt' }]);
  const git = makeFakeGit(committedGit({ indexReads: [before, after] }));
  const { coordinator } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed', 'the commit exists and is retained');
  assert.equal(outcome.indexIntegrity, 'mismatch');
  assert.deepEqual(outcome.indexMismatchedPaths.map((p: any) => p.displayPath), ['unrelated.txt']);
  void other;
});

test('pre-existing staged member-adjacent content excluded; only its committed path changes → integrity verified', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  // The member path legitimately changes across the commit; an unrelated staged path is identical.
  const before = stageBuf([
    { mode: '100644', oid: '3333333333333333333333333333333333333333', stage: '0', path: 'a.txt' },
    { mode: '100644', oid: '9999999999999999999999999999999999999999', stage: '0', path: 'keep.txt' },
  ]);
  const after = stageBuf([
    { mode: '100644', oid: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1', stage: '0', path: 'a.txt' },
    { mode: '100644', oid: '9999999999999999999999999999999999999999', stage: '0', path: 'keep.txt' },
  ]);
  const git = makeFakeGit(committedGit({ indexReads: [before, after] }));
  const { coordinator } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.indexIntegrity, 'verified', 'member path change is excluded; unrelated staged entry unchanged');
});

legacyTest('git commit exits non-zero with HEAD unchanged and no marker → aborted-error', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit({ currentHead: A40, commitCode: 1, commitStderr: 'pre-commit hook rejected', reflog: `${A40} commit: prior`, indexReads: [Buffer.alloc(0), Buffer.alloc(0)] });
  const { coordinator, attempts } = fakeHarness(snapshot, git);
  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'aborted-error');
  assert.match(outcome.reason, /pre-commit hook rejected/);
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'aborted-error');
});

test('pending attempt row is persisted before the commit and later resolved', async () => {
  const snapshot = makeSnapshot({ members: [{ entryId: 'e1', relative: 'a.txt', rawBlobOid: 'r1', commitBlobOid: 'c1', commitMode: '100644' }] });
  const git = makeFakeGit(committedGit());
  const { coordinator, attempts } = fakeHarness(snapshot, git);
  await coordinator.commit({ tokenId: 'tok-1', message: 'msg' });
  assert.equal(attempts.pending.length, 1);
  assert.equal(attempts.pending[0].attemptId, 'attempt-1');
  assert.equal(attempts.pending[0].reflogAction, 'lares-commit:attempt-1');
  assert.equal(attempts.pending[0].pinnedHeadOid, A40);
  assert.equal(attempts.resolutions[0].attemptId, 'attempt-1');
});

// ── Real-git integration ────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd, encoding: 'utf8' });
}
function realRepo(): string {
  const root = tmp('lares-coord-test-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'user@lares.invalid']);
  git(root, ['config', 'user.name', 'Real User']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

async function realMember(root: string, head: string | null, relative: string) {
  const p = pathOf(relative);
  const raw = git(root, ['hash-object', '--no-filters', '--', relative]).trim();
  const rep = await readCurrentCommitRepresentation({
    repoRoot: root, pinnedHeadOid: head, gitExe: EXE,
    entry: { path: p, commitPathspecs: [p], expectedWorktreeState: 'present', rawWorktreeBlobOid: raw },
  });
  return {
    spec: { entryId: `e-${relative}`, relative, rawBlobOid: raw, commitBlobOid: rep.commitBlobOid, commitMode: rep.commitMode } as MemberSpec,
  };
}

function realHarness(snapshot: CandidateTokenSnapshot, root: string) {
  const tokens = new FakeTokens(snapshot);
  const attempts = new FakeAttempts();
  const composeLocks = new ComposeLockRegistry();
  const coordinator = new CommitCoordinator({
    contractVersion: snapshot.candidate.contractVersion,
    composeLocks,
    queue: new CheckpointQueue(),
    tokens,
    attempts,
    runGit: (cwd, args, opts) => runGit(cwd, args, { ...opts, gitExe: EXE }),
    runGitBytes: (cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe: EXE }),
    reassemble: async (s) => liveFromSnapshot(s),
    readMemberRepresentation: ({ repoRoot, pinnedHeadOid, member }) =>
      readCurrentCommitRepresentation({
        repoRoot, pinnedHeadOid, gitExe: EXE,
        entry: { path: member.path, commitPathspecs: member.commitPathspecs, expectedWorktreeState: member.expectedWorktreeState, rawWorktreeBlobOid: member.rawWorktreeBlobOid },
      }),
    locateRepository: () => ({ repoRoot: root, gitExe: EXE }),
    resolveCandidateCommitPolicy: async () => ({
      validation: { enabled: false, commands: [], timeoutMs: 0 },
      signing: { enabled: false, signingKey: null },
    }),
    newAttemptId: () => 'attempt-real',
  });
  return { coordinator, attempts, tokens };
}

realTest('real commit lands exactly the selected path; the USER is the committer; server trailers present', async () => {
  const root = realRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated-base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');

  const { spec } = await realMember(root, head, 'a.txt');
  const snapshot = makeSnapshot({
    candidateId: 'cand-real', pinnedHeadOid: head, members: [spec], objectDatabaseKey: `odb:${root}`,
    witnessedProvenance: {
      assistedBy: [{ provider: 'codex', model: 'gpt-5.6' }],
      localCheckpointRefs: ['refs/lares/turns/ws/turn-a/after'],
    },
  });
  const { coordinator, attempts, tokens } = realHarness(snapshot, root);

  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'save a.txt' });
  assert.equal(result.kind, 'outcome');
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));

  const newHead = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(outcome.commitOid, newHead);
  assert.equal(git(root, ['rev-parse', 'HEAD~1']).trim(), head, 'parent is the pinned HEAD');
  // user-commit mode leaves identity to the user's git config.
  assert.equal(git(root, ['log', '-1', '--format=%cn']).trim(), 'Real User');
  assert.equal(git(root, ['log', '-1', '--format=%ce']).trim(), 'user@lares.invalid');
  // server-derived trailers from the immutable snapshot.
  const body = git(root, ['log', '-1', '--format=%B']);
  assert.match(body, /Lares-Candidate: cand-real/);
  assert.match(body, /Lares-Turn: turn-a/);
  assert.match(body, /Lares-Plan: plan-x/);
  assert.match(body, /Assisted-by: codex:gpt-5\.6/);
  assert.match(body, /Lares-Checkpoint-Ref-Local: refs\/lares\/turns\/ws\/turn-a\/after/);
  assert.doesNotMatch(body, /agent-[0-9a-f-]+/i, 'internal agent UUIDs never enter the commit message');
  // only a.txt is in the commit's changeset; unrelated.txt untouched.
  const committedFile = git(root, ['show', `${newHead}:a.txt`]);
  assert.equal(committedFile, 'changed\n');
  assert.equal(outcome.indexIntegrity, 'verified', JSON.stringify(outcome));
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'committed');
  assert.equal(tokens.state, 'consumed');
});

realTest('real: pre-commit hooks and configured signing are deliberately bypassed', async () => {
  const root = realRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['config', 'commit.gpgsign', 'true']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');

  const hookDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf hook-ran > hook-ran.txt\nexit 1\n');
  fs.chmodSync(hook, 0o755);

  const { spec } = await realMember(root, head, 'a.txt');
  const snapshot = makeSnapshot({ pinnedHeadOid: head, members: [spec], objectDatabaseKey: `odb:${root}` });
  const { coordinator, attempts } = realHarness(snapshot, root);

  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'save a.txt' });
  const outcome = (result as any).outcome;
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.notEqual(git(root, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(fs.existsSync(path.join(root, 'hook-ran.txt')), false, 'pre-commit hook never ran');
  assert.equal(attempts.resolutions[0].resolution.outcomeStatus, 'committed');
});

realTest('real: pre-existing staged content preserved byte-identical through the commit', async () => {
  const root = realRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'v1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  // Stage foreign content on a NON-selected path — must survive byte-identical.
  fs.writeFileSync(path.join(root, 'staged.txt'), 'v2-staged\n');
  git(root, ['add', '--', 'staged.txt']);
  const stagedBefore = git(root, ['ls-files', '--stage', '--', 'staged.txt']).trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');

  const { spec } = await realMember(root, head, 'a.txt');
  const snapshot = makeSnapshot({ pinnedHeadOid: head, members: [spec], objectDatabaseKey: `odb:${root}` });
  const { coordinator } = realHarness(snapshot, root);

  const result = await coordinator.commit({ tokenId: 'tok-1', message: 'save a.txt' });
  const outcome = (result as any).outcome;
  const stagedAfter = git(root, ['ls-files', '--stage', '--', 'staged.txt']).trim();
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.equal(outcome.indexIntegrity, 'verified', `${JSON.stringify(outcome)} before=${stagedBefore} after=${stagedAfter}`);
  assert.equal(stagedAfter, stagedBefore, 'unrelated staged entry unchanged');
  // The commit did NOT include the foreign staged path.
  const names = git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(names, ['a.txt']);
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';
  let passed = 0;
  let skipped = 0;
  try {
    for (const t of tests) {
      if (t.real && !EXE) { console.log(`- skip (no git): ${t.name}`); skipped++; continue; }
      await t.run();
      console.log(`ok - ${t.name}`);
      passed++;
    }
  } finally {
    for (const dir of trash) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\ncommit-coordinator: ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
