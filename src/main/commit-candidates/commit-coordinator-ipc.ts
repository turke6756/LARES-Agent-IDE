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
import type { IpcLike, SaveFunnelTelemetry } from './save-card-ipc';
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

type PreConsumeResponse = Extract<CommitCoordinatorConsumeResponse,
  { kind: 'token-unresolved' | 'invalid-message' | 'compose-in-flight' }>;

function passthroughResult(result: Exclude<CommitCoordinatorResult, { kind: 'outcome' }>): PreConsumeResponse {
  if (result.kind === 'token-unresolved') {
    return {
      ...result,
      refusal: {
        stage: 'token-consume', code: 'token-unresolved-or-expired',
        message: 'Token-consume stage refused because the candidate token is unresolved or expired.',
      },
    };
  }
  if (result.kind === 'invalid-message') {
    return {
      ...result,
      refusal: { stage: 'commit', code: 'commit-message-invalid', message: `Commit stage refused: ${result.reason}` },
    };
  }
  return {
    ...result,
    refusal: {
      stage: 'token-consume', code: 'token-consume-busy',
      message: 'Token-consume stage refused because another save holds the repository coordinator.',
    },
  };
}

export type SweepConsumableCoordinatorResult =
  | {
      attempt: { created: false };
      reconciliation: 'not-applicable';
      response: Extract<CommitCoordinatorConsumeResponse,
        { kind: 'token-unresolved' | 'invalid-message' | 'compose-in-flight' }>;
    }
  | {
      attempt: { created: true; attemptId: string; commitOid?: string };
      reconciliation: 'not-applicable' | 'failed';
      response: Extract<CommitCoordinatorConsumeResponse,
        { kind: 'outcome' | 'reconciliation-error' }>;
    }
  | {
      attempt: { created: true; attemptId: string; commitOid: string };
      reconciliation: 'succeeded';
      response: Extract<CommitCoordinatorConsumeResponse, { kind: 'saved' }>;
    };

/** Main-side consume adapter used by both IPC and the save sweep. It makes the
 * pre/post-consumption boundary explicit and keeps reconciliation inseparable
 * from the coordinator outcome. */
export async function consumeCommitCoordinatorForSweep(
  request: CommitCoordinatorConsumeRequest,
  routes: CommitCoordinatorRoutes,
  telemetry: SaveFunnelTelemetry = ({ stage, code }) => {
    console.info('[save-funnel]', { stage, code });
  },
): Promise<SweepConsumableCoordinatorResult> {
  const snapshot = routes.resolveCandidateToken(request.tokenId);
  if (!snapshot || snapshot.candidate.candidateId !== request.candidateId) {
    const response = passthroughResult({ kind: 'token-unresolved' });
    telemetry({ stage: 'token-consume', code: 'token-unresolved-or-expired' });
    return { attempt: { created: false }, reconciliation: 'not-applicable', response };
  }
  if (process.env.LARES_INTENT_PACKAGING === '1'
      && snapshot.token.contractVersion !== 2) {
    const response = passthroughResult({ kind: 'token-unresolved' });
    telemetry({ stage: 'token-consume', code: 'v2-token-required' });
    return { attempt: { created: false }, reconciliation: 'not-applicable', response };
  }

  const coordinated = await routes.coordinator.commit({
    tokenId: request.tokenId,
    message: request.message,
  });
  if (coordinated.kind !== 'outcome') {
    const response = passthroughResult(coordinated);
    if ('refusal' in response && response.refusal) {
      telemetry({ stage: response.refusal.stage, code: response.refusal.code });
    }
    return { attempt: { created: false }, reconciliation: 'not-applicable', response };
  }
  if (coordinated.outcome.status !== 'committed') {
    const stale = coordinated.outcome.status === 'aborted-stale';
    const detail = 'reason' in coordinated.outcome
      ? coordinated.outcome.reason
      : coordinated.outcome.status;
    const response = {
      kind: 'outcome',
      outcome: coordinated.outcome,
      refusal: {
        stage: 'commit',
        code: stale ? 'coordinator-stale' : `commit-${coordinated.outcome.status}`,
        message: stale
          ? `Commit stage refused because coordinator state is stale: ${detail}`
          : `Commit stage refused: ${detail}.`,
        ...('mismatchedPaths' in coordinated.outcome
          ? { paths: coordinated.outcome.mismatchedPaths.map((path) => path.pathBytesBase64) }
          : {}),
      },
    } satisfies CommitCoordinatorConsumeResponse;
    telemetry({ stage: response.refusal.stage, code: response.refusal.code });
    const commitOid = 'commitOid' in coordinated.outcome ? coordinated.outcome.commitOid : undefined;
    return {
      attempt: {
        created: true,
        attemptId: coordinated.outcome.attemptId,
        ...(commitOid ? { commitOid } : {}),
      },
      reconciliation: 'not-applicable',
      response,
    };
  }

  if (snapshot.token.contractVersion === 2) {
    const response = {
      kind: 'saved',
      outcome: coordinated.outcome,
      finalizations: snapshot.candidate.finalizations.map((row) => ({
        finalizationId: row.finalizationId,
        closed: true,
        lifecycleStatus: 'committed' as const,
        members: snapshot.candidate.members
          .filter((member) => member.coveringFinalizationIds.includes(row.finalizationId))
          .map((member) => ({
            pathBytesBase64: member.path.pathBytesBase64,
            disposition: { state: 'selected-in-candidate' as const, entryId: member.entryId },
          })),
      })),
    } satisfies CommitCoordinatorConsumeResponse;
    telemetry({ stage: 'reconciliation', code: 'save-verified' });
    return {
      attempt: { created: true, attemptId: coordinated.outcome.attemptId, commitOid: coordinated.outcome.commitOid },
      reconciliation: 'succeeded', response,
    };
  }

  const repository = routes.locateRepository(snapshot);
  const reconcile = routes.reconcileCommitted ?? reconcileCommittedCandidate;
  let reconciled: ReconcileCommittedCandidateResult;
  try {
    reconciled = await reconcile({
      outcome: coordinated.outcome,
      snapshot,
      ...repository,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response = {
      kind: 'reconciliation-error',
      outcome: coordinated.outcome,
      error: { code: 'reconciliation-transport-error', message },
      refusal: {
        stage: 'reconciliation',
        code: 'reconciliation-transport-error',
        message: `Reconciliation stage refused: ${message}`,
      },
    } satisfies CommitCoordinatorConsumeResponse;
    telemetry({ stage: response.refusal.stage, code: response.refusal.code });
    return {
      attempt: {
        created: true,
        attemptId: coordinated.outcome.attemptId,
        commitOid: coordinated.outcome.commitOid,
      },
      reconciliation: 'failed',
      response,
    };
  }
  if (!reconciled.ok) {
    const response = {
      kind: 'reconciliation-error',
      outcome: coordinated.outcome,
      error: reconciled.error,
      refusal: {
        stage: 'reconciliation',
        code: reconciled.error.code,
        message: `Reconciliation stage refused: ${reconciled.error.message}`,
      },
    } satisfies CommitCoordinatorConsumeResponse;
    telemetry({ stage: response.refusal.stage, code: response.refusal.code });
    return {
      attempt: {
        created: true,
        attemptId: coordinated.outcome.attemptId,
        commitOid: coordinated.outcome.commitOid,
      },
      reconciliation: 'failed',
      response,
    };
  }
  const response = {
    kind: 'saved',
    outcome: coordinated.outcome,
    finalizations: reconciled.finalizations,
  } satisfies CommitCoordinatorConsumeResponse;
  telemetry({ stage: 'reconciliation', code: 'save-verified' });
  return {
    attempt: {
      created: true,
      attemptId: coordinated.outcome.attemptId,
      commitOid: coordinated.outcome.commitOid,
    },
    reconciliation: 'succeeded',
    response,
  };
}

/** Register the shared Save/Plan consume channel. `isCoordinatorEnabled` is read
 * for every invocation so the disabled-route test remains stable after WP-4K
 * flips the production constant. The flag is checked before route resolution. */
export function registerCommitCoordinatorIpc(
  ipc: IpcLike,
  getRoutes: () => CommitCoordinatorRoutes | null,
  isCoordinatorEnabled: () => boolean = () => SAVE_CARD_COMMIT_COORDINATOR_ENABLED,
  telemetry: SaveFunnelTelemetry = ({ stage, code }) => {
    console.info('[save-funnel]', { stage, code });
  },
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
    return (await consumeCommitCoordinatorForSweep(request, routes, telemetry)).response;
  });
}
