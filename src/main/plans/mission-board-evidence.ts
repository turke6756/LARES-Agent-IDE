// WP-P6A — package/plan evidence shapes for the live mission board.
//
// This is a pure adapter over WP-SEP. It neither reads nor writes package state.
// In particular, an open turn or witnessed path is activity evidence only.

import type { PlanWorkPackage, PlanWorkPackagePath, TurnWitnessEntry } from '../database';
import type {
  DurableRecoveryOperation,
  DurableStampedTrail,
  DurableStampedTurn,
  LiveStampedActivity,
  PlanStampStatus,
} from './stamped-evidence-projection';

export type PackageEvidenceAssociation = 'package-stamp' | 'planned-path';

export interface PackageLiveActivity extends LiveStampedActivity {
  association: PackageEvidenceAssociation;
  /** For planned-path association this is the matching subset; package stamps retain every witnessed touch. */
  touched: TurnWitnessEntry[];
}

export interface PackageDurableTurn extends DurableStampedTurn {
  association: PackageEvidenceAssociation;
  /** For planned-path association this is the matching subset; package stamps retain every witnessed touch. */
  touched: TurnWitnessEntry[];
}

export interface PackageRecoveryOperation extends DurableRecoveryOperation {
  /** Recovery follows the accepted source turn; it never creates attribution by itself. */
  association: 'source-turn';
}

export interface MissionBoardPackageEvidence {
  packageId: string;
  liveActivity: PackageLiveActivity[];
  durableTurns: PackageDurableTurn[];
  recoveryOperations: PackageRecoveryOperation[];
}

export interface MissionBoardStampAnnotation {
  turnId: string;
  phase: 'live' | 'durable';
  planStampStatus: Exclude<PlanStampStatus, 'verified'>;
  planStampSource: LiveStampedActivity['planStampSource'];
  agentId: string | null;
  taskLabel: string | null;
  /** Always false: this warning is visibility, not plan/package attribution. */
  attributed: false;
}

export interface MissionBoardPlanEvidence {
  workspaceId: string;
  planId: string;
  packages: MissionBoardPackageEvidence[];
  /** Verified plan-bound turns that could not be associated with a current package. */
  unassignedLiveActivity: LiveStampedActivity[];
  unassignedDurableTurns: DurableStampedTurn[];
  /** Workspace turns whose stamps cannot establish attribution. */
  stampAnnotations: MissionBoardStampAnnotation[];
}

export interface MissionBoardEvidenceInput {
  workspaceId: string;
  planId: string;
  packages: readonly PlanWorkPackage[];
  plannedPaths: readonly PlanWorkPackagePath[];
  liveActivity: readonly LiveStampedActivity[];
  durableTrail: DurableStampedTrail;
}

interface TurnAssociation<T extends LiveStampedActivity | DurableStampedTurn> {
  turn: T;
  association: PackageEvidenceAssociation;
  touched: TurnWitnessEntry[];
}

function associateTurn<T extends LiveStampedActivity | DurableStampedTurn>(
  turn: T,
  pkg: PlanWorkPackage,
  packagePaths: ReadonlySet<string>,
  workspaceId: string,
  planId: string,
): TurnAssociation<T> | null {
  if (turn.workspaceId !== workspaceId
      || turn.planStampStatus !== 'verified'
      || turn.planId !== planId) {
    return null;
  }

  if (turn.planItemId !== null) {
    return turn.planItemId === pkg.id
      ? { turn, association: 'package-stamp', touched: turn.touched.map((entry) => ({ ...entry })) }
      : null;
  }

  const touched = turn.touched
    .filter((entry) => packagePaths.has(entry.path))
    .map((entry) => ({ ...entry }));
  return touched.length > 0 ? { turn, association: 'planned-path', touched } : null;
}

function stampAnnotation(
  turn: LiveStampedActivity | DurableStampedTurn,
  phase: 'live' | 'durable',
): MissionBoardStampAnnotation | null {
  if (turn.planStampStatus === 'verified') return null;
  return {
    turnId: turn.turnId,
    phase,
    planStampStatus: turn.planStampStatus,
    planStampSource: turn.planStampSource,
    agentId: turn.agentId,
    taskLabel: turn.taskLabel,
    attributed: false,
  };
}

/**
 * Adapt WP-SEP output to board evidence grouped by the current plan's packages.
 * Package rows are used only as identity/ownership boundaries; their lifecycle
 * state is deliberately absent from this projection.
 */
export function projectMissionBoardEvidence(
  input: MissionBoardEvidenceInput,
): MissionBoardPlanEvidence {
  const packages = input.packages.filter(
    (pkg) => pkg.workspaceId === input.workspaceId && pkg.planId === input.planId,
  );
  const pathSets = new Map<string, Set<string>>();
  for (const planned of input.plannedPaths) {
    if (planned.workspaceId !== input.workspaceId) continue;
    const pkg = packages.find((candidate) => candidate.id === planned.packageId);
    if (!pkg) continue;
    const paths = pathSets.get(pkg.id) ?? new Set<string>();
    paths.add(planned.path);
    pathSets.set(pkg.id, paths);
  }

  const associatedLive = new Set<string>();
  const associatedDurable = new Set<string>();
  const packageEvidence = packages.map((pkg): MissionBoardPackageEvidence => {
    const packagePaths = pathSets.get(pkg.id) ?? new Set<string>();
    const liveActivity = input.liveActivity.flatMap((turn): PackageLiveActivity[] => {
      const match = associateTurn(turn, pkg, packagePaths, input.workspaceId, input.planId);
      if (!match) return [];
      associatedLive.add(turn.turnId);
      return [{ ...turn, association: match.association, touched: match.touched }];
    });
    const durableTurns = input.durableTrail.acceptedTurns.flatMap((turn): PackageDurableTurn[] => {
      const match = associateTurn(turn, pkg, packagePaths, input.workspaceId, input.planId);
      if (!match) return [];
      associatedDurable.add(turn.turnId);
      return [{ ...turn, association: match.association, touched: match.touched }];
    });
    const sourceTurnIds = new Set(durableTurns.map((turn) => turn.turnId));
    const recoveryOperations = input.durableTrail.recoveryOperations
      .filter((operation) => operation.workspaceId === input.workspaceId
        && operation.sourceTurnId !== null
        && sourceTurnIds.has(operation.sourceTurnId))
      .map((operation): PackageRecoveryOperation => ({ ...operation, association: 'source-turn' }));
    return { packageId: pkg.id, liveActivity, durableTurns, recoveryOperations };
  });

  const isTargetPlanTurn = (turn: LiveStampedActivity | DurableStampedTurn): boolean =>
    turn.workspaceId === input.workspaceId
      && turn.planStampStatus === 'verified'
      && turn.planId === input.planId;

  const stampAnnotations = [
    ...input.liveActivity
      .filter((turn) => turn.workspaceId === input.workspaceId)
      .map((turn) => stampAnnotation(turn, 'live')),
    ...input.durableTrail.acceptedTurns
      .filter((turn) => turn.workspaceId === input.workspaceId)
      .map((turn) => stampAnnotation(turn, 'durable')),
  ].filter((annotation): annotation is MissionBoardStampAnnotation => annotation !== null);

  return {
    workspaceId: input.workspaceId,
    planId: input.planId,
    packages: packageEvidence,
    unassignedLiveActivity: input.liveActivity
      .filter((turn) => isTargetPlanTurn(turn) && !associatedLive.has(turn.turnId)),
    unassignedDurableTurns: input.durableTrail.acceptedTurns
      .filter((turn) => isTargetPlanTurn(turn) && !associatedDurable.has(turn.turnId)),
    stampAnnotations,
  };
}
