import {
  listLatestPlanPackageDeploymentEvents,
  type PlanPackageDeploymentEvent,
  type PlanPackageDeploymentState,
} from '../database';
import {
  transitionPlanPackage,
  type TransitionResult,
} from './package-ledger';
import type { PackageEvidenceIdentity } from './package-gates';

export interface DeploymentRequest extends PackageEvidenceIdentity {
  environment: string;
}

export interface DeploymentObservation {
  state: PlanPackageDeploymentState;
  actor: string;
  observedAt: number;
  repositoryKey?: string | null;
  commitOid?: string | null;
  witnessAgentId?: string | null;
  witnessSessionId?: string | null;
  detail?: unknown;
}

/** Reserved for a real main-process deployment integration. */
export interface PackageDeploymentAdapter {
  observe(request: Readonly<DeploymentRequest>): Promise<DeploymentObservation> | DeploymentObservation;
}

export type DeploymentStatus =
  | { state: 'unknown'; event: null }
  | { state: 'known'; event: PlanPackageDeploymentEvent };

const FULL_OID = /^[0-9a-f]{40}$/i;

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`package-deployments: ${field} must be non-empty`);
}

function validateRequest(request: DeploymentRequest): void {
  for (const [field, value] of [
    ['idempotencyKey', request.idempotencyKey], ['workspaceId', request.workspaceId],
    ['planId', request.planId], ['planArtifactId', request.planArtifactId],
    ['intentId', request.intentId], ['packageId', request.packageId],
    ['environment', request.environment],
  ] as const) requireText(value, field);
  if (!Number.isSafeInteger(request.packageRevision) || request.packageRevision < 1) {
    throw new Error('package-deployments: packageRevision must be a positive integer');
  }
}

function validateObservation(observation: DeploymentObservation): void {
  if (!['not_required', 'not_deployed', 'deploying', 'deployed', 'failed', 'rolled_back']
    .includes(observation.state)) {
    throw new Error('package-deployments: adapter returned an invalid state');
  }
  requireText(observation.actor, 'actor');
  if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
    throw new Error('package-deployments: observedAt must be a non-negative integer');
  }
  const hasRepository = observation.repositoryKey !== undefined && observation.repositoryKey !== null;
  const hasCommit = observation.commitOid !== undefined && observation.commitOid !== null;
  if (hasRepository !== hasCommit) {
    throw new Error('package-deployments: repositoryKey and commitOid must be supplied together');
  }
  if (observation.repositoryKey !== undefined && observation.repositoryKey !== null) {
    requireText(observation.repositoryKey, 'repositoryKey');
  }
  if (observation.commitOid !== undefined && observation.commitOid !== null
      && !FULL_OID.test(observation.commitOid)) {
    throw new Error('package-deployments: full commit OID required');
  }
}

export async function ingestDeploymentEvent(
  request: DeploymentRequest,
  adapter: PackageDeploymentAdapter,
): Promise<TransitionResult> {
  validateRequest(request);
  const observation = await adapter.observe(Object.freeze({ ...request }));
  validateObservation(observation);
  return transitionPlanPackage({ ...request, type: 'deployment-observed' }, {
    kind: 'deployment', actor: observation.actor, observedAt: observation.observedAt,
    environment: request.environment, state: observation.state,
    repositoryKey: observation.repositoryKey, commitOid: observation.commitOid,
    witnessAgentId: observation.witnessAgentId, witnessSessionId: observation.witnessSessionId,
    detail: observation.detail,
  });
}

export interface ExplicitDeploymentWitness {
  actor: string;
  observedAt: number;
  witnessAgentId?: string | null;
  witnessSessionId?: string | null;
  rationale: string;
}

function explicitAdapter(
  state: 'not_deployed' | 'not_required', witness: ExplicitDeploymentWitness,
): PackageDeploymentAdapter {
  requireText(witness.rationale, 'rationale');
  return { observe: () => ({
    state, actor: witness.actor, observedAt: witness.observedAt,
    witnessAgentId: witness.witnessAgentId, witnessSessionId: witness.witnessSessionId,
    detail: { rationale: witness.rationale, adapter: 'none' },
  }) };
}

/** No adapter exists yet: record the honest explicit state, never infer it from git. */
export function recordNotDeployed(
  request: DeploymentRequest, witness: ExplicitDeploymentWitness,
): Promise<TransitionResult> {
  return ingestDeploymentEvent(request, explicitAdapter('not_deployed', witness));
}

/** Use only where deployment is explicitly outside the package contract. */
export function recordDeploymentNotRequired(
  request: DeploymentRequest, witness: ExplicitDeploymentWitness,
): Promise<TransitionResult> {
  return ingestDeploymentEvent(request, explicitAdapter('not_required', witness));
}

/** Absence is deliberately represented as unknown, never as not_required. */
export function readDeploymentStatus(
  packageId: string, packageRevision: number, environment: string,
): DeploymentStatus {
  const event = listLatestPlanPackageDeploymentEvents(packageId, packageRevision)
    .find((row) => row.environment === environment);
  return event ? { state: 'known', event } : { state: 'unknown', event: null };
}
