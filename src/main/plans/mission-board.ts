// WP-P6B-query — read-only card projection for the live mission board.
//
// Structured package lifecycle state and transient turn activity deliberately
// travel through separate fields. This module performs no state transitions and
// activity evidence has no vocabulary that can represent package completion.

import type { MissionBoardCard } from '../../shared/types';
import {
  getPlan,
  listPlanWorkPackagePaths,
  listPlanWorkPackagesOrdered,
  listRecoveryOperations,
  listTurnRecords,
} from '../database';
import type {
  PlanWorkPackage,
  PlanWorkPackagePath,
  RecoveryOperation,
  TurnRecord,
} from '../database';
import { projectMissionBoardEvidence } from './mission-board-evidence';
import {
  projectDurableStampedTrail,
  projectLiveStampedActivity,
} from './stamped-evidence-projection';

export interface MissionBoardQueryDeps {
  getPlanWorkspaceId: (planId: string) => string | null;
  listPackages: (planId: string) => PlanWorkPackage[];
  listPaths: (packageId: string) => PlanWorkPackagePath[];
  listTurns: (workspaceId: string) => TurnRecord[];
  listRecovery: (workspaceId: string) => RecoveryOperation[];
}

function defaultMissionBoardQueryDeps(): MissionBoardQueryDeps {
  return {
    getPlanWorkspaceId: (planId) => getPlan(planId)?.workspaceId ?? null,
    listPackages: listPlanWorkPackagesOrdered,
    listPaths: listPlanWorkPackagePaths,
    // Match the bounded evidence window established by WP-P6A's real-SQL fixture.
    listTurns: (workspaceId) => listTurnRecords(workspaceId, { limit: 200 }),
    listRecovery: (workspaceId) => listRecoveryOperations(workspaceId),
  };
}

/**
 * Read the current card model for one plan. A missing plan produces an empty
 * board; malformed IPC inputs are rejected by the registrar in plan-ipc.ts.
 * Re-running this function always re-reads turn rows, which is the live tick-in
 * seam used by the bounded polling transport in the next work package.
 */
export function listMissionBoardCards(
  planId: string,
  deps: MissionBoardQueryDeps = defaultMissionBoardQueryDeps(),
): MissionBoardCard[] {
  const workspaceId = deps.getPlanWorkspaceId(planId);
  if (workspaceId === null) return [];

  // Fail closed on a malformed cross-workspace row. The plan row establishes
  // the board's workspace boundary; a package never gets to widen it.
  const packages = deps.listPackages(planId).filter(
    (pkg) => pkg.planId === planId && pkg.workspaceId === workspaceId,
  );
  const plannedPaths = packages.flatMap((pkg) => deps.listPaths(pkg.id)).filter(
    (entry) => entry.workspaceId === workspaceId,
  );
  const turns = deps.listTurns(workspaceId);
  const evidence = projectMissionBoardEvidence({
    workspaceId,
    planId,
    packages,
    plannedPaths,
    liveActivity: projectLiveStampedActivity(turns),
    durableTrail: projectDurableStampedTrail(turns, deps.listRecovery(workspaceId)),
  });
  const evidenceByPackage = new Map(evidence.packages.map((entry) => [entry.packageId, entry]));
  const pathsByPackage = new Map<string, PlanWorkPackagePath[]>();
  for (const entry of plannedPaths) {
    const rows = pathsByPackage.get(entry.packageId) ?? [];
    rows.push(entry);
    pathsByPackage.set(entry.packageId, rows);
  }

  return packages.map((pkg): MissionBoardCard => {
    const packageEvidence = evidenceByPackage.get(pkg.id);
    return {
      packageId: pkg.id,
      workspaceId: pkg.workspaceId,
      planId: pkg.planId,
      title: pkg.title,
      acceptanceCondition: pkg.acceptanceCondition,
      // Verbatim SC-WP-3A state. No activity-derived rewrite belongs here.
      state: pkg.state,
      assigneeAgentId: pkg.assigneeAgentId,
      revision: pkg.revision,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      plannedPaths: (pathsByPackage.get(pkg.id) ?? []).map((entry) => ({
        path: entry.path,
        intentKind: entry.intentKind,
      })),
      liveActivity: packageEvidence?.liveActivity ?? [],
      durableTurns: packageEvidence?.durableTurns ?? [],
      recoveryOperations: packageEvidence?.recoveryOperations ?? [],
    };
  });
}
