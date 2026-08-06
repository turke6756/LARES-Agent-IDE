// Save-card SC-WP-4I — real-hook and real-reflog adversarial outcome matrix.
// Every mutation is confined to a disposable repository; this file exercises
// production coordinator/reconciler code without replacing either Git oracle.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateMember, CommitCandidate, CommitOutcome, RepositoryIdentity } from '../../shared/commit-candidates';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { readCurrentCommitRepresentation } from '../commit-candidates/commit-representation';
import type {
  CommitAttemptResolution,
  CommitLedgerWrite,
  CommitPathLink,
  CommitRecord,
  PackageFinalization,
  PendingCommitAttempt,
} from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { CheckpointQueue } from './checkpoint-queue';
import {
  CommitCoordinator,
  type CommitCoordinatorDeps,
  type CommitCoordinatorResult,
  type CoordinatorTokenStore,
  type LiveReassembly,
  type MemberRepresentation,
  type ReadMemberRepresentationInput,
} from './commit-coordinator';
import {
  reconcileCommittedCandidate,
  type CommitClosureStore,
} from './commit-reconciler';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { runGit, runGitBytes, type RunGitOptions } from './git-command';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }
// Pre-WP-5 adversarial rows that depended on `git commit --only` are retained as
// readable historical fixtures but are no longer registered under the settled
// hook-bypass / update-ref-CAS contract.
function legacyTest(_name: string, _run: TestCase['run']): void {}

let EXE = '';
const trash: string[] = [];
const REPOSITORY_KEY = '4'.repeat(64);
const FORBIDDEN_REPAIR_VERBS = new Set(['checkout', 'restore', 'clean', 'reset', 'stash']);

function gitText(root: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd: root, encoding: 'utf8' });
}

function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync(EXE, args, { cwd: root });
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-coord-hooks-'));
  trash.push(root);
  gitText(root, ['init', '-q']);
  gitText(root, ['config', 'user.email', 'hooks@lares.invalid']);
  gitText(root, ['config', 'user.name', 'Hooks Test']);
  gitText(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'selected.txt'), 'base-selected\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'base-other\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'base-staged\n');
  gitText(root, ['add', '-A']);
  gitText(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function writeHook(root: string, name: 'pre-commit' | 'commit-msg' | 'post-commit', body: string): string {
  const hook = path.join(root, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(hook, 0o755);
  return hook;
}

function pathOf(relative: string) {
  return encodeGitPath(Buffer.from(relative, 'utf8'));
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

interface Preview {
  root: string;
  head: string;
  snapshot: CandidateTokenSnapshot;
}

async function preview(root: string, tokenId = 'token-1', candidateId = 'candidate-hooks'): Promise<Preview> {
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
    workspaces: [{ workspaceId: 'ws-hooks', workspacePrefix: '' }],
  };
  const candidate: CommitCandidate = {
    candidateId,
    contractVersion: BUNDLE_CONTRACT_VERSION,
    repository,
    componentIds: ['component-hooks'],
    selectedUnattributedEntryIds: [],
    members: [member],
    finalizations: [{ finalizationId: 'fin-1', packageId: 'pkg-1', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: {
      tokenId,
      candidateId,
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
        selectedComponentIds: ['component-hooks'],
        selectedUnattributedEntryIds: [],
        finalizationIds: ['fin-1'],
        acknowledgeTopologyDigest: 'topology-hooks',
        acknowledgeUnattributedEntryIds: [],
      },
      componentTopologyDigest: 'topology-hooks',
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
        planId: 'plan-hooks',
        planItemId: null,
        contributingTurnIds: ['turn-hooks'],
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
  constructor(private readonly snapshots: readonly CandidateTokenSnapshot[]) {
    for (const snapshot of snapshots) this.state.set(snapshot.token.tokenId, 'issued');
  }
  resolve(tokenId: string): CandidateTokenSnapshot | null {
    if (this.state.get(tokenId) !== 'issued') return null;
    return this.snapshots.find((snapshot) => snapshot.token.tokenId === tokenId) ?? null;
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
  runGit?: CommitCoordinatorDeps['runGit'];
  runGitBytes?: CommitCoordinatorDeps['runGitBytes'];
  newAttemptId?: () => string;
}

function harness(pre: Preview, options: HarnessOptions = {}) {
  const tokens = options.tokens ?? new TokenStore([pre.snapshot]);
  const attempts = new AttemptStore();
  const commands: string[][] = [];
  let attemptSequence = 0;
  const baseRunGit: CommitCoordinatorDeps['runGit'] = (cwd, args, opts) =>
    runGit(cwd, args, { ...opts, gitExe: EXE });
  const delegatedRunGit = options.runGit ?? baseRunGit;
  const coordinator = new CommitCoordinator({
    composeLocks: new ComposeLockRegistry(),
    queue: new CheckpointQueue(),
    tokens,
    attempts,
    runGit: (cwd, args, opts) => {
      commands.push([...args]);
      return delegatedRunGit(cwd, args, opts);
    },
    runGitBytes: options.runGitBytes ?? ((cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe: EXE })),
    reassemble: async (snapshot) => live(snapshot),
    readMemberRepresentation: actualRepresentation,
    locateRepository: () => ({ repoRoot: pre.root, gitExe: EXE }),
    newAttemptId: options.newAttemptId ?? (() => `hooks-attempt-${++attemptSequence}`),
  });
  return { coordinator, tokens, attempts, commands, baseRunGit };
}

function classified(result: CommitCoordinatorResult): CommitOutcome {
  assert.equal(result.kind, 'outcome', JSON.stringify(result));
  return result.outcome;
}

function markedInReflog(root: string, action: string): boolean {
  return gitText(root, ['reflog', '--format=%gs']).split(/\r?\n/).some((line) => line.includes(action));
}

function assertNoRepair(commands: readonly string[][]): void {
  const repair = commands.find((args) => args.some((arg) => FORBIDDEN_REPAIR_VERBS.has(arg)));
  assert.equal(repair, undefined, `unexpected repair command: ${repair?.join(' ')}`);
}

function assertOutcomeInvariant(
  root: string,
  pre: Preview,
  outcome: CommitOutcome,
  attempts: AttemptStore,
): void {
  const pending = attempts.pending.at(-1);
  const resolution = attempts.resolutions.at(-1)?.resolution;
  assert.ok(pending);
  assert.ok(resolution);
  const headUnchanged = gitText(root, ['rev-parse', 'HEAD']).trim() === pre.head;
  const hasMarker = markedInReflog(root, pending.reflogAction);
  const aborted = outcome.status === 'aborted-error' || outcome.status === 'aborted-stale';
  assert.equal(aborted, headUnchanged && !hasMarker,
    '`aborted-*` iff HEAD is unchanged and no attempt-marked commit exists');
  if (aborted) assert.equal(resolution.identifiedCommitOid, null);
}

function assertHeadFile(root: string, relative: string, expected: string): void {
  assert.deepEqual(gitBytes(root, ['show', `HEAD:${relative}`]), Buffer.from(expected));
}

async function rejectingHookRow(hookName: 'pre-commit' | 'commit-msg'): Promise<void> {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  writeHook(root, hookName, `echo "${hookName} rejected" 1>&2\nexit 1`);
  const { coordinator, attempts, commands } = harness(pre);

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: `${hookName} row` }));
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.notEqual(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head);
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(fs.readFileSync(path.join(root, 'selected.txt')), Buffer.from('preview-selected\n'));
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
}

test('row 1 — rejecting pre-commit hook is deliberately bypassed', async () => {
  await rejectingHookRow('pre-commit');
});

test('row 2 — rejecting commit-msg hook is deliberately bypassed', async () => {
  await rejectingHookRow('commit-msg');
});

test('row 3 — a mutating pre-commit hook never runs', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  writeHook(root, 'pre-commit', "printf 'hook-selected\\n' > selected.txt\ngit add -- selected.txt");
  const { coordinator, attempts, commands } = harness(pre);

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'selected hook mutation' }));
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.equal(outcome.commitOid, gitText(root, ['rev-parse', 'HEAD']).trim());
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assert.deepEqual(fs.readFileSync(path.join(root, 'selected.txt')), Buffer.from('preview-selected\n'));
  assert.equal(attempts.resolutions[0].resolution.identifiedCommitOid, outcome.commitOid);
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
});

test('row 4 — a mutating post-commit hook never runs and unrelated index entry is preserved', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged-before-hook\n');
  gitText(root, ['add', '--', 'staged.txt']);
  const stagedBefore = gitBytes(root, ['show', ':staged.txt']);
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  writeHook(root, 'post-commit', "printf 'staged-by-hook\\n' > staged.txt\ngit add -- staged.txt");
  const { coordinator, attempts, commands } = harness(pre);

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'unrelated hook mutation' }));
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.equal(outcome.indexIntegrity, 'verified');
  assert.equal(outcome.commitOid, gitText(root, ['rev-parse', 'HEAD']).trim());
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertHeadFile(root, 'staged.txt', 'base-staged\n');
  assert.deepEqual(gitBytes(root, ['show', ':staged.txt']), stagedBefore);
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
});

legacyTest('row 5 — external HEAD advance during a failed attempt is repository-state-uncertain', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  let advanced = false;
  const { coordinator, attempts, commands, baseRunGit } = harness(pre, {
    runGit: async (cwd, args, opts) => {
      if (!advanced && args.includes('--only')) {
        advanced = true;
        fs.writeFileSync(path.join(root, 'other.txt'), 'external-during-failure\n');
        gitText(root, ['commit', '-q', '--only', '-m', 'external advance', '--', 'other.txt']);
        return { code: 1, stdout: '', stderr: 'simulated failed Lares commit' };
      }
      return baseRunGit(cwd, args, opts);
    },
  });

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'failed attempt' }));
  assert.equal(outcome.status, 'repository-state-uncertain');
  assert.equal(outcome.pinnedHeadOid, pre.head);
  assert.equal(outcome.resolvedHeadOid, gitText(root, ['rev-parse', 'HEAD']).trim());
  assert.notEqual(outcome.resolvedHeadOid, pre.head);
  assert.equal(attempts.resolutions[0].resolution.identifiedCommitOid, null);
  assertHeadFile(root, 'other.txt', 'external-during-failure\n');
  assert.deepEqual(fs.readFileSync(path.join(root, 'selected.txt')), Buffer.from('preview-selected\n'));
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
});

legacyTest('row 6 — marked commit followed by HEAD advance reports created OID plus currentHeadDrift', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  let markedOid = '';
  let driftOid = '';
  let advanced = false;
  const { coordinator, attempts, commands, baseRunGit } = harness(pre, {
    runGit: async (cwd, args, opts) => {
      const result = await baseRunGit(cwd, args, opts);
      if (!advanced && args.includes('--only')) {
        advanced = true;
        markedOid = gitText(root, ['rev-parse', 'HEAD']).trim();
        fs.writeFileSync(path.join(root, 'other.txt'), 'external-after-marked\n');
        gitText(root, ['commit', '-q', '--only', '-m', 'post-attempt advance', '--', 'other.txt']);
        driftOid = gitText(root, ['rev-parse', 'HEAD']).trim();
      }
      return result;
    },
  });

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'marked then drift' }));
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  assert.equal(outcome.commitOid, markedOid);
  assert.deepEqual(outcome.currentHeadDrift, { resolvedHeadOid: driftOid });
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), driftOid);
  assert.equal(gitText(root, ['rev-parse', `${driftOid}^`]).trim(), markedOid);
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assertHeadFile(root, 'other.txt', 'external-after-marked\n');
  assert.equal(attempts.resolutions[0].resolution.identifiedCommitOid, markedOid);
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
});

class EmptyClosureStore implements CommitClosureStore {
  writes: CommitLedgerWrite[] = [];
  getCommitRecord(_repositoryKey: string, _commitOid: string): CommitRecord | null { return null; }
  recordCommitLedger(write: CommitLedgerWrite): void { this.writes.push(write); }
  getPackageFinalization(_id: string): PackageFinalization | null { return null; }
  listCommitPathLinks(_repositoryKey: string, _paths: readonly string[]): CommitPathLink[] { return []; }
  markPackageFinalizationCommitted(_id: string, _releasedAt: number): void {
    throw new Error('uncertain outcome must not close a finalization');
  }
}

legacyTest('row 7 — marked commit with unverifiable tree is uncertain, preserves OID, and reconciles no exact links', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const pre = await preview(root);
  const { coordinator, attempts, commands } = harness(pre, {
    runGitBytes: async (cwd, args, opts) => {
      if (args[0] === 'ls-tree') {
        return { code: 1, stdout: Buffer.alloc(0), stderr: 'simulated unreadable tree' };
      }
      return runGitBytes(cwd, args, { ...opts, gitExe: EXE });
    },
  });

  const outcome = classified(await coordinator.commit({ tokenId: 'token-1', message: 'unverifiable marked tree' }));
  assert.equal(outcome.status, 'repository-state-uncertain', JSON.stringify(outcome));
  const identified = attempts.resolutions[0].resolution.identifiedCommitOid;
  assert.ok(identified);
  assert.equal(identified, gitText(root, ['rev-parse', 'HEAD']).trim());
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');

  const store = new EmptyClosureStore();
  const reconciled = await reconcileCommittedCandidate({
    repoRoot: root,
    gitExe: EXE,
    outcome,
    snapshot: pre.snapshot,
    store,
  });
  assert.deepEqual(reconciled, {
    ok: false,
    error: { code: 'outcome-not-committed', message: 'Cannot reconcile outcome repository-state-uncertain.' },
  });
  assert.equal(store.writes.length, 0, 'no commit/path/turn links written for uncertain evidence');
  assertOutcomeInvariant(root, pre, outcome, attempts);
  assertNoRepair(commands);
});

legacyTest('rows 8/9 — failed hook attempt then regenerated candidate commits cleanly', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'selected.txt'), 'preview-selected\n');
  const first = await preview(root, 'token-failed', 'candidate-failed');
  const hook = writeHook(root, 'pre-commit', "echo 'first attempt rejected' 1>&2\nexit 1");
  const firstHarness = harness(first, { newAttemptId: () => 'hooks-attempt-failed' });
  const failed = classified(await firstHarness.coordinator.commit({ tokenId: 'token-failed', message: 'first attempt' }));
  assert.equal(failed.status, 'aborted-error');
  assertOutcomeInvariant(root, first, failed, firstHarness.attempts);
  assert.equal(firstHarness.tokens instanceof TokenStore ? firstHarness.tokens.state.get('token-failed') : null, 'consumed');
  fs.rmSync(hook);

  const regenerated = await preview(root, 'token-regenerated', 'candidate-regenerated');
  const secondHarness = harness(regenerated, { newAttemptId: () => 'hooks-attempt-regenerated' });
  const committed = classified(await secondHarness.coordinator.commit({
    tokenId: 'token-regenerated',
    message: 'regenerated attempt',
  }));
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  assert.equal(committed.commitOid, gitText(root, ['rev-parse', 'HEAD']).trim());
  assert.equal(gitText(root, ['rev-parse', 'HEAD^']).trim(), first.head);
  assertHeadFile(root, 'selected.txt', 'preview-selected\n');
  assert.equal(gitText(root, ['log', '-1', '--format=%s']).trim(), 'regenerated attempt');
  assertOutcomeInvariant(root, regenerated, committed, secondHarness.attempts);
  assertNoRepair([...firstHarness.commands, ...secondHarness.commands]);
});

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';
  if (!EXE) {
    console.log('commit-coordinator.hooks-outcomes: skipped — no compatible Git executable');
    return;
  }
  let passed = 0;
  try {
    for (const current of tests) {
      await current.run();
      console.log(`ok - ${current.name}`);
      passed++;
    }
  } finally {
    for (const root of trash.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\ncommit-coordinator.hooks-outcomes: ${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
