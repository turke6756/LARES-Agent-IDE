// Save-card SC-WP-4H — adversarial races against the public 4D coordinator.
// Every case uses a disposable repository and asserts both the classified result
// and the resulting worktree/index bytes. No race runs against the workspace repo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CommitCoordinator,
  type CommitCoordinatorDeps,
  type CommitCoordinatorResult,
  type CoordinatorTokenStore,
  type LiveReassembly,
  type MemberRepresentation,
  type ReadMemberRepresentationInput,
} from './commit-coordinator';
import { CheckpointQueue } from './checkpoint-queue';
import { runGit, runGitBytes, type RunGitOptions } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { readCurrentCommitRepresentation } from '../commit-candidates/commit-representation';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type { CandidateMember, CommitCandidate, CommitOutcome, RepositoryIdentity } from '../../shared/commit-candidates';
import type { CommitAttemptResolution, PendingCommitAttempt } from '../database';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let EXE = '';
const trash: string[] = [];
const REPOSITORY_KEY = 'r'.repeat(64);

function gitText(root: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd: root, encoding: 'utf8' });
}

function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync(EXE, args, { cwd: root });
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-coord-race-'));
  trash.push(root);
  gitText(root, ['init', '-q']);
  gitText(root, ['config', 'user.email', 'races@lares.invalid']);
  gitText(root, ['config', 'user.name', 'Race Test']);
  gitText(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'selected.txt'), 'base-selected\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'base-other\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'base-staged\n');
  gitText(root, ['add', '-A']);
  gitText(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function indexBytes(root: string): Buffer {
  return gitBytes(root, ['ls-files', '--stage', '-z']);
}

function pathOf(relative: string) {
  return encodeGitPath(Buffer.from(relative, 'utf8'));
}

interface Preview {
  root: string;
  head: string;
  snapshot: CandidateTokenSnapshot;
}

function candidateMember(
  relative: string,
  rawBlobOid: string,
  commitBlobOid: string | null,
  commitMode: string | null,
): CandidateMember {
  return {
    entryId: `entry-${relative}`,
    path: pathOf(relative),
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: rawBlobOid,
    expectedCommitBlobOid: commitBlobOid,
    expectedCommitMode: commitMode,
    checkpointMode: commitMode,
    coveringFinalizationIds: ['fin-1'],
    packageVerification: 'verified-match',
    protection: 'checkpoint-protected',
  };
}

async function preview(root: string, tokenId = 'token-1'): Promise<Preview> {
  const head = gitText(root, ['rev-parse', 'HEAD']).trim();
  const relative = 'selected.txt';
  const encoded = pathOf(relative);
  const rawBlobOid = gitText(root, ['hash-object', '--no-filters', '--', relative]).trim();
  const rep = await readCurrentCommitRepresentation({
    repoRoot: root,
    pinnedHeadOid: head,
    gitExe: EXE,
    entry: {
      path: encoded,
      commitPathspecs: [encoded],
      expectedWorktreeState: 'present',
      rawWorktreeBlobOid: rawBlobOid,
    },
  });
  const member = candidateMember(relative, rawBlobOid, rep.commitBlobOid, rep.commitMode);
  const repository: RepositoryIdentity = {
    repositoryKey: REPOSITORY_KEY,
    objectDatabaseKey: `odb:${root}`,
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
  const candidate: CommitCandidate = {
    candidateId: 'candidate-race',
    contractVersion: BUNDLE_CONTRACT_VERSION,
    repository,
    componentIds: ['component-1'],
    selectedUnattributedEntryIds: [],
    members: [member],
    finalizations: [{ finalizationId: 'fin-1', packageId: 'pkg-1', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: {
      tokenId,
      candidateId: 'candidate-race',
      contractVersion: BUNDLE_CONTRACT_VERSION,
      issuedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  };
  return {
    root,
    head,
    snapshot: {
      token: candidate.token!,
      candidate,
      repositoryKey: REPOSITORY_KEY,
      normalizedRequest: {
        selectedComponentIds: ['component-1'],
        selectedUnattributedEntryIds: [],
        finalizationIds: ['fin-1'],
        acknowledgeTopologyDigest: 'topology-race',
        acknowledgeUnattributedEntryIds: [],
      },
      componentTopologyDigest: 'topology-race',
      pinnedHeadOid: head,
      indexFingerprint: 'preview-index-fingerprint',
      indexWriteTreeOid: null,
      commitEffects: [{
        pathBytesBase64: member.path.pathBytesBase64,
        operation: 'write',
        expectedState: 'present',
        rawBlobOid: member.rawWorktreeBlobOid,
        commitBlobOid: member.expectedCommitBlobOid,
        commitMode: member.expectedCommitMode,
      }],
      finalizationManifests: [],
      associations: [{
        planId: 'plan-race',
        planItemId: null,
        contributingTurnIds: ['turn-preview'],
        memberEntryIds: [member.entryId],
      }],
    },
  };
}

function live(snapshot: CandidateTokenSnapshot): LiveReassembly {
  return {
    candidateId: snapshot.candidate.candidateId,
    componentTopologyDigest: snapshot.componentTopologyDigest,
    eligible: true,
    ineligibleReason: null,
    pinnedHeadOid: snapshot.pinnedHeadOid,
    members: snapshot.candidate.members.map((member) => ({
      entryId: member.entryId,
      path: member.path,
      commitPathspecs: [member.path],
      expectedWorktreeState: member.expectedWorktreeState,
      rawWorktreeBlobOid: member.rawWorktreeBlobOid,
    })),
  };
}

class TokenStore implements CoordinatorTokenStore {
  readonly state = new Map<string, 'issued' | 'consuming' | 'consumed'>();
  constructor(private readonly snapshots: CandidateTokenSnapshot[]) {
    for (const snapshot of snapshots) this.state.set(snapshot.token.tokenId, 'issued');
  }
  resolve(tokenId: string): CandidateTokenSnapshot | null {
    return this.state.get(tokenId) === 'issued'
      ? this.snapshots.find((snapshot) => snapshot.token.tokenId === tokenId) ?? null
      : null;
  }
  tryConsume(tokenId: string): CandidateTokenSnapshot | null {
    const snapshot = this.resolve(tokenId);
    if (!snapshot) return null;
    this.state.set(tokenId, 'consuming');
    return snapshot;
  }
  markConsumed(tokenId: string): boolean {
    if (this.state.get(tokenId) !== 'consuming') return false;
    this.state.set(tokenId, 'consumed');
    return true;
  }
}

class AttemptStore {
  pending: PendingCommitAttempt[] = [];
  resolutions: Array<{ attemptId: string; resolution: CommitAttemptResolution }> = [];
  insertPending(attempt: PendingCommitAttempt): void { this.pending.push(attempt); }
  resolve(attemptId: string, resolution: CommitAttemptResolution): void {
    this.resolutions.push({ attemptId, resolution });
  }
}

async function actualRepresentation(input: ReadMemberRepresentationInput): Promise<MemberRepresentation> {
  return readCurrentCommitRepresentation({
    repoRoot: input.repoRoot,
    pinnedHeadOid: input.pinnedHeadOid,
    gitExe: EXE,
    entry: {
      path: input.member.path,
      commitPathspecs: input.member.commitPathspecs,
      expectedWorktreeState: input.member.expectedWorktreeState,
      rawWorktreeBlobOid: input.member.rawWorktreeBlobOid,
    },
  });
}

interface HarnessOptions {
  tokens?: CoordinatorTokenStore;
  composeLocks?: ComposeLockRegistry;
  queue?: CheckpointQueue;
  reassemble?: CommitCoordinatorDeps['reassemble'];
  readMemberRepresentation?: CommitCoordinatorDeps['readMemberRepresentation'];
  runGit?: CommitCoordinatorDeps['runGit'];
}

function harness(pre: Preview, options: HarnessOptions = {}) {
  const tokens = options.tokens ?? new TokenStore([pre.snapshot]);
  const composeLocks = options.composeLocks ?? new ComposeLockRegistry();
  const queue = options.queue ?? new CheckpointQueue();
  const attempts = new AttemptStore();
  let attemptSequence = 0;
  const coordinator = new CommitCoordinator({
    composeLocks,
    queue,
    tokens,
    attempts,
    runGit: options.runGit ?? ((cwd, args, opts) => runGit(cwd, args, { ...opts, gitExe: EXE })),
    runGitBytes: (cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe: EXE }),
    reassemble: options.reassemble ?? (async (snapshot) => live(snapshot)),
    readMemberRepresentation: options.readMemberRepresentation ?? actualRepresentation,
    locateRepository: () => ({ repoRoot: pre.root, gitExe: EXE }),
    newAttemptId: () => `race-attempt-${++attemptSequence}`,
  });
  return { coordinator, tokens, composeLocks, queue, attempts };
}

function classified(result: CommitCoordinatorResult): CommitOutcome {
  assert.equal(result.kind, 'outcome', JSON.stringify(result));
  return result.outcome;
}

function assertFile(root: string, relative: string, expected: string): void {
  assert.deepEqual(fs.readFileSync(path.join(root, relative)), Buffer.from(expected));
}

function assertHeadFile(root: string, relative: string, expected: string): void {
  assert.deepEqual(gitBytes(root, ['show', `HEAD:${relative}`]), Buffer.from(expected));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('row 1 — selected path edited after preview aborts stale; raced worktree bytes survive', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  let raced = false;
  const { coordinator } = harness(pre, {
    readMemberRepresentation: async (input) => {
      if (!raced) {
        raced = true;
        fs.writeFileSync(path.join(root, 'selected.txt'), 'agent-race-selected\n');
      }
      return actualRepresentation(input);
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 1' }));
  assert.equal(outcome.status, 'aborted-stale');
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head);
  assertFile(root, 'selected.txt', 'agent-race-selected\n');
  assert.deepEqual(indexBytes(root), indexBefore);
});

test('row 2 — non-selected edit commits exactly previewed selected bytes', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const { coordinator } = harness(pre, {
    reassemble: async (snapshot) => {
      fs.writeFileSync(path.join(root, 'other.txt'), 'agent-race-other\n');
      return live(snapshot);
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 2' }));
  assert.equal(outcome.status, 'committed');
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertHeadFile(root, 'other.txt', 'base-other\n');
  assertFile(root, 'other.txt', 'agent-race-other\n');
  assert.equal(gitText(root, ['diff', '--cached', '--name-only']).trim(), '');
});

test('row 3 — HEAD moves before update-ref CAS; Lares advances nothing and aborts stale', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  let externalHead = '';
  let moved = false;
  const { coordinator } = harness(pre, {
    runGit: async (cwd, args, opts) => {
      if (!moved && args[0] === 'update-ref') {
        moved = true;
        const externalTree = gitText(root, ['rev-parse', `${pre.head}^{tree}`]).trim();
        externalHead = gitText(root, ['commit-tree', externalTree, '-p', pre.head, '-m', 'external']).trim();
        gitText(root, ['update-ref', 'HEAD', externalHead, pre.head]);
      }
      return runGit(cwd, args, { ...opts, gitExe: EXE });
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 3' }));
  assert.equal(outcome.status, 'aborted-stale');
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), externalHead,
    'only the foreign HEAD move landed');
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assertHeadFile(root, 'selected.txt', 'base-selected\n');
  assertHeadFile(root, 'other.txt', 'base-other\n');
  assert.equal(gitText(root, ['diff', '--cached', '--name-only']).trim(), '');
});

test('row 3b — write after final revalidation cannot enter commit and remains dirty', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'reviewed-selected\n');
  const pre = await preview(root);
  let injected = false;
  const { coordinator } = harness(pre, {
    runGit: async (cwd, args, opts) => {
      if (!injected && args[0] === 'read-tree') {
        injected = true;
        fs.writeFileSync(path.join(root, 'selected.txt'), 'concurrent-unreviewed\n');
      }
      return runGit(cwd, args, { ...opts, gitExe: EXE });
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 3b' }));
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.equal(injected, true, 'injection ran after the final representation read');
  assertHeadFile(root, 'selected.txt', 'reviewed-selected\n');
  assertFile(root, 'selected.txt', 'concurrent-unreviewed\n');
  assert.equal(gitText(root, ['status', '--short', '--', 'selected.txt']).trim(), 'M selected.txt');
});

test('row 4 — index mutation after preview changes identity and aborts without repair', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  let racedIndex: Buffer = Buffer.alloc(0);
  const { coordinator } = harness(pre, {
    reassemble: async (snapshot) => {
      fs.writeFileSync(path.join(root, 'other.txt'), 'staged-race\n');
      gitText(root, ['add', '--', 'other.txt']);
      racedIndex = indexBytes(root);
      return { ...live(snapshot), candidateId: 'candidate-after-index-race' };
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 4' }));
  assert.equal(outcome.status, 'aborted-stale');
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head);
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(indexBytes(root), racedIndex);
  assert.deepEqual(gitBytes(root, ['show', ':other.txt']), Buffer.from('staged-race\n'));
});

test('row 5 — active turn starts before confirmation; moved selected bytes abort safely', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  let activeTurnStarted = false;
  const { coordinator } = harness(pre, {
    reassemble: async (snapshot) => {
      activeTurnStarted = true;
      return live(snapshot);
    },
    readMemberRepresentation: async (input) => {
      assert.equal(activeTurnStarted, true);
      fs.writeFileSync(path.join(root, 'selected.txt'), 'active-turn-edit\n');
      return actualRepresentation(input);
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 5' }));
  assert.equal(outcome.status, 'aborted-stale');
  assertFile(root, 'selected.txt', 'active-turn-edit\n');
  assert.deepEqual(indexBytes(root), indexBefore);
});

test('row 6 — restore/revert wins queue race; confirmation revalidates restored bytes', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  const queue = new CheckpointQueue();
  const restoreEntered = deferred();
  const releaseRestore = deferred();
  const restore = queue.withLock(pre.snapshot.candidate.repository.objectDatabaseKey, async () => {
    restoreEntered.resolve();
    await releaseRestore.promise;
    fs.writeFileSync(path.join(root, 'selected.txt'), 'restored-race\n');
  });
  await restoreEntered.promise;
  const { coordinator } = harness(pre, { queue });
  const committing = coordinator.commit({ tokenId: 'token-1', message: 'row 6' });
  releaseRestore.resolve();
  await restore;
  const outcome = classified(await committing);
  assert.equal(outcome.status, 'aborted-stale');
  assertFile(root, 'selected.txt', 'restored-race\n');
  assert.deepEqual(indexBytes(root), indexBefore);
});

test('row 7 — existing index.lock cannot affect reviewed commit bytes; reconciliation is unavailable', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), 'external-lock');
  const commands: string[][] = [];
  const { coordinator } = harness(pre, {
    runGit: async (cwd: string, args: string[], opts: RunGitOptions) => {
      commands.push([...args]);
      return runGit(cwd, args, { ...opts, gitExe: EXE });
    },
  });
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 7' }));
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.status === 'committed' && outcome.indexIntegrity, 'unavailable');
  assert.notEqual(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head);
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(indexBytes(root), indexBefore);
  assert.equal(fs.readFileSync(path.join(root, '.git', 'index.lock'), 'utf8'), 'external-lock');
  const forbidden = new Set(['checkout', 'restore', 'clean', 'reset', 'stash']);
  assert.equal(commands.some((args) => args.some((arg) => forbidden.has(arg))), false);
});

test('row 8 — distinct tokens race on one repository; one commits, one compose-in-flight', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const first = await preview(root, 'token-a');
  const second = await preview(root, 'token-b');
  const tokens = new TokenStore([first.snapshot, second.snapshot]);
  const entered = deferred();
  const release = deferred();
  let firstReassembly = true;
  const { coordinator } = harness(first, {
    tokens,
    reassemble: async (snapshot) => {
      if (firstReassembly) {
        firstReassembly = false;
        entered.resolve();
        await release.promise;
      }
      return live(snapshot);
    },
  });
  const firstCommit = coordinator.commit({ tokenId: 'token-a', message: 'row 8 first' });
  await entered.promise;
  const secondResult = await coordinator.commit({ tokenId: 'token-b', message: 'row 8 second' });
  assert.equal(secondResult.kind, 'compose-in-flight');
  assert.equal(tokens.state.get('token-b'), 'issued');
  release.resolve();
  const firstOutcome = classified(await firstCommit);
  assert.equal(firstOutcome.status, 'committed');
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assert.equal(gitText(root, ['diff', '--cached', '--name-only']).trim(), '');
});

test('row 9 — same-token CAS loss refuses second consume and releases compose lock', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  const losingTokens: CoordinatorTokenStore = {
    resolve: () => pre.snapshot,
    tryConsume: () => null,
    markConsumed: () => false,
  };
  const composeLocks = new ComposeLockRegistry();
  const { coordinator } = harness(pre, { tokens: losingTokens, composeLocks });
  const result = await coordinator.commit({ tokenId: 'token-1', message: 'row 9' });
  assert.equal(result.kind, 'token-unresolved');
  assert.equal(composeLocks.isHeld(REPOSITORY_KEY), false);
  const proof = composeLocks.tryAcquire(REPOSITORY_KEY);
  assert.ok(proof, 'CAS-loss path released the lock synchronously');
  proof.release();
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(indexBytes(root), indexBefore);
});

test('row 10 — pre-CAS compose transient leaves token issued and retry commits', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const indexBefore = indexBytes(root);
  const tokens = new TokenStore([pre.snapshot]);
  const composeLocks = new ComposeLockRegistry();
  const held = composeLocks.tryAcquire(REPOSITORY_KEY)!;
  const { coordinator } = harness(pre, { tokens, composeLocks });
  const transient = await coordinator.commit({ tokenId: 'token-1', message: 'row 10 transient' });
  assert.equal(transient.kind, 'compose-in-flight');
  assert.equal(tokens.state.get('token-1'), 'issued');
  assertFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(indexBytes(root), indexBefore);
  held.release();
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 10 retry' }));
  assert.equal(outcome.status, 'committed');
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assert.equal(gitText(root, ['diff', '--cached', '--name-only']).trim(), '');
});

test('row 11 — pre-existing staged content survives byte-identical through commit', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'staged.txt'), 'foreign-staged-bytes\n');
  gitText(root, ['add', '--', 'staged.txt']);
  const stagedEntryBefore = gitBytes(root, ['ls-files', '--stage', '-z', '--', 'staged.txt']);
  const stagedBlobBefore = gitBytes(root, ['show', ':staged.txt']);
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const { coordinator } = harness(pre);
  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'row 11' }));
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.indexIntegrity, 'verified');
  assert.deepEqual(gitBytes(root, ['ls-files', '--stage', '-z', '--', 'staged.txt']), stagedEntryBefore);
  assert.deepEqual(gitBytes(root, ['show', ':staged.txt']), stagedBlobBefore);
  assertFile(root, 'staged.txt', 'foreign-staged-bytes\n');
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertHeadFile(root, 'staged.txt', 'base-staged\n');
  const names = gitText(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(names, ['selected.txt']);
});

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';
  if (!EXE) {
    console.log('commit-coordinator.races: skipped — no compatible Git executable');
    return;
  }
  let passed = 0;
  try {
    for (const item of tests) {
      await item.run();
      console.log(`ok - ${item.name}`);
      passed++;
    }
  } finally {
    for (const root of trash.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\ncommit-coordinator.races: ${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
