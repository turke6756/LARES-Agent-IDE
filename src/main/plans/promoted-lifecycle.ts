import type { MissionBoardPackageState } from '../../shared/types';
import { derivePackageRollup, type PackageRollup, type PackageStateCounts } from '../../shared/package-rollup';
import type { TurnRecord } from '../database';
import { projectLiveStampedActivity } from './stamped-evidence-projection';

export type PromotedPlanLifecycle = 'hardening' | 'ready' | 'executing' | 'archived' | 'unknown';

export interface PromotedLifecycleSnapshot {
  lifecycle: PromotedPlanLifecycle;
  rollup: PackageRollup | null;
  activeVerifiedTurnCount: number;
}

export interface PromotedLifecycleInput {
  planId: string;
  runState: string | null | undefined;
  packages: ReadonlyArray<{ state: MissionBoardPackageState }>;
  turns: readonly TurnRecord[];
}

const LIFECYCLES: ReadonlySet<string> = new Set(['hardening', 'ready', 'executing', 'archived']);

function lifecycleFromRunState(runState: string | null | undefined): PromotedPlanLifecycle {
  return runState !== null && runState !== undefined && LIFECYCLES.has(runState)
    ? runState as PromotedPlanLifecycle
    : 'unknown';
}

function rollupFromPackages(
  packages: ReadonlyArray<{ state: MissionBoardPackageState }>,
): PackageRollup | null {
  if (packages.length === 0) return null;
  const counts: PackageStateCounts = { ready: 0, executing: 0, blocked: 0, done: 0, archived: 0 };
  for (const pkg of packages) counts[pkg.state] += 1;
  return derivePackageRollup(counts);
}

export function derivePromotedLifecycle(input: PromotedLifecycleInput): PromotedLifecycleSnapshot {
  return {
    lifecycle: lifecycleFromRunState(input.runState),
    rollup: rollupFromPackages(input.packages),
    activeVerifiedTurnCount: projectLiveStampedActivity(input.turns)
      .filter((turn) => turn.isActive && turn.planId === input.planId)
      .length,
  };
}
