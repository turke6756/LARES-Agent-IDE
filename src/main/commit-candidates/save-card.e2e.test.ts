import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMMIT_CANDIDATE_MINT_CHANNEL,
  COMMIT_COORDINATOR_CHANNEL,
  SAVECARD_CHANNELS,
  SAVECARD_FINALIZE_CHANNEL,
  SAVECARD_PREVIEW_CHANNEL,
  type CommitCoordinatorConsumeResponse,
  type SaveCardFleetAdhocMarkDoneSuccess,
  type SaveCardInventoryResponse,
  type SaveCardMintResponse,
  type SaveCardPreviewResponse,
} from '../../shared/types';
import type { CommitCandidate } from '../../shared/commit-candidates';
import type {
  CommitLedgerWrite,
  CommitPathLink,
  CommitRecord,
  PackageFinalization,
  PendingCommitAttempt,
  CommitAttemptResolution,
  PlanWorkPackage,
  FinalizationBoundaryStatus,
} from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { CommitCoordinator } from '../git-checkpoints/commit-coordinator';
import { CheckpointQueue } from '../git-checkpoints/checkpoint-queue';
import { reconcileCommittedCandidate, type CommitClosureStore } from '../git-checkpoints/commit-reconciler';
import type { FinalizationStore } from './finalization-service';
import { createSaveCardRoutes } from './save-card-routes';
import { createPreviewRoutes } from './preview-routes';
import {
  registerSaveCardFinalizeIpc,
  registerSaveCardIpc,
  registerSaveCardMintIpc,
  registerSaveCardPreviewIpc,
  type IpcLike,
} from './save-card-ipc';
import { registerCommitCoordinatorIpc } from './commit-coordinator-ipc';

type Handler = (_event: unknown, ...args: unknown[]) => unknown;
class FakeIpc implements IpcLike {
  private readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke<T>(channel: string, request: unknown): Promise<T> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no registered route for ${channel}`);
    return handler({}, request) as Promise<T>;
  }
}

class MemoryPersistence implements FinalizationStore, CommitClosureStore {
  readonly finalizations = new Map<string, PackageFinalization>();
  readonly records: CommitRecord[] = [];
  readonly pathLinks: CommitPathLink[] = [];
  readonly attempts: PendingCommitAttempt[] = [];
  readonly attemptResolutions: Array<{ id: string; resolution: CommitAttemptResolution }> = [];
  getActivePackageFinalization(packageId: string): PackageFinalization | null {
    return [...this.finalizations.values()].find((row) =>
      row.packageId === packageId && row.lifecycleStatus === 'active') ?? null;
  }
  maxPackageRevision(packageId: string): number {
    return Math.max(0, ...[...this.finalizations.values()]
      .filter((row) => row.packageId === packageId).map((row) => row.packageRevision));
  }
  insertPackageFinalization(row: PackageFinalization): void { this.finalizations.set(row.id, row); }
  supersedePackageFinalization(id: string, supersededBy: string): void {
    const row = this.finalizations.get(id)!;
    this.finalizations.set(id, { ...row, lifecycleStatus: 'superseded', supersededByFinalizationId: supersededBy });
  }
  setPackageFinalizationBoundaryStatus(id: string, status: FinalizationBoundaryStatus): void {
    const row = this.finalizations.get(id)!;
    this.finalizations.set(id, { ...row, boundaryStatus: status });
  }
  getPlanWorkPackage(_id: string): PlanWorkPackage | null { return null; }
  upsertPlanWorkPackage(_pkg: PlanWorkPackage): void {}
  transact<T>(fn: () => T): T { return fn(); }
  getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null {
    return this.records.find((row) => row.repositoryKey === repositoryKey && row.commitOid === commitOid) ?? null;
  }
  recordCommitLedger(write: CommitLedgerWrite): void {
    this.records.push(write.record);
    this.pathLinks.push(...(write.pathLinks ?? []));
  }
  getPackageFinalization(id: string): PackageFinalization | null { return this.finalizations.get(id) ?? null; }
  listCommitPathLinks(repositoryKey: string, paths: readonly string[]): CommitPathLink[] {
    return this.pathLinks.filter((row) => row.repositoryKey === repositoryKey && paths.includes(row.pathBytesBase64));
  }
  markPackageFinalizationCommitted(id: string, releasedAt: number): void {
    const row = this.finalizations.get(id)!;
    this.finalizations.set(id, { ...row, lifecycleStatus: 'committed', releasedAt });
  }
}

function git(exe: string, repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(exe, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function gitBytes(exe: string, repo: string, args: string[]): Buffer {
  return execFileSync(exe, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-save-card-e2e-'));
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const resolved = await resolveInternalGit();
  assert.ok(resolved, 'a compatible Git is required for the save-card e2e test');
  const gitExe = resolved.execPath;

  try {
    git(gitExe, repo, ['init']);
    git(gitExe, repo, ['config', 'user.name', 'Save Card E2E']);
    git(gitExe, repo, ['config', 'user.email', 'save-card-e2e@example.invalid']);
    git(gitExe, repo, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    fs.writeFileSync(path.join(repo, 'foreign.txt'), 'foreign base\n');
    fs.writeFileSync(path.join(repo, 'mixed.txt'), 'mixed base\n');
    git(gitExe, repo, ['add', '--', 'base.txt', 'foreign.txt', 'mixed.txt']);
    git(gitExe, repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(path.join(repo, 'foreign.txt'), 'foreign staged bytes\r\n');
    git(gitExe, repo, ['add', '--', 'foreign.txt']);
    const foreignIndexBefore = gitBytes(gitExe, repo, ['show', ':foreign.txt']);
    const proposalsDir = path.join(repo, '.lares', 'proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });
    const pinned = new Map<string, Buffer>();
    for (let i = 1; i <= 15; i++) {
      const relative = `.lares/proposals/proposal-${String(i).padStart(2, '0')}.md`;
      const bytes = Buffer.from(`---\nartifact_id: proposal-${i}\n---\nbyte pin ${i}\r\n`, 'utf8');
      fs.writeFileSync(path.join(repo, relative), bytes);
      pinned.set(relative, bytes);
    }

    const workspaces = [
      { id: 'ws-repo', title: 'Repo', path: repo },
      // W5 invariant: an unrelated repo-less contributor workspace must not poison
      // the pane's repository-scoped inventory/finalization/commit transaction.
      { id: 'ws-root', title: 'Computer Root', path: sandbox },
    ];
    const persistence = new MemoryPersistence();
    const readTurnWitnesses = (workspaceId: string) => workspaceId === 'ws-repo' ? [{
      turnId: 'foreign-turn', agentId: 'foreign-agent', ownerAgentId: null,
      ownerBrickGeneration: null, touched: [{ path: 'foreign.txt', op: 'write' as const }],
    }] : [];

    const captureFinalizationBoundary = async () => {
      const alternateIndex = path.join(sandbox, `boundary-${Date.now()}.index`);
      const env = { GIT_INDEX_FILE: alternateIndex };
      git(gitExe, repo, ['read-tree', 'HEAD'], env);
      git(gitExe, repo, ['add', '-A', '--', '.'], env);
      const treeOid = git(gitExe, repo, ['write-tree'], env);
      const head = git(gitExe, repo, ['rev-parse', 'HEAD']);
      const oid = git(gitExe, repo, ['commit-tree', treeOid, '-p', head, '-m', 'save-card boundary'], env);
      return { oid, treeOid };
    };

    const empty = () => [];
    const previewRoutes = createPreviewRoutes({
      gitExe, captureFinalizationBoundary, getWorkspaces: () => workspaces,
      readTurnWitnesses, readCaptureTurns: empty, readCommitPathLinks: empty,
      listRepoCommitPathLinks: empty, readTurnRecord: () => null,
      getPackageFinalization: (id) => persistence.getPackageFinalization(id),
      getPlanWorkPackage: () => null, listPlanWorkPackagePaths: empty,
    });
    previewRoutes.saveCardFinalizeRoutes.finalizeDeps = { store: persistence };
    const inventoryRoutes = createSaveCardRoutes({
      gitExe, getWorkspaces: () => workspaces,
      readTurnWitnesses, readCaptureTurns: empty, readCommitPathLinks: empty,
      readTurnRecord: () => null, getAgentsByWorkspace: empty, getAgent: () => null,
      readBundleTurns: empty,
    });
    const candidateService = previewRoutes.productionSeams.candidateService;
    const coordinator = new CommitCoordinator({
      composeLocks: previewRoutes.productionSeams.composeLocks,
      queue: new CheckpointQueue(),
      tokens: {
        resolve: candidateService.resolveCandidateToken.bind(candidateService),
        tryConsume: candidateService.tryMarkTokenConsuming.bind(candidateService),
        markConsumed: candidateService.markTokenConsumed.bind(candidateService),
      },
      attempts: {
        insertPending: (attempt) => { persistence.attempts.push(attempt); },
        resolve: (id, resolution) => { persistence.attemptResolutions.push({ id, resolution }); },
      },
      runGit,
      runGitBytes,
      reassemble: previewRoutes.productionSeams.reassemble,
      readMemberRepresentation: previewRoutes.productionSeams.readMemberRepresentation,
      locateRepository: previewRoutes.productionSeams.locateRepository,
      deriveTrailers: previewRoutes.productionSeams.deriveTrailers,
    });

    const ipc = new FakeIpc();
    registerSaveCardIpc(ipc, () => inventoryRoutes);
    registerSaveCardFinalizeIpc(ipc, () => previewRoutes.saveCardFinalizeRoutes);
    registerSaveCardPreviewIpc(ipc, () => previewRoutes.saveCardPreviewRoutes);
    registerSaveCardMintIpc(ipc, () => previewRoutes.saveCardMintRoutes);
    registerCommitCoordinatorIpc(ipc, () => ({
      coordinator,
      resolveCandidateToken: candidateService.resolveCandidateToken.bind(candidateService),
      locateRepository: previewRoutes.productionSeams.locateRepository,
      reconcileCommitted: (input) => reconcileCommittedCandidate({ ...input, store: persistence }),
    }), () => true);

    const inventory = await ipc.invoke<SaveCardInventoryResponse>(
      SAVECARD_CHANNELS.getInventory,
      { workspaceId: 'ws-repo' },
    );
    const bundle = inventory.bundles.find((item) => item.kind === 'unattributed');
    assert.ok(bundle, 'the 15-file proposal package is surfaced as unattributed');
    const proposalMembers = bundle.members.filter((member) =>
      member.entry.path.displayPath.startsWith('.lares/proposals/'));
    assert.equal(proposalMembers.length, 15);

    const finalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: bundle.bundleId,
      targetWorkspaceId: 'ws-repo',
    });
    assert.equal(finalized.boundaryStatus, 'ready');
    assert.ok(finalized.boundaryRef);
    assert.equal(git(gitExe, repo, ['show-ref', '--verify', finalized.boundaryRef!]).length > 0, true);

    const benignPath = '.lares/proposals/benign-16.md';
    fs.writeFileSync(path.join(repo, benignPath), 'unrelated after pin\n');
    const selection = {
      workspaceId: 'ws-repo',
      selectedComponentIds: finalized.pinnedSelection.selectedComponentIds,
      selectedUnattributedEntryIds: finalized.pinnedSelection.selectedUnattributedEntryIds,
      finalizationIds: [finalized.finalizationId],
    };
    const preview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, selection);
    assert.equal((preview.candidate as CommitCandidate).token, null, 'preview is always tokenless');
    assert.equal(preview.isCandidate, true);
    assert.deepEqual(
      preview.candidate.members.map((member) => member.packageVerification),
      Array(15).fill('verified-match'),
    );
    assert.deepEqual(preview.selectionDrift.added, [Buffer.from(benignPath).toString('base64')]);
    assert.deepEqual(preview.selectionDrift.missing, []);
    assert.equal(preview.candidate.eligibility.eligible, true, 'an unrelated 16th file does not invalidate the pin');

    const mintedResponse = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...selection,
      acknowledgeTopologyDigest: preview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: selection.selectedUnattributedEntryIds,
    });
    const minted = mintedResponse.candidate as CommitCandidate;
    assert.ok(minted.token, `the dedicated mint bridge returns a token: ${JSON.stringify(minted.eligibility)}`);
    assert.ok(candidateService.resolveCandidateToken(minted.token!.tokenId), 'coordinator token store resolves it');
    assert.equal(minted.candidateId, (preview.candidate as CommitCandidate).candidateId);

    const beforeCount = Number(git(gitExe, repo, ['rev-list', '--count', 'HEAD']));
    const consumed = await ipc.invoke<CommitCoordinatorConsumeResponse>(COMMIT_COORDINATOR_CHANNEL, {
      candidateId: minted.candidateId,
      tokenId: minted.token!.tokenId,
      message: 'Save fifteen pinned proposals',
    });
    assert.equal(consumed.kind, 'saved');
    const afterCount = Number(git(gitExe, repo, ['rev-list', '--count', 'HEAD']));
    assert.equal(afterCount - beforeCount, 1, 'exactly one commit lands');

    for (const [relative, expected] of pinned) {
      assert.deepEqual(fs.readFileSync(path.join(repo, relative)), expected, `${relative} worktree bytes stay pinned`);
      assert.deepEqual(gitBytes(gitExe, repo, ['show', `HEAD:${relative}`]), expected, `${relative} committed bytes stay pinned`);
    }
    assert.deepEqual(gitBytes(gitExe, repo, ['show', ':foreign.txt']), foreignIndexBefore);
    assert.deepEqual(fs.readFileSync(path.join(repo, 'foreign.txt')), Buffer.from('foreign staged bytes\r\n'));
    assert.equal(git(gitExe, repo, ['diff', '--cached', '--name-only']), 'foreign.txt');

    const commitOid = git(gitExe, repo, ['rev-parse', 'HEAD']);
    const repositoryKey = minted.repository.repositoryKey;
    assert.equal(persistence.records.some((row) => row.repositoryKey === repositoryKey && row.commitOid === commitOid), true);
    assert.equal(persistence.pathLinks.filter((row) => row.commitOid === commitOid).length, 15);
    const closed = persistence.getPackageFinalization(finalized.finalizationId);
    assert.equal(closed?.lifecycleStatus, 'committed');
    assert.ok(closed?.releasedAt, 'closure releases the boundary from active retention');

    const refreshed = await ipc.invoke<SaveCardInventoryResponse>(
      SAVECARD_CHANNELS.getInventory,
      { workspaceId: 'ws-repo' },
    );
    const remainingPaths = refreshed.bundles.flatMap((item) =>
      item.members.map((member) => member.entry.path.displayPath));
    assert.deepEqual(remainingPaths.filter((item) => item.startsWith('.lares/proposals/')), [benignPath]);
    assert.equal(git(gitExe, repo, ['ls-tree', '--name-only', 'HEAD', '--', benignPath]), '', 'the unrelated 16th file is not committed');
    fs.rmSync(path.join(repo, benignPath));

    // Sibling transition rows: byte movement on either side of mint is fail-closed,
    // and token expiry becomes an unresolved consume rather than a commit attempt.
    fs.writeFileSync(path.join(repo, '.lares/proposals/moved-before-mint.md'), 'pin\n');
    const movedInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const movedBundle = movedInventory.bundles.find((item) => item.kind === 'unattributed')!;
    const movedMember = movedBundle.members.find((item) => item.entry.path.displayPath.endsWith('moved-before-mint.md'))!;
    const movedFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: movedBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    const movedSelection = {
      workspaceId: 'ws-repo', selectedComponentIds: [], selectedUnattributedEntryIds: [movedMember.entry.entryId],
      finalizationIds: [movedFinalized.finalizationId],
    };
    const movedPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, movedSelection);
    fs.writeFileSync(path.join(repo, '.lares/proposals/moved-before-mint.md'), 'changed\n');
    const movedMint = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...movedSelection, acknowledgeTopologyDigest: movedPreview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: movedSelection.selectedUnattributedEntryIds,
    });
    assert.deepEqual(movedMint.candidate.eligibility, { eligible: false, reason: 'byte-mismatch' });
    assert.deepEqual(movedMint.selectionDrift.byteMoved, [movedMember.entry.path.pathBytesBase64]);
    assert.deepEqual(movedMint.selectionDrift.missing, []);
    assert.equal((movedMint.candidate as CommitCandidate).token, null);

    fs.rmSync(path.join(repo, '.lares/proposals/moved-before-mint.md'));

    fs.writeFileSync(path.join(repo, '.lares/proposals/deleted-before-mint.md'), 'pin then delete\n');
    const deletedInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const deletedBundle = deletedInventory.bundles.find((item) => item.kind === 'unattributed')!;
    const deletedMember = deletedBundle.members.find((item) => item.entry.path.displayPath.endsWith('deleted-before-mint.md'))!;
    const deletedFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: deletedBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    fs.rmSync(path.join(repo, '.lares/proposals/deleted-before-mint.md'));
    const deletedPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, {
      workspaceId: 'ws-repo',
      selectedComponentIds: deletedFinalized.pinnedSelection.selectedComponentIds,
      selectedUnattributedEntryIds: deletedFinalized.pinnedSelection.selectedUnattributedEntryIds,
      finalizationIds: [deletedFinalized.finalizationId],
    });
    assert.deepEqual(deletedPreview.selectionDrift.missing, [deletedMember.entry.path.pathBytesBase64]);
    assert.deepEqual(deletedPreview.selectionDrift.byteMoved, []);
    assert.equal(deletedPreview.candidate.eligibility.eligible, false);

    // Tracked modification + untracked addition travel through the same real
    // finalization/mint/consume pipeline and land together.
    fs.writeFileSync(path.join(repo, 'mixed.txt'), 'mixed tracked change\n');
    fs.writeFileSync(path.join(repo, '.lares/proposals/mixed-new.md'), 'mixed untracked change\n');
    const mixedInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const mixedBundle = mixedInventory.bundles.find((item) => item.kind === 'unattributed')!;
    assert.deepEqual(
      mixedBundle.members.map((item) => item.entry.path.displayPath).sort(),
      ['.lares/proposals/mixed-new.md', 'mixed.txt'],
    );
    const mixedFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: mixedBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    const mixedSelection = {
      workspaceId: 'ws-repo', selectedComponentIds: [],
      selectedUnattributedEntryIds: mixedBundle.members.map((item) => item.entry.entryId),
      finalizationIds: [mixedFinalized.finalizationId],
    };
    const mixedPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, mixedSelection);
    const mixedMintResponse = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...mixedSelection, acknowledgeTopologyDigest: mixedPreview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: mixedSelection.selectedUnattributedEntryIds,
    });
    const mixedCandidate = mixedMintResponse.candidate as CommitCandidate;
    const mixedConsumed = await ipc.invoke<CommitCoordinatorConsumeResponse>(COMMIT_COORDINATOR_CHANNEL, {
      candidateId: mixedCandidate.candidateId, tokenId: mixedCandidate.token!.tokenId, message: 'Save mixed changes',
    });
    assert.equal(mixedConsumed.kind, 'saved');
    assert.equal(git(gitExe, repo, ['show', 'HEAD:mixed.txt']), 'mixed tracked change');
    assert.equal(git(gitExe, repo, ['show', 'HEAD:.lares/proposals/mixed-new.md']), 'mixed untracked change');

    // Byte movement after mint is rejected by the coordinator's live reassembly.
    fs.writeFileSync(path.join(repo, '.lares/proposals/moved-after-mint.md'), 'minted bytes\n');
    const afterMintInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const afterMintBundle = afterMintInventory.bundles.find((item) => item.kind === 'unattributed')!;
    const afterMintFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: afterMintBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    const afterMintSelection = {
      workspaceId: 'ws-repo', selectedComponentIds: [],
      selectedUnattributedEntryIds: afterMintBundle.members.map((item) => item.entry.entryId),
      finalizationIds: [afterMintFinalized.finalizationId],
    };
    const afterMintPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, afterMintSelection);
    const afterMintResponse = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...afterMintSelection, acknowledgeTopologyDigest: afterMintPreview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: afterMintSelection.selectedUnattributedEntryIds,
    });
    const afterMintCandidate = afterMintResponse.candidate as CommitCandidate;
    fs.writeFileSync(path.join(repo, '.lares/proposals/moved-after-mint.md'), 'changed after mint\n');
    const staleConsume = await ipc.invoke<CommitCoordinatorConsumeResponse>(COMMIT_COORDINATOR_CHANNEL, {
      candidateId: afterMintCandidate.candidateId, tokenId: afterMintCandidate.token!.tokenId,
      message: 'Must refuse stale bytes',
    });
    assert.equal(staleConsume.kind, 'outcome');
    assert.equal(staleConsume.kind === 'outcome' ? staleConsume.outcome.status : null, 'aborted-stale');
    fs.rmSync(path.join(repo, '.lares/proposals/moved-after-mint.md'));

    // Expired tokens are unresolved before the coordinator can mutate Git.
    fs.writeFileSync(path.join(repo, '.lares/proposals/expiry.md'), 'expires\n');
    const expiryInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const expiryBundle = expiryInventory.bundles.find((item) => item.kind === 'unattributed')!;
    const expiryFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: expiryBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    const expirySelection = {
      workspaceId: 'ws-repo', selectedComponentIds: [],
      selectedUnattributedEntryIds: expiryBundle.members.map((item) => item.entry.entryId),
      finalizationIds: [expiryFinalized.finalizationId],
    };
    const expiryPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, expirySelection);
    const expiryMint = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...expirySelection, acknowledgeTopologyDigest: expiryPreview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: expirySelection.selectedUnattributedEntryIds,
    });
    const expiryCandidate = expiryMint.candidate as CommitCandidate;
    const realNow = Date.now;
    Date.now = () => expiryCandidate.token!.expiresAt + 1;
    try {
      const expired = await ipc.invoke<CommitCoordinatorConsumeResponse>(COMMIT_COORDINATOR_CHANNEL, {
        candidateId: expiryCandidate.candidateId, tokenId: expiryCandidate.token!.tokenId, message: 'Expired',
      });
      assert.deepEqual(expired, { kind: 'token-unresolved' });
    } finally {
      Date.now = realNow;
    }
    fs.rmSync(path.join(repo, '.lares/proposals/expiry.md'));

    // A real rejecting hook aborts cleanly and leaves HEAD unchanged.
    fs.writeFileSync(path.join(repo, '.lares/proposals/hook.md'), 'hook candidate\n');
    const hookInventory = await ipc.invoke<SaveCardInventoryResponse>(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-repo' });
    const hookBundle = hookInventory.bundles.find((item) => item.kind === 'unattributed')!;
    const hookFinalized = await ipc.invoke<SaveCardFleetAdhocMarkDoneSuccess>(SAVECARD_FINALIZE_CHANNEL, {
      packageId: hookBundle.bundleId, targetWorkspaceId: 'ws-repo',
    });
    const hookSelection = {
      workspaceId: 'ws-repo', selectedComponentIds: [],
      selectedUnattributedEntryIds: hookBundle.members.map((item) => item.entry.entryId),
      finalizationIds: [hookFinalized.finalizationId],
    };
    const hookPreview = await ipc.invoke<SaveCardPreviewResponse>(SAVECARD_PREVIEW_CHANNEL, hookSelection);
    const hookMint = await ipc.invoke<SaveCardMintResponse>(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...hookSelection, acknowledgeTopologyDigest: hookPreview.componentTopologyDigest,
      acknowledgeUnattributedEntryIds: hookSelection.selectedUnattributedEntryIds,
    });
    const hookCandidate = hookMint.candidate as CommitCandidate;
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "e2e hook rejected" 1>&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    const headBeforeHook = git(gitExe, repo, ['rev-parse', 'HEAD']);
    const hookRefusal = await ipc.invoke<CommitCoordinatorConsumeResponse>(COMMIT_COORDINATOR_CHANNEL, {
      candidateId: hookCandidate.candidateId, tokenId: hookCandidate.token!.tokenId, message: 'Hook rejection',
    });
    assert.equal(hookRefusal.kind, 'outcome');
    assert.equal(hookRefusal.kind === 'outcome' ? hookRefusal.outcome.status : null, 'aborted-error');
    assert.equal(git(gitExe, repo, ['rev-parse', 'HEAD']), headBeforeHook);

    console.log('All save-card production-shaped e2e tests passed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
