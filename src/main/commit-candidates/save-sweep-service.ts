import type {
  SaveSweepIntent,
  SaveSweepRequest,
  SaveSweepResponse,
  SaveSweepTerminalResult,
} from '../../shared/types';
import type { CandidateSelectionRequest, CandidateBuildContext } from './candidate-service';
import {
  CommitCandidateService,
  reviewCarryVerdictFor,
} from './candidate-service';
import { freshIndexGate, type IndexFingerprintResult } from './index-fingerprint';
import type { SweepConsumableCoordinatorResult } from './commit-coordinator-ipc';

export type FreshSaveSweepResolution =
  | {
      kind: 'already-saved';
      indexFingerprint: IndexFingerprintResult;
      provingCommitOids: readonly string[];
    }
  | {
      kind: 'candidate';
      indexFingerprint: IndexFingerprintResult;
      context: CandidateBuildContext;
      /** Main-derived operational ids for the freshly reconstructed package. */
      selection: CandidateSelectionRequest;
    }
  | {
      kind: 'needs-attention';
      indexFingerprint: IndexFingerprintResult;
      code: string;
      message: string;
    };

export interface SaveSweepServiceDeps {
  candidateService: CommitCandidateService;
  /** Refresh inventory, HEAD/ledger reachability, closure, and operational ids. */
  resolveIntent(intent: Readonly<SaveSweepIntent>): Promise<FreshSaveSweepResolution>;
  consume(request: {
    candidateId: string;
    tokenId: string;
    message: string;
  }): Promise<SweepConsumableCoordinatorResult>;
  /** Authoritative post-reconciliation refresh. */
  refreshInventory(repositoryKey: string): Promise<void>;
}

function compare(left: string | number, right: string | number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedIntents(intents: readonly SaveSweepIntent[]): SaveSweepIntent[] {
  return [...structuredClone(intents)].sort((left, right) =>
    compare(left.repositoryKey, right.repositoryKey)
    || compare(left.packageId, right.packageId)
    || compare(left.packageRevision, right.packageRevision)
    || compare(left.finalizationId, right.finalizationId));
}

function base(intent: SaveSweepIntent) {
  return {
    repositoryKey: intent.repositoryKey,
    finalizationId: intent.finalizationId,
    packageId: intent.packageId,
    packageRevision: intent.packageRevision,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sequential main-process save authority. Concurrent gestures sharing any
 * repository wait behind one another; each iteration reconstructs from scratch. */
export class SaveSweepService {
  private readonly repositoryTails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SaveSweepServiceDeps) {}

  sweep(request: SaveSweepRequest): Promise<SaveSweepResponse> {
    const intents = orderedIntents(request.intents);
    const reviewedManifestDigests = new Set(request.reviewedManifestDigests);
    const acknowledgedChallengeAtoms = structuredClone(request.acknowledgedChallengeAtoms);
    const repositoryKeys = [...new Set(intents.map((intent) => intent.repositoryKey))].sort();
    const predecessors = repositoryKeys.map((key) => this.repositoryTails.get(key) ?? Promise.resolve());
    const run = Promise.all(predecessors).then(() => this.execute(
      intents,
      reviewedManifestDigests,
      acknowledgedChallengeAtoms,
    ));
    const tail = run.catch(() => undefined);
    for (const key of repositoryKeys) this.repositoryTails.set(key, tail);
    return run.finally(() => {
      for (const key of repositoryKeys) {
        if (this.repositoryTails.get(key) === tail) this.repositoryTails.delete(key);
      }
    });
  }

  private async execute(
    intents: readonly SaveSweepIntent[],
    reviewedManifestDigests: ReadonlySet<string>,
    acknowledgedChallengeAtoms: SaveSweepRequest['acknowledgedChallengeAtoms'],
  ): Promise<SaveSweepResponse> {
    const results: SaveSweepTerminalResult[] = [];

    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index];
      if (!reviewedManifestDigests.has(intent.reviewedManifestDigest)) {
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: 'review-not-in-union',
          message: 'The package review identity is absent from the captured union review.',
        });
        continue;
      }
      let resolved: FreshSaveSweepResolution;
      try {
        resolved = await this.deps.resolveIntent(intent);
      } catch (error) {
        results.push({
          ...base(intent),
          kind: 'halted-uncertain',
          code: 'inventory-refresh-failed',
          message: errorMessage(error),
        });
        this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
        return { results, halted: true, haltKind: 'uncertain' };
      }

      // This gate is intentionally repository-wide and precedes every mint.
      const iterationIndex = resolved.kind === 'candidate'
        ? resolved.context.indexFingerprint
        : resolved.indexFingerprint;
      if (freshIndexGate(iterationIndex).hasUnmerged) {
        for (const blocked of intents.slice(index)) {
          results.push({ ...base(blocked), kind: 'blocked-unmerged' });
        }
        return { results, halted: true, haltKind: 'unmerged' };
      }

      if (resolved.kind === 'already-saved') {
        results.push({
          ...base(intent),
          kind: 'already-saved',
          provingCommitOids: [...new Set(resolved.provingCommitOids)].sort(),
        });
        continue;
      }
      if (resolved.kind === 'needs-attention') {
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: resolved.code,
          message: resolved.message,
        });
        continue;
      }

      // The resolver may use live component/entry ids internally, but it may not
      // widen the durable finalization intent captured for this package.
      if (resolved.context.repository.repositoryKey !== intent.repositoryKey
          || resolved.selection.finalizationIds.length !== 1
          || resolved.selection.finalizationIds[0] !== intent.finalizationId) {
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: 'durable-intent-resolution-mismatch',
          message: 'The fresh package resolution no longer matches the reviewed finalization intent.',
        });
        continue;
      }

      let minted: ReturnType<CommitCandidateService['mintCandidateToken']>;
      try {
        // WP-4 owns review equivalence. Supplying its digest and atoms calls that
        // predicate before this method can mint the one just-in-time token.
        minted = this.deps.candidateService.mintCandidateToken({
          selectedComponentIds: [...resolved.selection.selectedComponentIds],
          selectedUnattributedEntryIds: [...resolved.selection.selectedUnattributedEntryIds],
          finalizationIds: [...resolved.selection.finalizationIds],
          acknowledgeTopologyDigest: null,
          acknowledgeUnattributedEntryIds: [],
          reviewedManifestDigest: intent.reviewedManifestDigest,
          acknowledgedChallengeAtoms,
        }, resolved.context);
      } catch (error) {
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: 'fresh-mint-refused',
          message: errorMessage(error),
        });
        continue;
      }

      if (!('candidateId' in minted) || !minted.token || !minted.eligibility.eligible) {
        const carry = reviewCarryVerdictFor(minted);
        const eligibilityReason = minted.eligibility.eligible
          ? 'token-missing'
          : minted.eligibility.reason;
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: carry && !carry.carried ? carry.reason : `mint-${eligibilityReason}`,
          message: carry && !carry.carried
            ? `The reviewed package could not be carried: ${carry.reason}.`
            : `The freshly resolved package could not mint: ${eligibilityReason}.`,
        });
        continue;
      }

      let consumed: SweepConsumableCoordinatorResult;
      try {
        consumed = await this.deps.consume({
          candidateId: minted.candidateId,
          tokenId: minted.token.tokenId,
          message: intent.message,
        });
      } catch (error) {
        results.push({
          ...base(intent),
          kind: 'halted-uncertain',
          code: 'commit-transport-failed',
          message: errorMessage(error),
        });
        this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
        return { results, halted: true, haltKind: 'uncertain' };
      }

      if (!consumed.attempt.created) {
        if (!('refusal' in consumed.response)) {
          results.push({
            ...base(intent),
            kind: 'halted-uncertain',
            code: 'coordinator-classification-invalid',
            message: 'The coordinator returned an invalid pre-consumption classification.',
          });
          this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
          return { results, halted: true, haltKind: 'uncertain' };
        }
        results.push({
          ...base(intent),
          kind: 'needs-attention',
          code: consumed.response.refusal.code,
          message: consumed.response.refusal.message,
        });
        continue;
      }

      if (consumed.reconciliation !== 'succeeded' || consumed.response.kind !== 'saved') {
        if (!('refusal' in consumed.response)) {
          results.push({
            ...base(intent),
            kind: 'halted-uncertain',
            code: 'coordinator-classification-invalid',
            message: 'The coordinator returned an invalid post-consumption classification.',
            attemptId: consumed.attempt.attemptId,
            ...(consumed.attempt.commitOid ? { commitOid: consumed.attempt.commitOid } : {}),
          });
          this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
          return { results, halted: true, haltKind: 'uncertain' };
        }
        results.push({
          ...base(intent),
          kind: 'halted-uncertain',
          code: consumed.response.refusal.code,
          message: consumed.response.refusal.message,
          attemptId: consumed.attempt.attemptId,
          ...(consumed.attempt.commitOid ? { commitOid: consumed.attempt.commitOid } : {}),
        });
        this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
        return { results, halted: true, haltKind: 'uncertain' };
      }

      try {
        await this.deps.refreshInventory(intent.repositoryKey);
      } catch (error) {
        results.push({
          ...base(intent),
          kind: 'halted-uncertain',
          code: 'post-save-inventory-refresh-failed',
          message: errorMessage(error),
          attemptId: consumed.attempt.attemptId,
          commitOid: consumed.attempt.commitOid,
        });
        this.markNotAttempted(results, intents.slice(index + 1), intent.finalizationId);
        return { results, halted: true, haltKind: 'uncertain' };
      }

      results.push({
        ...base(intent),
        kind: 'saved',
        attemptId: consumed.attempt.attemptId,
        commitOid: consumed.attempt.commitOid,
      });
    }

    return { results, halted: false, haltKind: null };
  }

  private markNotAttempted(
    results: SaveSweepTerminalResult[],
    intents: readonly SaveSweepIntent[],
    haltedAfterFinalizationId: string,
  ): void {
    for (const intent of intents) {
      results.push({
        ...base(intent),
        kind: 'not-attempted',
        haltedAfterFinalizationId,
      });
    }
  }
}
