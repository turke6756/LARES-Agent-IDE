import {
  listLatestPlanPackageGateAttempts,
  type PlanPackageGateAttempt,
  type PlanPackageGateOutcome,
} from '../database';
import type { ReachabilityProofResult } from './reachability-prover';
import {
  transitionPlanPackage,
  type CommitRef,
  type TransitionResult,
} from './package-ledger';

export const PRODUCTION_ENTRY_GATE_KEY = 'production-entry';

export interface PackageEvidenceIdentity {
  idempotencyKey: string;
  workspaceId: string;
  planId: string;
  planArtifactId: string;
  intentId: string;
  packageId: string;
  packageRevision: number;
}

export interface GateAttemptRequest extends PackageEvidenceIdentity {
  gateKey: string;
  gateRevision: number;
  attemptNo: number;
  finalizationId?: string | null;
}

export interface GateObservation {
  outcome: PlanPackageGateOutcome;
  actor: string;
  observedAt: number;
  witnessAgentId?: string | null;
  witnessSessionId?: string | null;
  witnessTurnId?: string | null;
  evidence?: unknown;
  verifiedCommits?: readonly CommitRef[];
}

/** Main-process adapters own the outcome. Ingestion callers only identify the attempt. */
export interface PackageGateWitness {
  observe(request: Readonly<GateAttemptRequest>): Promise<GateObservation> | GateObservation;
}

export type GateStatus =
  | { state: 'unknown'; attempt: null }
  | { state: 'known'; attempt: PlanPackageGateAttempt };

const FULL_OID = /^[0-9a-f]{40}$/i;

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`package-gates: ${field} must be non-empty`);
}

function validateRequest(request: GateAttemptRequest): void {
  for (const [field, value] of [
    ['idempotencyKey', request.idempotencyKey], ['workspaceId', request.workspaceId],
    ['planId', request.planId], ['planArtifactId', request.planArtifactId],
    ['intentId', request.intentId], ['packageId', request.packageId], ['gateKey', request.gateKey],
  ] as const) requireText(value, field);
  if (!Number.isSafeInteger(request.packageRevision) || request.packageRevision < 1) {
    throw new Error('package-gates: packageRevision must be a positive integer');
  }
  if (!Number.isSafeInteger(request.gateRevision) || request.gateRevision < 1) {
    throw new Error('package-gates: gateRevision must be a positive integer');
  }
  if (!Number.isSafeInteger(request.attemptNo) || request.attemptNo < 1) {
    throw new Error('package-gates: attemptNo must be a positive integer');
  }
}

function validateObservation(observation: GateObservation): void {
  if (!['pending', 'passed', 'failed', 'cancelled'].includes(observation.outcome)) {
    throw new Error('package-gates: witness returned an invalid outcome');
  }
  requireText(observation.actor, 'actor');
  if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
    throw new Error('package-gates: observedAt must be a non-negative integer');
  }
  const seen = new Set<string>();
  for (const ref of observation.verifiedCommits ?? []) {
    requireText(ref.repositoryKey, 'repositoryKey');
    if (!FULL_OID.test(ref.commitOid)) throw new Error('package-gates: full commit OID required');
    const key = `${ref.repositoryKey}\0${ref.commitOid.toLowerCase()}`;
    if (seen.has(key)) throw new Error('package-gates: duplicate verified commit');
    seen.add(key);
  }
}

export async function ingestGateAttempt(
  request: GateAttemptRequest,
  witness: PackageGateWitness,
): Promise<TransitionResult> {
  validateRequest(request);
  const observation = await witness.observe(Object.freeze({ ...request }));
  validateObservation(observation);
  return transitionPlanPackage({
    ...request,
    type: 'gate-decided',
  }, {
    kind: 'gate', actor: observation.actor, observedAt: observation.observedAt,
    outcome: observation.outcome, witnessAgentId: observation.witnessAgentId,
    witnessSessionId: observation.witnessSessionId, witnessTurnId: observation.witnessTurnId,
    evidence: observation.evidence, verifiedCommits: observation.verifiedCommits,
  });
}

export interface ProductionEntryWitness {
  prove(request: Readonly<GateAttemptRequest>): Promise<ReachabilityProofResult> | ReachabilityProofResult;
  actor: string;
  observedAt(): number;
  verifiedCommits?(proof: Readonly<ReachabilityProofResult>): readonly CommitRef[];
  witnessAgentId?: string | null;
  witnessSessionId?: string | null;
  witnessTurnId?: string | null;
}

/** The Cluster B outcome is derived from prover evidence, never supplied by the caller. */
export function ingestProductionEntryGate(
  request: Omit<GateAttemptRequest, 'gateKey'>,
  witness: ProductionEntryWitness,
): Promise<TransitionResult> {
  const gateRequest: GateAttemptRequest = { ...request, gateKey: PRODUCTION_ENTRY_GATE_KEY };
  return ingestGateAttempt(gateRequest, {
    async observe(frozenRequest) {
      const proof = await witness.prove(frozenRequest);
      if (proof.packageId !== frozenRequest.packageId) {
        throw new Error('package-gates: production-entry proof package mismatch');
      }
      if (!proof.evidenceRecorded) {
        throw new Error('package-gates: production-entry proof evidence was not recorded');
      }
      if (proof.obligations.length === 0) {
        throw new Error('package-gates: production-entry proof has no obligations');
      }
      if (proof.verdict === 'pass' && proof.obligations.some((item) => item.verdict !== 'pass')) {
        throw new Error('package-gates: inconsistent production-entry pass evidence');
      }
      return {
        outcome: proof.verdict === 'pass' ? 'passed' : 'failed',
        actor: witness.actor, observedAt: witness.observedAt(),
        witnessAgentId: witness.witnessAgentId, witnessSessionId: witness.witnessSessionId,
        witnessTurnId: witness.witnessTurnId, evidence: proof,
        verifiedCommits: witness.verifiedCommits?.(proof) ?? [],
      };
    },
  });
}

/** Absence is deliberately represented as unknown, never as a successful gate. */
export function readGateStatus(
  packageId: string, packageRevision: number, gateKey: string,
): GateStatus {
  const attempt = listLatestPlanPackageGateAttempts(packageId, packageRevision)
    .find((row) => row.gateKey === gateKey);
  return attempt ? { state: 'known', attempt } : { state: 'unknown', attempt: null };
}
