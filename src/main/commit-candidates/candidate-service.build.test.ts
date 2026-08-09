// SC-WP-3G — canonical candidate assembly + verification + identity (contract
// §4/§4.1/§4.2, §5.1).
//
//   npm run build:main
//   node dist/main/main/commit-candidates/candidate-service.build.test.js
//
// Fake-driven cases pin every listed verdict — component atomicity, coverage,
// finalization conflict/extraneous, raw+clean verification, the prior-exact-commit
// closure, and lens-stable identity. Real-git cases drive the genuine WP-2J temp-
// index so the clean-filtered `.gitattributes` divergence (raw ≠ clean) is real.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import { readCurrentCommitRepresentation, type CommitRepresentation } from './commit-representation';
import type { FrozenManifestMember } from './finalization-service';
import type {
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  ConflictComponent,
  RepositoryIdentity,
  CommitCandidate,
} from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import type { IndexFingerprintResult } from './index-fingerprint';
import {
  buildCandidate,
  buildSelectionPreview,
  type CandidateBuildContext,
  type CandidateSelectionRequest,
  type CandidateLedgerLink,
} from './candidate-service';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const REPO_KEY = 'r'.repeat(64);

function enc(rel: string): EncodedGitPath {
  return { pathBytesBase64: Buffer.from(rel, 'utf8').toString('base64'), displayPath: rel, utf8Clean: true };
}

function entryId(rel: string): string {
  return `entry-${rel}`;
}

function entry(rel: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  const p = enc(rel);
  return {
    entryId: entryId(rel),
    path: p,
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
    rawWorktreeBlobOid: `raw-${rel}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [p],
    ...over,
  };
}

function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPO_KEY,
    objectDatabaseKey: 'odb',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}

function inventory(entries: DirtyEntry[], unattributedEntryIds: string[]): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'topo-all' };
}

let componentSeq = 0;
function component(entryIds: string[], over: Partial<ConflictComponent> = {}): ConflictComponent {
  componentSeq += 1;
  return {
    componentId: over.componentId ?? `comp-${componentSeq}`,
    dirtyEntryIds: [...entryIds].sort(),
    associations: [],
    overlap: {
      componentId: over.componentId ?? `comp-${componentSeq}`,
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: over.componentTopologyDigest ?? `ctd-${componentSeq}`,
    ...over,
  };
}

function frozen(rel: string, over: Partial<FrozenManifestMember> = {}): FrozenManifestMember {
  return {
    pathBytesBase64: enc(rel).pathBytesBase64,
    expectedState: 'present',
    rawBlobOid: `raw-${rel}`,
    commitBlobOid: `commit-${rel}`,
    commitMode: '100644',
    ...over,
  };
}

let finSeq = 0;
function finalization(members: FrozenManifestMember[], over: Partial<PackageFinalization> = {}): PackageFinalization {
  finSeq += 1;
  const id = over.id ?? `fin-${finSeq}`;
  return {
    id,
    packageId: over.packageId ?? `pkg-${finSeq}`,
    repositoryKey: REPO_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 1,
    finalizedAt: 100,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'o'.repeat(40),
    boundaryRef: 'refs/lares/finalizations/x/1',
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify(members),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: 'ws-1',
    ...over,
  };
}

function fingerprint(over: Partial<IndexFingerprintResult> = {}): IndexFingerprintResult {
  return { fingerprint: 'fp-clean', entries: [], hasUnmerged: false, writeTreeOid: 't'.repeat(40), ...over };
}

/** A rep echoing the frozen commit values ⇒ a matching (verified-match) member. */
function repMatching(f: FrozenManifestMember): CommitRepresentation {
  return {
    expectedState: f.expectedState,
    rawBlobOid: f.rawBlobOid,
    commitBlobOid: f.commitBlobOid,
    commitMode: f.commitMode,
  };
}

function ctx(over: Partial<CandidateBuildContext>): CandidateBuildContext {
  return {
    repository: repository(),
    inventory: over.inventory ?? inventory([], []),
    components: over.components ?? [],
    finalizations: over.finalizations ?? [],
    currentCommitReps: over.currentCommitReps ?? new Map(),
    ledger: over.ledger ?? [],
    protectionByEntryId: over.protectionByEntryId,
    pinnedHeadOid: over.pinnedHeadOid ?? 'h'.repeat(40),
    indexFingerprint: over.indexFingerprint ?? fingerprint(),
    contractVersion: over.contractVersion ?? 1,
    ...over,
  };
}

function req(over: Partial<CandidateSelectionRequest> = {}): CandidateSelectionRequest {
  return { selectedComponentIds: [], selectedUnattributedEntryIds: [], finalizationIds: [], ...over };
}

// ── unfinalized selection is a SelectionPreview ──────────────────────────────

test('an unfinalized selection is a SelectionPreview (package-not-finalized)', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const preview = buildSelectionPreview(
    req({ selectedComponentIds: [comp.componentId] }),
    ctx({ inventory: inventory([a], []), components: [comp] }),
  );
  assert.deepEqual(preview.eligibility, { eligible: false, reason: 'package-not-finalized' });
  assert.equal(preview.members.length, 1);
  assert.equal(preview.members[0].packageVerification, 'package-not-finalized');
  assert.deepEqual(preview.members[0].coveringFinalizationIds, []);
  // buildCandidate with no finalizationIds degrades to the same preview shape.
  const viaCandidate = buildCandidate(req({ selectedComponentIds: [comp.componentId] }),
    ctx({ inventory: inventory([a], []), components: [comp] }));
  assert.ok(!('candidateId' in viaCandidate));
});

// ── component atomicity ──────────────────────────────────────────────────────

test('intent-era path selection is governed by normalized Git closure, not topology components', () => {
  const a = entry('a.ts');
  const b = entry('b.ts');
  const comp = component([a.entryId, b.entryId]);
  const f = finalization([frozen('a.ts'), frozen('b.ts')]);
  const result = buildCandidate(
    req({ selectedUnattributedEntryIds: [a.entryId], finalizationIds: [f.id] }),
    ctx({ inventory: inventory([a, b], []), components: [comp], finalizations: [f] }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'package-not-finalized' });
});

test('naming a component pulls in ALL its entries (whole-component atomicity)', () => {
  const a = entry('a.ts');
  const b = entry('b.ts');
  const comp = component([a.entryId, b.entryId]);
  const f = finalization([frozen('a.ts'), frozen('b.ts')]);
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a, b], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))], [b.entryId, repMatching(frozen('b.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.members.map((m) => m.entryId).sort(), [a.entryId, b.entryId].sort());
  assert.deepEqual(result.eligibility, { eligible: true });
});

test('unattributed entries are selected independently and never auto-fused', () => {
  const a = entry('a.ts');
  const b = entry('b.ts');
  const inv = inventory([a, b], [a.entryId, b.entryId]);
  const preview = buildSelectionPreview(req({ selectedUnattributedEntryIds: [a.entryId] }), ctx({ inventory: inv }));
  assert.deepEqual(preview.members.map((m) => m.entryId), [a.entryId]);
  assert.deepEqual(preview.selectedUnattributedEntryIds, [a.entryId]);
});

// ── verified-match eligibility ───────────────────────────────────────────────

test('a dirty selected member matching frozen raw+commit is verified-match + eligible', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const f = finalization([frozen('a.ts')]);
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: true });
  assert.equal(result.members[0].packageVerification, 'verified-match');
  assert.deepEqual(result.members[0].coveringFinalizationIds, [f.id]);
  assert.equal(result.members[0].expectedCommitBlobOid, 'commit-a.ts');
});

test('raw ≠ clean: the CLEAN-filtered half lands in expectedCommitBlobOid', () => {
  const a = entry('a.ts', { rawWorktreeBlobOid: 'raw-distinct' });
  const comp = component([a.entryId]);
  const fm = frozen('a.ts', { rawBlobOid: 'raw-distinct', commitBlobOid: 'clean-distinct' });
  const f = finalization([fm]);
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(fm)]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: true });
  assert.equal(result.members[0].rawWorktreeBlobOid, 'raw-distinct');
  assert.equal(result.members[0].expectedCommitBlobOid, 'clean-distinct');
  assert.notEqual(result.members[0].rawWorktreeBlobOid, result.members[0].expectedCommitBlobOid);
});

test('.gitattributes-style clean-blob drift with intact raw bytes → verified-mismatch/byte-mismatch', () => {
  const a = entry('a.ts'); // raw-a.ts intact
  const comp = component([a.entryId]);
  const fm = frozen('a.ts'); // frozen commit = commit-a.ts
  const f = finalization([fm]);
  // Current temp-index commit blob drifted (a post-finalization clean-filter change)
  // while the raw worktree bytes are unchanged.
  const drifted: CommitRepresentation = { expectedState: 'present', rawBlobOid: 'raw-a.ts', commitBlobOid: 'commit-DRIFTED', commitMode: '100644' };
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, drifted]]),
    }),
  ) as CommitCandidate;
  assert.equal(result.members[0].packageVerification, 'verified-mismatch');
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'byte-mismatch' });
});

// ── coverage across two packages ─────────────────────────────────────────────

test('a candidate spanning two packages carries BOTH refs + full coveringFinalizationIds', () => {
  const a = entry('a.ts');
  const b = entry('b.ts');
  // One component fusing both paths, each covered by a DIFFERENT package.
  const comp = component([a.entryId, b.entryId]);
  const fa = finalization([frozen('a.ts')], { id: 'fin-A', packageId: 'pkg-A' });
  const fb = finalization([frozen('b.ts')], { id: 'fin-B', packageId: 'pkg-B' });
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: ['fin-A', 'fin-B'] }),
    ctx({
      inventory: inventory([a, b], []), components: [comp], finalizations: [fa, fb],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))], [b.entryId, repMatching(frozen('b.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.finalizations.map((r) => r.finalizationId).sort(), ['fin-A', 'fin-B']);
  const byPath = new Map(result.members.map((m) => [m.path.pathBytesBase64, m.coveringFinalizationIds]));
  assert.deepEqual(byPath.get(enc('a.ts').pathBytesBase64), ['fin-A']);
  assert.deepEqual(byPath.get(enc('b.ts').pathBytesBase64), ['fin-B']);
  assert.deepEqual(result.eligibility, { eligible: true });
});

// ── manifest conflict ────────────────────────────────────────────────────────

test('overlapping manifests disagreeing on a commit field → finalization-conflict', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const f1 = finalization([frozen('a.ts', { commitBlobOid: 'commit-X' })], { id: 'fin-1', packageId: 'pkg-1' });
  const f2 = finalization([frozen('a.ts', { commitBlobOid: 'commit-Y' })], { id: 'fin-2', packageId: 'pkg-2' });
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: ['fin-1', 'fin-2'] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f1, f2],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'finalization-conflict' });
  assert.deepEqual(result.members[0].coveringFinalizationIds, ['fin-1', 'fin-2']);
});

// ── extraneous finalization ──────────────────────────────────────────────────

test('a requested finalization covering no selected member → extraneous-finalization', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const fa = finalization([frozen('a.ts')], { id: 'fin-A', packageId: 'pkg-A' });
  const fUnrelated = finalization([frozen('z.ts')], { id: 'fin-Z', packageId: 'pkg-Z' });
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: ['fin-A', 'fin-Z'] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [fa, fUnrelated],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'extraneous-finalization' });
});

// ── prior-exact-commit closure ───────────────────────────────────────────────

test('one dirty selected member + another prior exact-committed member → eligible', () => {
  const a = entry('a.ts'); // still dirty + selected
  const comp = component([a.entryId]);
  // Finalization manifest spans a.ts AND b.ts; b.ts was already committed exactly.
  const fm = finalization([frozen('a.ts'), frozen('b.ts')]);
  const ledger: CandidateLedgerLink[] = [
    { pathBytesBase64: enc('b.ts').pathBytesBase64, expectedState: 'present', commitBlobOid: 'commit-b.ts', commitMode: '100644' },
  ];
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [fm.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [fm], ledger,
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: true });
});

test('a manifest member clean WITHOUT exact ledger proof → package-not-finalized, finalization stays active', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const fm = finalization([frozen('a.ts'), frozen('b.ts')]); // b.ts neither selected nor committed
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [fm.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [fm], ledger: [],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'package-not-finalized' });
  // The assembler is read-only: it never mutates the finalization's lifecycle.
  assert.equal(fm.lifecycleStatus, 'active');
});

test('a ledger row that only raw-matches (wrong commit blob) does NOT prove closure', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const fm = finalization([frozen('a.ts'), frozen('b.ts')]);
  const ledger: CandidateLedgerLink[] = [
    { pathBytesBase64: enc('b.ts').pathBytesBase64, expectedState: 'present', commitBlobOid: 'WRONG', commitMode: '100644' },
  ];
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [fm.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [fm], ledger,
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'package-not-finalized' });
});

// ── boundary unavailable / unsupported / unmerged ────────────────────────────

test('a covering finalization with a non-ready boundary → final-checkpoint-unavailable', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const f = finalization([frozen('a.ts')], { boundaryStatus: 'unavailable' });
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.equal(result.members[0].packageVerification, 'final-checkpoint-unavailable');
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'checkpoint-unavailable' });
});

test('an unsupported git-level entry → unsupported-entry/unsupported-git-state', () => {
  const a = entry('a.ts', { gitLevelEligibility: 'unsupported-git-state' });
  const comp = component([a.entryId]);
  const f = finalization([frozen('a.ts')]);
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.equal(result.members[0].packageVerification, 'unsupported-entry');
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'unsupported-git-state' });
});

test('an unmerged index makes the candidate ineligible (unsupported-git-state)', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId]);
  const f = finalization([frozen('a.ts')]);
  const result = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
      indexFingerprint: fingerprint({ hasUnmerged: true, writeTreeOid: null }),
    }),
  ) as CommitCandidate;
  assert.deepEqual(result.eligibility, { eligible: false, reason: 'unsupported-git-state' });
});

// ── identity ─────────────────────────────────────────────────────────────────

function twoPackageCandidate(order: 'ab' | 'ba'): CommitCandidate {
  const a = entry('a.ts');
  const b = entry('b.ts');
  const comp = component([a.entryId, b.entryId], { componentId: 'comp-fixed', componentTopologyDigest: 'ctd-fixed' });
  const fa = finalization([frozen('a.ts')], { id: 'fin-A', packageId: 'pkg-A' });
  const fb = finalization([frozen('b.ts')], { id: 'fin-B', packageId: 'pkg-B' });
  return buildCandidate(
    req({
      selectedComponentIds: [comp.componentId],
      finalizationIds: order === 'ab' ? ['fin-A', 'fin-B'] : ['fin-B', 'fin-A'],
    }),
    ctx({
      inventory: inventory([a, b], []), components: [comp], finalizations: order === 'ab' ? [fa, fb] : [fb, fa],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))], [b.entryId, repMatching(frozen('b.ts'))]]),
    }),
  ) as CommitCandidate;
}

test('candidateId is identical across both lenses (input-order independent)', () => {
  const one = twoPackageCandidate('ab');
  const two = twoPackageCandidate('ba');
  assert.equal(one.candidateId, two.candidateId);
  assert.match(one.candidateId, /^[0-9a-f]{64}$/);
});

test('candidateId changes when the finalization/coverage set changes', () => {
  const a = entry('a.ts');
  const comp = component([a.entryId], { componentId: 'comp-fixed', componentTopologyDigest: 'ctd-fixed' });
  const fa = finalization([frozen('a.ts')], { id: 'fin-A', packageId: 'pkg-A' });
  const faAlt = finalization([frozen('a.ts')], { id: 'fin-A2', packageId: 'pkg-A2' });
  const mk = (f: PackageFinalization) => buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [f.id] }),
    ctx({
      inventory: inventory([a], []), components: [comp], finalizations: [f],
      currentCommitReps: new Map([[a.entryId, repMatching(frozen('a.ts'))]]),
    }),
  ) as CommitCandidate;
  assert.notEqual(mk(fa).candidateId, mk(faAlt).candidateId);
});

test('candidateId binds a rename source and every commit pathspec', () => {
  const destination = enc('new-name.ts');
  const rename = (source: string): DirtyEntry => entry('new-name.ts', {
    entryId: 'entry-rename-fixed',
    path: destination,
    originalPath: enc(source),
    entryKind: 'rename-or-copy',
    indexStatus: 'R',
    worktreeStatus: '.',
    renameOrCopyScore: '100',
    commitPathspecs: [destination, enc(source)],
  });
  const frozenDestination = frozen('new-name.ts');
  const fin = finalization([frozenDestination], { id: 'fin-rename', packageId: 'pkg-rename' });
  const comp = component(['entry-rename-fixed'], {
    componentId: 'comp-rename', componentTopologyDigest: 'ctd-rename',
  });
  const mk = (source: string) => {
    const renamed = rename(source);
    return buildCandidate(
      req({ selectedComponentIds: [comp.componentId], finalizationIds: [fin.id] }),
      ctx({
        inventory: inventory([renamed], []), components: [comp], finalizations: [fin],
        currentCommitReps: new Map([[renamed.entryId, repMatching(frozenDestination)]]),
      }),
    ) as CommitCandidate;
  };

  const first = mk('old-a.ts');
  const second = mk('old-b.ts');
  assert.deepEqual(first.members, second.members,
    'all member fields hashed before WP-3 remain equal');
  assert.notEqual(first.candidateId, second.candidateId,
    'changing only the rename source/pathspec must change operational identity');
});

// ── real git: genuine clean-filter (.gitattributes) divergence ───────────────

const trash: string[] = [];

test('real git: raw ≠ clean via .gitattributes, then a post-finalize attr change → verified-mismatch', async () => {
  const internal = await resolveInternalGit();
  if (!internal) { console.log('  SKIP real-git case — no compatible git resolved.'); return; }
  const exe = internal.execPath;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-buildcand-'));
  trash.push(repo);
  const g = (args: string[]) => execFileSync(exe, args, { cwd: repo }).toString();
  g(['init', '-q']);
  g(['config', 'user.email', 't@lares.local']);
  g(['config', 'user.name', 'Lares Test']);
  g(['config', 'core.autocrlf', 'false']);

  // A CRLF worktree file + `text eol=lf` clean filter ⇒ commit blob (LF) ≠ raw blob (CRLF).
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text eol=lf\n');
  fs.writeFileSync(path.join(repo, 'note.txt'), Buffer.from('one\r\ntwo\r\n', 'ascii'));
  g(['add', '.gitattributes']); g(['commit', '-q', '-m', 'attrs']);
  const head = g(['rev-parse', 'HEAD']).trim();

  const rawOid = execFileSync(exe, ['hash-object', '-w', '--no-filters', 'note.txt'], { cwd: repo }).toString().trim();
  const noteEntry = entry('note.txt', { rawWorktreeBlobOid: rawOid });

  const commonRep = await readCurrentCommitRepresentation({
    repoRoot: repo, pinnedHeadOid: head, entry: noteEntry, gitExe: exe,
    runGit: (c, a, o) => realRunGit(c, a, { ...o, gitExe: exe }),
    runGitBytes: (c, a, o) => realRunGitBytes(c, a, { ...o, gitExe: exe }),
  });
  // Prove the divergence is real: clean-filtered commit blob differs from raw.
  assert.notEqual(commonRep.commitBlobOid, rawOid, 'clean filter must change the blob');

  const comp = component([noteEntry.entryId]);
  const fm = finalization([frozen('note.txt', {
    rawBlobOid: rawOid, commitBlobOid: commonRep.commitBlobOid, commitMode: commonRep.commitMode ?? '100644',
  })]);
  const baseCtx = ctx({
    inventory: inventory([noteEntry], []), components: [comp], finalizations: [fm],
    currentCommitReps: new Map([[noteEntry.entryId, commonRep]]),
  });

  // Matching frozen ⇒ eligible (raw ≠ clean handled correctly).
  const ok = buildCandidate(req({ selectedComponentIds: [comp.componentId], finalizationIds: [fm.id] }), baseCtx) as CommitCandidate;
  assert.deepEqual(ok.eligibility, { eligible: true });
  assert.equal(ok.members[0].expectedCommitBlobOid, commonRep.commitBlobOid);

  // Post-finalization .gitattributes change alters the clean-filtered blob while the
  // raw worktree bytes are untouched. Re-read the CURRENT rep; frozen stays put.
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt -text\n');
  const driftedRep = await readCurrentCommitRepresentation({
    repoRoot: repo, pinnedHeadOid: head, entry: noteEntry, gitExe: exe,
    runGit: (c, a, o) => realRunGit(c, a, { ...o, gitExe: exe }),
    runGitBytes: (c, a, o) => realRunGitBytes(c, a, { ...o, gitExe: exe }),
  });
  assert.notEqual(driftedRep.commitBlobOid, commonRep.commitBlobOid, 'attr change must move the clean blob');
  const drifted = buildCandidate(
    req({ selectedComponentIds: [comp.componentId], finalizationIds: [fm.id] }),
    ctx({ ...baseCtx, currentCommitReps: new Map([[noteEntry.entryId, driftedRep]]) }),
  ) as CommitCandidate;
  assert.equal(drifted.members[0].packageVerification, 'verified-mismatch');
  assert.deepEqual(drifted.eligibility, { eligible: false, reason: 'byte-mismatch' });
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
