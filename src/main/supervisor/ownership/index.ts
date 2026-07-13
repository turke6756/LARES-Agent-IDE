// Durable CLI-process ownership subsystem (incident-2026-07-11 D4, rev-4).
// Barrel re-export for the supervisor / API seams.

export * from './types';
export * from './tree-walk';
export { OwnershipStore, ensureOwnershipSchema } from './ownership-store';
export type { OwnershipStoreDeps, ReapAction, ReapOutcome } from './ownership-store';
export { Reaper } from './reaper';
export type { ReaperDeps, TerminalAgentRef, SweepResult, ReapRecord } from './reaper';
export { ReconcileGate } from './reconcile-gate';
export type { ReconcileGateDeps, GateAction, GateResolution, UserResolution } from './reconcile-gate';
export { createProcessLister } from './process-lister';
export { listOrphanCandidates, reapOrphans } from './orphan-sweep';
export type { OrphanCandidate, ReapOrphansResult } from './orphan-sweep';
