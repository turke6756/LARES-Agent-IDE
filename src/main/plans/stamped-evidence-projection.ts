// WP-SEP — branch-independent projections over the immutable turn spine.
//
// These functions deliberately accept rows rather than reading the database. That
// keeps the evidence seam pure and lets the board and the lightweight fallback use
// it without importing either planning registry. Turn status is evidence only:
// neither projection infers plan/package completion.

import type {
  PersistedTurnPlanStampSource,
  RecoveryOperation,
  TurnRecord,
  TurnWitnessEntry,
} from '../database';

export type PlanStampStatus = 'verified' | 'unstamped' | 'unverified';

export interface StampedTurnAnnotation {
  planId: string | null;
  planItemId: string | null;
  planStampSource: PersistedTurnPlanStampSource | null;
  planStampStatus: PlanStampStatus;
}

export interface LiveStampedActivity extends StampedTurnAnnotation {
  turnId: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  taskLabel: string | null;
  startedAt: number | null;
  touched: TurnWitnessEntry[];
  /** True only for an open, verified plan-bound turn; touches are evidence, not a gate. */
  isActive: boolean;
}

export interface DurableStampedTurn extends StampedTurnAnnotation {
  turnId: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  taskLabel: string | null;
  startedAt: number | null;
  endedAt: number | null;
  touched: TurnWitnessEntry[];
  /** Stored by retention's distill-before-prune backfill; never recomputed here. */
  diffStats: unknown | null;
  /** Stored witnessed-path compact diff; never read from pin accounting. */
  compactDiff: string | null;
  compactDiffProvenance: string | null;
}

export interface DurableRecoveryOperation {
  operationId: string;
  workspaceId: string;
  kind: 'restore_paths' | 'revert_turn';
  actor: string;
  sourceTurnId: string | null;
  status: RecoveryOperation['status'];
  requestedPaths: unknown | null;
  completedPaths: unknown | null;
  result: string | null;
  failureReason: string | null;
  createdAt: number | null;
  endedAt: number | null;
}

export interface DurableStampedTrail {
  acceptedTurns: DurableStampedTurn[];
  recoveryOperations: DurableRecoveryOperation[];
}

const VERIFIED_STAMP_SOURCES: ReadonlySet<string> = new Set([
  'explicit',
  'agent-default',
  'fork-carry',
  'revive-carry',
  'continuation-carry',
]);

const EXPLICITLY_UNSTAMPED_SOURCES: ReadonlySet<string> = new Set([
  'legacy-unstamped',
  'explicit-none',
  'unbound-manual',
]);

function annotateStamp(turn: TurnRecord): StampedTurnAnnotation {
  const source = turn.planStampSource ?? null;
  const planId = turn.planId ?? null;
  const planItemId = turn.planItemId ?? null;

  // A package stamp without its plan is structurally incoherent. Likewise, the
  // explicit no-plan sources may never establish attribution even if a malformed
  // adapter happens to attach ids. Fail closed in both cases.
  if (planItemId !== null && planId === null) {
    return { planId: null, planItemId: null, planStampSource: source, planStampStatus: 'unverified' };
  }
  if (source !== null && EXPLICITLY_UNSTAMPED_SOURCES.has(source)) {
    const status = planId === null && planItemId === null ? 'unstamped' : 'unverified';
    return { planId: null, planItemId: null, planStampSource: source, planStampStatus: status };
  }
  if (source !== null && VERIFIED_STAMP_SOURCES.has(source)) {
    if (planId === null) {
      return { planId: null, planItemId: null, planStampSource: source, planStampStatus: 'unstamped' };
    }
    return { planId, planItemId, planStampSource: source, planStampStatus: 'verified' };
  }
  return { planId: null, planItemId: null, planStampSource: source, planStampStatus: 'unverified' };
}

function witnessedTouches(turn: TurnRecord): TurnWitnessEntry[] {
  return (turn.touched ?? [])
    .filter((entry) => entry.op === 'write' || entry.op === 'create')
    .map((entry) => ({ ...entry }));
}

/** Project current activity. An open turn alone is never a completion signal. */
export function projectLiveStampedActivity(
  turns: readonly TurnRecord[],
): LiveStampedActivity[] {
  return turns
    .filter((turn) => turn.status === 'open')
    .map((turn) => {
      const stamp = annotateStamp(turn);
      const touched = witnessedTouches(turn);
      return {
        turnId: turn.id,
        workspaceId: turn.workspaceId,
        turnSeq: turn.turnSeq,
        agentId: turn.agentId,
        taskLabel: turn.taskLabel,
        startedAt: turn.startedAt,
        touched,
        ...stamp,
        isActive: stamp.planStampStatus === 'verified',
      };
    });
}

/**
 * Project durable accepted-turn evidence and recovery history. `diffStats` and
 * `compactDiff` are the values already persisted by retention.ts; this projection
 * never derives diffs, inspects refs, reads finalization state, or accounts pins.
 */
export function projectDurableStampedTrail(
  turns: readonly TurnRecord[],
  recoveryOperations: readonly RecoveryOperation[],
): DurableStampedTrail {
  const acceptedTurns = turns
    .filter((turn) => turn.status === 'accepted')
    .map((turn): DurableStampedTurn => ({
      turnId: turn.id,
      workspaceId: turn.workspaceId,
      turnSeq: turn.turnSeq,
      agentId: turn.agentId,
      taskLabel: turn.taskLabel,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      touched: witnessedTouches(turn),
      diffStats: turn.diffStats,
      compactDiff: turn.compactDiff,
      compactDiffProvenance: turn.compactDiffProvenance,
      ...annotateStamp(turn),
    }));

  const projectedRecovery = recoveryOperations
    .filter((operation): operation is RecoveryOperation & {
      kind: 'restore_paths' | 'revert_turn';
    } => operation.kind === 'restore_paths' || operation.kind === 'revert_turn')
    .map((operation): DurableRecoveryOperation => ({
      operationId: operation.id,
      workspaceId: operation.workspaceId,
      kind: operation.kind,
      actor: operation.actor,
      sourceTurnId: operation.sourceTurnId,
      status: operation.status,
      requestedPaths: operation.requestedPaths,
      completedPaths: operation.completedPaths,
      result: operation.result,
      failureReason: operation.failureReason,
      createdAt: operation.createdAt,
      endedAt: operation.endedAt,
    }));

  return { acceptedTurns, recoveryOperations: projectedRecovery };
}
