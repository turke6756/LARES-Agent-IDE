// Save-card SC-WP-4E — lens-neutral CommitCoordinator IPC response path.
//
// This transport intentionally does not construct CommitCoordinator or wire its
// production reassembly/repository/trailer seams. Bootstrap code injects a route
// object later, just as the other Save-card IPC registrations use lazy route
// getters. The handler owns the mandatory ordering: flag → identity bind → 4D →
// 4G → renderer response. A committed 4D outcome is never called `saved` until
// 4G has returned success.

import { SAVE_CARD_COMMIT_COORDINATOR_ENABLED } from '../../shared/constants';
import {
  COMMIT_COORDINATOR_CHANNEL,
  type CommitCoordinatorConsumeRequest,
  type CommitCoordinatorConsumeResponse,
} from '../../shared/types';
import type { CandidateTokenSnapshot } from './candidate-service';
import type { IpcLike } from './save-card-ipc';
import type {
  CommitCoordinator,
  CommitCoordinatorResult,
} from '../git-checkpoints/commit-coordinator';
import {
  reconcileCommittedCandidate,
  type ReconcileCommittedCandidateInput,
  type ReconcileCommittedCandidateResult,
} from '../git-checkpoints/commit-reconciler';

export class CommitCoordinatorIpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CommitCoordinatorIpcError';
  }
}

export interface CommitCoordinatorRoutes {
  /** The already-composed 4D instance. Production constructor seams remain open
   * to the later bootstrap WP rather than being guessed in this IPC module. */
  coordinator: Pick<CommitCoordinator, 'commit'>;
  /** Read-only snapshot resolution binds candidateId to the opaque token before
   * the coordinator consumes and invalidates that token. */
  resolveCandidateToken(tokenId: string): CandidateTokenSnapshot | null;
  locateRepository(snapshot: CandidateTokenSnapshot): { repoRoot: string; gitExe?: string };
  /** Test-overridable 4G closure API; defaults to the landed implementation. */
  reconcileCommitted?: (
    input: ReconcileCommittedCandidateInput,
  ) => Promise<ReconcileCommittedCandidateResult>;
}

function requireRequest(raw: unknown): CommitCoordinatorConsumeRequest {
  if (!raw || typeof raw !== 'object') {
    throw new CommitCoordinatorIpcError('a commit candidate request is required', 'commit-coordinator-bad-request');
  }
  const request = raw as Record<string, unknown>;
  if (typeof request.candidateId !== 'string' || request.candidateId === '') {
    throw new CommitCoordinatorIpcError('a non-empty candidateId is required', 'commit-coordinator-bad-request');
  }
  if (typeof request.tokenId !== 'string' || request.tokenId === '') {
    throw new CommitCoordinatorIpcError('a non-empty tokenId is required', 'commit-coordinator-bad-request');
  }
  if (typeof request.message !== 'string') {
    throw new CommitCoordinatorIpcError('message must be a string', 'commit-coordinator-bad-request');
  }
  return {
    candidateId: request.candidateId,
    tokenId: request.tokenId,
    message: request.message,
  };
}

function requireRoutes(routes: CommitCoordinatorRoutes | null): CommitCoordinatorRoutes {
  if (!routes) {
    throw new CommitCoordinatorIpcError(
      'commit coordinator unavailable (the engine has not finished bootstrapping)',
      'commit-coordinator-unavailable',
    );
  }
  return routes;
}

function passthroughResult(result: Exclude<CommitCoordinatorResult, { kind: 'outcome' }>): CommitCoordinatorConsumeResponse {
  return result;
}

/** Register the shared Save/Plan consume channel. `isCoordinatorEnabled` is read
 * for every invocation so the disabled-route test remains stable after WP-4K
 * flips the production constant. The flag is checked before route resolution. */
export function registerCommitCoordinatorIpc(
  ipc: IpcLike,
  getRoutes: () => CommitCoordinatorRoutes | null,
  isCoordinatorEnabled: () => boolean = () => SAVE_CARD_COMMIT_COORDINATOR_ENABLED,
): void {
  ipc.handle(COMMIT_COORDINATOR_CHANNEL, async (_event, raw: unknown) => {
    if (!isCoordinatorEnabled()) {
      throw new CommitCoordinatorIpcError(
        'commit coordinator is disabled',
        'commit-coordinator-disabled',
      );
    }

    const request = requireRequest(raw);
    const routes = requireRoutes(getRoutes());
    const snapshot = routes.resolveCandidateToken(request.tokenId);
    if (!snapshot || snapshot.candidate.candidateId !== request.candidateId) {
      return { kind: 'token-unresolved' } satisfies CommitCoordinatorConsumeResponse;
    }

    const coordinated = await routes.coordinator.commit({
      tokenId: request.tokenId,
      message: request.message,
    });
    if (coordinated.kind !== 'outcome') return passthroughResult(coordinated);
    if (coordinated.outcome.status !== 'committed') {
      return { kind: 'outcome', outcome: coordinated.outcome } satisfies CommitCoordinatorConsumeResponse;
    }

    const repository = routes.locateRepository(snapshot);
    const reconcile = routes.reconcileCommitted ?? reconcileCommittedCandidate;
    const reconciled = await reconcile({
      outcome: coordinated.outcome,
      snapshot,
      ...repository,
    });
    if (!reconciled.ok) {
      return {
        kind: 'reconciliation-error',
        outcome: coordinated.outcome,
        error: reconciled.error,
      } satisfies CommitCoordinatorConsumeResponse;
    }
    return {
      kind: 'saved',
      outcome: coordinated.outcome,
      finalizations: reconciled.finalizations,
    } satisfies CommitCoordinatorConsumeResponse;
  });
}
