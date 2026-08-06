// Save-card SC-WP-4J — real-repository path-semantics adversarial matrix.
// Every mutation is confined to a disposable repository. Supported filesystem
// shapes must land the previewed blob/mode exactly; an unrepresentable host shape
// is reported as an explicit, reason-bearing skip.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CommitCoordinator,
  type CommitCoordinatorResult,
  type CoordinatorTokenStore,
  type LiveMember,
  type LiveReassembly,
  type MemberRepresentation,
  type ReadMemberRepresentationInput,
} from './commit-coordinator';
import { CheckpointQueue } from './checkpoint-queue';
import { runGit, runGitBytes } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { readCurrentCommitRepresentation } from '../commit-candidates/commit-representation';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type { CandidateMember, CommitCandidate, CommitOutcome, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';
import type { CommitAttemptResolution, PendingCommitAttempt } from '../database';

interface Skip { skip: string; }
interface TestCase { name: string; run(): Promise<void | Skip>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }
function honestSkip(reason: string): Skip {
  assert.ok(reason.trim().length >= 20, 'an honest skip must state a specific host limitation');
  return { skip: reason };
}

let EXE = '';
const trash: string[] = [];
const REPOSITORY_KEY = '4'.repeat(64);

function temp(prefix = 'lares-coord-path-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(root);
  return root;
}
function gitText(root: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd: root, encoding: 'utf8' });
}
function gitBytes(root: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(EXE, args, { cwd: root, input });
}
function encoded(relative: string): EncodedGitPath {
  return encodeGitPath(Buffer.from(relative, 'utf8'));
}
function repo(files: Record<string, Buffer | string> = { 'base.txt': 'base\n' }): string {
  const root = temp();
  gitText(root, ['init', '-q']);
  gitText(root, ['config', 'user.email', 'paths@lares.invalid']);
  gitText(root, ['config', 'user.name', 'Path Semantics Test']);
  gitText(root, ['config', 'commit.gpgsign', 'false']);
  gitText(root, ['config', 'core.autocrlf', 'false']);
  for (const [relative, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes);
  }
  gitText(root, ['add', '-A']);
  gitText(root, ['commit', '-q', '-m', 'base']);
  return root;
}

interface MemberInput {
  entryId: string;
  relative: string;
  state?: 'present' | 'absent';
  pathspecs?: string[];
  rawBlobOid?: string | null;
}
interface Preview {
  root: string;
  head: string;
  snapshot: CandidateTokenSnapshot;
  liveMembers: LiveMember[];
  expected: Map<string, { state: 'present' | 'absent'; oid: string | null; mode: string | null }>;
}

async function preview(root: string, inputs: MemberInput[], tokenId = 'token-paths'): Promise<Preview> {
  const head = gitText(root, ['rev-parse', 'HEAD']).trim();
  const members: CandidateMember[] = [];
  const liveMembers: LiveMember[] = [];
  const expected = new Map<string, { state: 'present' | 'absent'; oid: string | null; mode: string | null }>();
  for (const input of inputs) {
    const state = input.state ?? 'present';
    const memberPath = encoded(input.relative);
    const commitPathspecs = (input.pathspecs ?? [input.relative]).map(encoded);
    const rawBlobOid = input.rawBlobOid !== undefined
      ? input.rawBlobOid
      : state === 'absent'
        ? null
        : gitText(root, ['hash-object', '--no-filters', '--', input.relative]).trim();
    const rep = await readCurrentCommitRepresentation({
      repoRoot: root,
      pinnedHeadOid: head,
      gitExe: EXE,
      entry: { path: memberPath, commitPathspecs, expectedWorktreeState: state, rawWorktreeBlobOid: rawBlobOid },
    });
    members.push({
      entryId: input.entryId,
      path: memberPath,
      expectedWorktreeState: state,
      rawWorktreeBlobOid: rawBlobOid,
      expectedCommitBlobOid: rep.commitBlobOid,
      expectedCommitMode: rep.commitMode,
      checkpointMode: rep.commitMode,
      coveringFinalizationIds: ['fin-paths'],
      packageVerification: 'verified-match',
      protection: 'checkpoint-protected',
    });
    liveMembers.push({
      entryId: input.entryId,
      path: memberPath,
      commitPathspecs,
      expectedWorktreeState: state,
      rawWorktreeBlobOid: rawBlobOid,
    });
    expected.set(input.relative, { state, oid: rep.commitBlobOid, mode: rep.commitMode });
  }
  const repository: RepositoryIdentity = {
    repositoryKey: REPOSITORY_KEY,
    objectDatabaseKey: `odb:${root}`,
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-paths', workspacePrefix: '' }],
  };
  const candidate: CommitCandidate = {
    candidateId: 'candidate-paths',
    contractVersion: BUNDLE_CONTRACT_VERSION,
    repository,
    componentIds: ['component-ab', 'component-bc'],
    selectedUnattributedEntryIds: [],
    members,
    finalizations: [{ finalizationId: 'fin-paths', packageId: 'pkg-paths', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true },
    token: {
      tokenId,
      candidateId: 'candidate-paths',
      contractVersion: BUNDLE_CONTRACT_VERSION,
      issuedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  };
  const memberByPath = new Map(members.map((member) => [member.path.pathBytesBase64, member]));
  const effectPaths = new Map<string, EncodedGitPath>();
  for (const liveMember of liveMembers) {
    for (const pathspec of liveMember.commitPathspecs) effectPaths.set(pathspec.pathBytesBase64, pathspec);
  }
  const commitEffects = [...effectPaths.values()].map((effectPath) => {
    const member = memberByPath.get(effectPath.pathBytesBase64);
    if (member) {
      return {
        pathBytesBase64: effectPath.pathBytesBase64,
        operation: member.expectedWorktreeState === 'absent' ? 'delete' as const : 'write' as const,
        expectedState: member.expectedWorktreeState,
        rawBlobOid: member.rawWorktreeBlobOid,
        commitBlobOid: member.expectedCommitBlobOid,
        commitMode: member.expectedCommitMode,
      };
    }
    return {
      pathBytesBase64: effectPath.pathBytesBase64,
      operation: 'delete' as const,
      expectedState: 'absent' as const,
      rawBlobOid: null,
      commitBlobOid: null,
      commitMode: null,
    };
  });
  return {
    root,
    head,
    liveMembers,
    expected,
    snapshot: {
      token: candidate.token!,
      candidate,
      repositoryKey: REPOSITORY_KEY,
      normalizedRequest: {
        selectedComponentIds: [...candidate.componentIds],
        selectedUnattributedEntryIds: [],
        finalizationIds: ['fin-paths'],
        acknowledgeTopologyDigest: 'topology-paths',
        acknowledgeUnattributedEntryIds: [],
      },
      componentTopologyDigest: 'topology-paths',
      pinnedHeadOid: head,
      indexFingerprint: 'path-preview-index',
      indexWriteTreeOid: null,
      commitEffects,
      finalizationManifests: [],
      associations: [{
        planId: 'plan-paths',
        planItemId: null,
        contributingTurnIds: ['turn-paths'],
        memberEntryIds: members.map((member) => member.entryId),
      }],
    },
  };
}

function live(pre: Preview): LiveReassembly {
  return {
    candidateId: pre.snapshot.candidate.candidateId,
    componentTopologyDigest: pre.snapshot.componentTopologyDigest,
    eligible: true,
    ineligibleReason: null,
    pinnedHeadOid: pre.head,
    members: pre.liveMembers,
  };
}

class TokenStore implements CoordinatorTokenStore {
  state: 'issued' | 'consuming' | 'consumed' = 'issued';
  constructor(private readonly snapshot: CandidateTokenSnapshot | null) {}
  resolve(tokenId: string): CandidateTokenSnapshot | null {
    return this.state === 'issued' && this.snapshot?.token.tokenId === tokenId ? this.snapshot : null;
  }
  tryConsume(tokenId: string): CandidateTokenSnapshot | null {
    const value = this.resolve(tokenId);
    if (value) this.state = 'consuming';
    return value;
  }
  markConsumed(tokenId: string): boolean {
    if (this.state !== 'consuming' || this.snapshot?.token.tokenId !== tokenId) return false;
    this.state = 'consumed';
    return true;
  }
}

class AttemptStore {
  pending: PendingCommitAttempt[] = [];
  resolutions: Array<{ attemptId: string; resolution: CommitAttemptResolution }> = [];
  insertPending(attempt: PendingCommitAttempt): void { this.pending.push(attempt); }
  resolve(attemptId: string, resolution: CommitAttemptResolution): void { this.resolutions.push({ attemptId, resolution }); }
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

function harness(pre: Preview, tokens: CoordinatorTokenStore = new TokenStore(pre.snapshot)) {
  const attempts = new AttemptStore();
  const coordinator = new CommitCoordinator({
    composeLocks: new ComposeLockRegistry(),
    queue: new CheckpointQueue(),
    tokens,
    attempts,
    runGit: (cwd, args, opts) => runGit(cwd, args, { ...opts, gitExe: EXE }),
    runGitBytes: (cwd, args, opts) => runGitBytes(cwd, args, { ...opts, gitExe: EXE }),
    reassemble: async () => live(pre),
    readMemberRepresentation: actualRepresentation,
    locateRepository: () => ({ repoRoot: pre.root, gitExe: EXE }),
    newAttemptId: () => 'path-attempt',
  });
  return { coordinator, attempts };
}

function outcome(result: CommitCoordinatorResult): CommitOutcome {
  assert.equal(result.kind, 'outcome', JSON.stringify(result));
  return result.outcome;
}

interface TreeEntry { mode: string; oid: string; }
function headTree(root: string): Map<string, TreeEntry> {
  const bytes = gitBytes(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  const result = new Map<string, TreeEntry>();
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== 0) continue;
    const record = bytes.subarray(start, i);
    start = i + 1;
    if (!record.length) continue;
    const tab = record.indexOf(0x09);
    assert.ok(tab > 0, 'ls-tree record has a TAB');
    const [mode, , oid] = record.subarray(0, tab).toString('ascii').split(' ');
    result.set(record.subarray(tab + 1).toString('base64'), { mode, oid });
  }
  return result;
}

function assertPreviewLanded(pre: Preview): void {
  const tree = headTree(pre.root);
  for (const [relative, expected] of pre.expected) {
    const actual = tree.get(Buffer.from(relative, 'utf8').toString('base64'));
    if (expected.state === 'absent') {
      assert.equal(actual, undefined, `${JSON.stringify(relative)} remains absent in committed tree`);
    } else {
      assert.deepEqual(actual, { mode: expected.mode, oid: expected.oid }, `${JSON.stringify(relative)} tree mode/blob equal preview`);
    }
  }
}

async function commitPreview(pre: Preview, message: string): Promise<CommitOutcome> {
  const { coordinator } = harness(pre);
  const committed = outcome(await coordinator.commit({ tokenId: pre.snapshot.token.tokenId, message }));
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  assert.equal(gitText(pre.root, ['rev-parse', 'HEAD~1']).trim(), pre.head, 'commit parent is the previewed HEAD');
  assertPreviewLanded(pre);
  return committed;
}

function writeRejectingPreCommitHook(root: string): void {
  const hookDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by hook" 1>&2\nexit 1\n', 'utf8');
  fs.chmodSync(hook, 0o755);
}

test('row 1 — filename with spaces lands the previewed blob', async () => {
  const relative = 'directory with spaces/file name.txt';
  const root = repo({ [relative]: 'old space bytes\n' });
  fs.writeFileSync(path.join(root, relative), 'space bytes\n');
  await commitPreview(await preview(root, [{ entryId: 'space', relative }]), 'space path');
});

test('row 2 — embedded-newline filename lands, or NTFS reports an explicit reason', async () => {
  const relative = 'line\nbreak.txt';
  let root: string;
  try {
    root = repo({ [relative]: 'old newline-name bytes\n' });
  } catch (error) {
    assert.equal(process.platform, 'win32', `only Windows/NTFS is expected to reject LF in a filename: ${String(error)}`);
    return honestSkip('NTFS/Win32 forbids control character LF (U+000A) in a filename, so this host cannot express the row.');
  }
  fs.writeFileSync(path.join(root, relative), 'newline-name bytes\n');
  await commitPreview(await preview(root, [{ entryId: 'newline', relative }]), 'newline path');
});

test('row 3 — distinct NFC and NFD Unicode names both land byte-exact', async () => {
  const nfc = 'unicode/caf\u00e9.txt';
  const nfd = 'unicode/cafe\u0301.txt';
  const root = repo({ [nfc]: 'old NFC\n', [nfd]: 'old NFD\n' });
  const names = fs.readdirSync(path.join(root, 'unicode'));
  if (!names.includes(path.basename(nfc)) || !names.includes(path.basename(nfd)) || names.length !== 2) {
    return honestSkip('The host filesystem normalizes canonically equivalent Unicode filenames and cannot represent distinct NFC/NFD path bytes.');
  }
  fs.writeFileSync(path.join(root, nfc), 'NFC\n');
  fs.writeFileSync(path.join(root, nfd), 'NFD\n');
  await commitPreview(await preview(root, [
    { entryId: 'nfc', relative: nfc },
    { entryId: 'nfd', relative: nfd },
  ]), 'unicode paths');
});

test('row 4 — leading-dash filename is data, never a Git option', async () => {
  const relative = '-looks-like-flag';
  const root = repo({ [relative]: 'old option-like bytes\n' });
  fs.writeFileSync(path.join(root, relative), 'not an option\n');
  await commitPreview(await preview(root, [{ entryId: 'dash', relative }]), 'leading dash');
});

test('row 5 — untracked new member commits exactly the pinned bytes from the temp index', async () => {
  const root = repo();
  // A foreign pre-existing staged hunk on an UNRELATED path must survive byte-identical.
  fs.writeFileSync(path.join(root, 'foreign.txt'), 'foreign staged\n');
  gitText(root, ['add', '--', 'foreign.txt']);
  const foreignEntryBefore = gitBytes(root, ['ls-files', '--stage', '-z', '--', 'foreign.txt']);
  const foreignBlobBefore = gitBytes(root, ['show', ':foreign.txt']);
  // A genuinely untracked member whose raw bytes include NUL / CR / LF / 0xFF, to
  // prove the reviewed object carries authoritative bytes, not a decoded string.
  const rawBytes = Buffer.from([0, 1, 2, 13, 10, 255]);
  fs.writeFileSync(path.join(root, 'added.bin'), rawBytes);
  const pre = await preview(root, [{ entryId: 'add', relative: 'added.bin' }]);
  const committed = await commitPreview(pre, 'untracked add');
  assert.equal(committed.status === 'committed' && committed.indexIntegrity, 'verified');
  // Exactly the previewed/pinned bytes landed (commitPreview also checks tree mode/oid).
  assert.deepEqual(gitBytes(root, ['cat-file', 'blob', 'HEAD:added.bin']), rawBytes);
  // The foreign staged entry is byte-identical afterward (acceptance b).
  assert.deepEqual(gitBytes(root, ['ls-files', '--stage', '-z', '--', 'foreign.txt']), foreignEntryBefore);
  assert.deepEqual(gitBytes(root, ['show', ':foreign.txt']), foreignBlobBefore);
  // Only the member path entered the committed tree.
  const changed = gitText(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split(/\r?\n/).sort();
  assert.deepEqual(changed, ['added.bin']);
});

test('row 6 — tracked deletion lands as an absent tree entry', async () => {
  const root = repo({ 'delete me.txt': 'gone\n' });
  fs.unlinkSync(path.join(root, 'delete me.txt'));
  await commitPreview(await preview(root, [{ entryId: 'delete', relative: 'delete me.txt', state: 'absent' }]), 'delete path');
});

test('row 7 — rename with an untracked destination commits the pinned bytes and drops the source', async () => {
  const oldName = 'old name.txt';
  const newName = '-new name.txt';
  const root = repo({ [oldName]: 'rename bytes\n' });
  fs.renameSync(path.join(root, oldName), path.join(root, newName));
  // Member path is the untracked destination; the tracked source is the extra
  // pathspec `git commit --only` removes. Only the destination gets seeded.
  const pre = await preview(root, [{ entryId: 'rename', relative: newName, pathspecs: [oldName, newName] }]);
  await commitPreview(pre, 'rename to untracked dest');
  const tree = headTree(root);
  assert.equal(tree.get(Buffer.from(oldName, 'utf8').toString('base64')), undefined, 'source removed from committed tree');
  assert.ok(tree.get(Buffer.from(newName, 'utf8').toString('base64')), 'destination present in committed tree');
  assert.equal(gitBytes(root, ['cat-file', 'blob', `HEAD:${newName}`]).toString('utf8'), 'rename bytes\n', 'destination carries the pinned bytes');
  // Worktree reflects the rename; no repair touched it.
  assert.equal(fs.existsSync(path.join(root, oldName)), false, 'worktree source stays absent');
  assert.equal(fs.readFileSync(path.join(root, newName), 'utf8'), 'rename bytes\n');
});

test('row 8 — executable-bit change lands when representable, otherwise says why Windows cannot express it', async () => {
  const root = repo({ 'script.sh': '#!/bin/sh\nexit 0\n' });
  gitText(root, ['config', 'core.filemode', 'true']);
  fs.chmodSync(path.join(root, 'script.sh'), 0o755);
  const status = gitText(root, ['diff', '--summary', '--', 'script.sh']);
  if (!/mode change 100644 => 100755/.test(status)) {
    assert.equal(process.platform, 'win32', 'a POSIX filesystem should expose chmod as a Git mode change');
    assert.doesNotMatch(status, /100755/, 'Windows did not fabricate an executable bit');
    return honestSkip('Windows/NTFS does not expose a POSIX executable bit to Git, so a 100644→100755 worktree change cannot be represented honestly.');
  }
  const pre = await preview(root, [{ entryId: 'exec', relative: 'script.sh' }]);
  assert.equal(pre.expected.get('script.sh')?.mode, '100755');
  await commitPreview(pre, 'exec bit');
});

test('row 9 — symlink lands mode 120000, or Windows privilege policy is an explicit skip', async () => {
  const root = repo();
  const relative = 'link-to-target';
  const oldTarget = 'old-target';
  const target = 'target-name';
  try {
    fs.symlinkSync(oldTarget, path.join(root, relative), 'file');
  } catch (error) {
    assert.equal(process.platform, 'win32', `unexpected non-Windows symlink failure: ${String(error)}`);
    return honestSkip(`Windows denied creation of an unprivileged file symlink (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); Developer Mode or elevation is required.`);
  }
  gitText(root, ['add', '--', relative]);
  gitText(root, ['commit', '-q', '-m', 'base symlink']);
  fs.unlinkSync(path.join(root, relative));
  fs.symlinkSync(target, path.join(root, relative), 'file');
  const rawBlobOid = gitBytes(root, ['hash-object', '--stdin'], Buffer.from(target)).toString('ascii').trim();
  const pre = await preview(root, [{ entryId: 'symlink', relative, rawBlobOid }]);
  assert.equal(pre.expected.get(relative)?.mode, '120000');
  await commitPreview(pre, 'symlink');
});

test('row 10 — changed submodule entry lands the previewed gitlink 160000', async () => {
  const child = repo({ 'child.txt': 'one\n' });
  const root = repo();
  gitText(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'submodule']);
  gitText(root, ['commit', '-q', '-am', 'add submodule']);
  fs.writeFileSync(path.join(child, 'child.txt'), 'two\n');
  gitText(child, ['add', '-A']);
  gitText(child, ['commit', '-q', '-m', 'child two']);
  const childHead = gitText(child, ['rev-parse', 'HEAD']).trim();
  gitText(path.join(root, 'submodule'), ['fetch', '-q', 'origin']);
  gitText(path.join(root, 'submodule'), ['checkout', '-q', childHead]);
  const pre = await preview(root, [{ entryId: 'gitlink', relative: 'submodule', rawBlobOid: null }]);
  assert.deepEqual(pre.expected.get('submodule'), { state: 'present', oid: childHead, mode: '160000' });
  await commitPreview(pre, 'submodule gitlink');
});

test('row 11 — CRLF bytes survive preview and commit despite core.autocrlf=true', async () => {
  const root = repo({ '.gitattributes': 'crlf.txt -text\n', 'crlf.txt': 'base\r\n' });
  gitText(root, ['config', 'core.autocrlf', 'true']);
  const rawBytes = Buffer.from('preview\r\nbytes\r\n', 'ascii');
  fs.writeFileSync(path.join(root, 'crlf.txt'), rawBytes);
  const pre = await preview(root, [{ entryId: 'crlf', relative: 'crlf.txt' }]);
  const rawOid = gitBytes(root, ['hash-object', '--no-filters', '--stdin'], rawBytes).toString('ascii').trim();
  assert.equal(pre.expected.get('crlf.txt')?.oid, rawOid, '-text overrides autocrlf, so previewed raw bytes are the commit blob');
  await commitPreview(pre, 'CRLF raw bytes');
  assert.deepEqual(gitBytes(root, ['cat-file', 'blob', 'HEAD:crlf.txt']), rawBytes);
});

test('row 12 — transitive AB + BC overlap commits the complete A/B/C union once', async () => {
  const root = repo({ 'A.txt': 'a0\n', 'B.txt': 'b0\n', 'C.txt': 'c0\n' });
  fs.writeFileSync(path.join(root, 'A.txt'), 'a1\n');
  fs.writeFileSync(path.join(root, 'B.txt'), 'b1\n');
  fs.writeFileSync(path.join(root, 'C.txt'), 'c1\n');
  const pre = await preview(root, [
    { entryId: 'A', relative: 'A.txt', pathspecs: ['A.txt', 'B.txt'] },
    { entryId: 'B', relative: 'B.txt', pathspecs: ['A.txt', 'B.txt', 'C.txt'] },
    { entryId: 'C', relative: 'C.txt', pathspecs: ['B.txt', 'C.txt'] },
  ]);
  await commitPreview(pre, 'transitive overlap');
  const changed = gitText(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split(/\r?\n/).sort();
  assert.deepEqual(changed, ['A.txt', 'B.txt', 'C.txt']);
});

test('row 13a — empty witness/member set aborts cleanly without a commit', async () => {
  const root = repo();
  const pre = await preview(root, []);
  const { coordinator, attempts } = harness(pre);
  const result = outcome(await coordinator.commit({ tokenId: pre.snapshot.token.tokenId, message: 'empty witnesses' }));
  assert.equal(result.status, 'aborted-error', JSON.stringify(result));
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head, 'HEAD unchanged');
  assert.equal(attempts.pending.length, 1, 'attempt is durably witnessed');
  assert.equal(attempts.resolutions[0]?.resolution.outcomeStatus, 'aborted-error');
});

test('row 13b — missing immutable snapshot is refused before attempt or commit', async () => {
  const root = repo();
  const pre = await preview(root, [{ entryId: 'unused', relative: 'base.txt' }]);
  const { coordinator, attempts } = harness(pre, new TokenStore(null));
  const before = gitText(root, ['rev-parse', 'HEAD']).trim();
  const result = await coordinator.commit({ tokenId: 'missing-token', message: 'must refuse' });
  assert.deepEqual(result, { kind: 'token-unresolved' });
  assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), before);
  assert.equal(attempts.pending.length, 0, 'no attempt exists without a server-held snapshot');
});

test('row 14 — hooks are bypassed; untracked reviewed object lands and unrelated index bytes survive', async () => {
  const root = repo();
  // Foreign staged hunk on an unrelated path must survive the aborted attempt.
  fs.writeFileSync(path.join(root, 'foreign.txt'), 'foreign staged\n');
  gitText(root, ['add', '--', 'foreign.txt']);
  // An untracked member whose reviewed object is applied only in the temp index.
  fs.writeFileSync(path.join(root, 'added.txt'), 'seed me\n');
  const pre = await preview(root, [{ entryId: 'add', relative: 'added.txt' }]);
  const indexBefore = gitBytes(root, ['ls-files', '--stage', '-z']);
  const foreignBefore = gitBytes(root, ['ls-files', '--stage', '-z', '--', 'foreign.txt']);
  // The settled contract says this rejecting hook is not invoked.
  writeRejectingPreCommitHook(root);

  const { coordinator, attempts } = harness(pre);
  const committed = outcome(await coordinator.commit({ tokenId: pre.snapshot.token.tokenId, message: 'hook bypass' }));
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  assert.notEqual(gitText(root, ['rev-parse', 'HEAD']).trim(), pre.head);
  assert.deepEqual(gitBytes(root, ['ls-files', '--stage', '-z', '--', 'foreign.txt']), foreignBefore);
  assert.notDeepEqual(gitBytes(root, ['ls-files', '--stage', '-z']), indexBefore, 'selected path alone is reconciled');
  assert.equal(gitText(root, ['status', '--porcelain', '--', 'added.txt']).trim(), '');
  assert.equal(fs.readFileSync(path.join(root, 'added.txt'), 'utf8'), 'seed me\n');
  assert.equal(attempts.resolutions[0]?.resolution.outcomeStatus, 'committed');
});

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';
  if (!EXE) {
    console.log('commit-coordinator.path-semantics: skipped — no compatible Git executable');
    return;
  }
  let passed = 0;
  let skipped = 0;
  try {
    for (const current of tests) {
      const result = await current.run();
      if (result?.skip) {
        console.log(`skip - ${current.name}: ${result.skip}`);
        skipped++;
      } else {
        console.log(`ok - ${current.name}`);
        passed++;
      }
    }
  } finally {
    for (const dir of [...trash].reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\ncommit-coordinator.path-semantics: ${passed} passed${skipped ? `, ${skipped} explicitly skipped` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
