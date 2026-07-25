// engine-bootstrap.ts — assemble the live checkpoint engine (Git-Native WP-G1.7).
// MAIN-PROCESS ONLY.
//
// Constructs the landed engine layers — queue → service → completion-tracker →
// coordinator → witness-recorder — resolves the internal git exe once, and returns
// a handle the app bootstrap (src/main/index.ts) attaches to the supervisor. All
// heavy dependency lookups (getWorkspaces/getWorkspace/getAgent, probeWorkspaceGit)
// live here so index.ts keeps a couple of lines. Per-workspace capability probes
// are cached, so a hot send path pays one probe per workspace, not one per turn.

import * as fs from 'fs';

import type { GitCapability } from '../../shared/types';
import {
  getWorkspaces,
  getWorkspace,
  getAgent,
  recordWitnessedActivity,
  type WitnessObserver,
} from '../database';
import { resolveInternalGit, probeWorkspaceGit } from '../git/git-runtime';
import { CheckpointQueue } from './checkpoint-queue';
import { CheckpointService } from './checkpoint-service';
import { TurnCoordinator, type TurnContext } from './turn-coordinator';
import { TurnCompletionTracker } from '../supervisor/turn-completion-tracker';
import { WitnessRecorder } from './witness-recorder';
import { buildDispatchTurnContext, type DispatchContext, type DispatchAgentInfo } from './dispatch-context';
import { runCheckpointStartupMaintenance } from './reconciler';

export interface CheckpointEngineHandle {
  coordinator: TurnCoordinator;
  completionTracker: TurnCompletionTracker;
  buildTurnContext: (agentId: string, dispatch: DispatchContext) => Promise<TurnContext | null>;
  /** The witness-join observer to hand to `setWitnessObserver`. */
  witnessObserve: WitnessObserver;
  /** Run the WP-G1.8 startup pass (temp-artifact sweep + ref/DB reconciliation)
   *  with the LIVE coordinator as the dangling-open close seam. */
  runStartupMaintenance: () => Promise<void>;
}

/** Canonicalize a workspace directory best-effort (realpath), so a probe keys off
 *  the same canonical root the capture side uses. */
function canonicalDir(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Build the checkpoint engine. Returns null when no internal git can be resolved
 * (the checkpoint feature is simply off; delivery + the app are unaffected).
 */
export async function createCheckpointEngine(): Promise<CheckpointEngineHandle | null> {
  const internal = await resolveInternalGit();
  const gitExe = internal?.execPath;
  if (!gitExe) return null; // no usable git → no engine

  const queue = new CheckpointQueue();
  const service = new CheckpointService({ queue, gitExe });
  const completionTracker = new TurnCompletionTracker();
  const coordinator = new TurnCoordinator({
    capture: service.captureEdge.bind(service),
    completion: completionTracker,
  });

  // Per-workspace capability cache (keyed by workspaceId). A missing/unusable repo
  // caches as null so the send path short-circuits without re-probing every turn.
  const capabilityCache = new Map<string, GitCapability | null>();
  const resolveCapability = async (agent: DispatchAgentInfo): Promise<GitCapability | null> => {
    const wsId = agent.workspaceId;
    if (capabilityCache.has(wsId)) return capabilityCache.get(wsId) ?? null;
    let cap: GitCapability | null = null;
    try {
      const ws = getWorkspace(wsId);
      if (ws?.path) cap = await probeWorkspaceGit(canonicalDir(ws.path));
    } catch {
      cap = null;
    }
    capabilityCache.set(wsId, cap);
    return cap;
  };

  const buildTurnContext = (agentId: string, dispatch: DispatchContext) =>
    buildDispatchTurnContext(
      { getAgent: (id) => getAgent(id) as unknown as DispatchAgentInfo | null, resolveCapability },
      agentId,
      dispatch,
    );

  const witness = new WitnessRecorder({
    currentWitnessTarget: (agentId) => coordinator.currentWitnessTarget(agentId),
    record: (turnId, p, op) => recordWitnessedActivity(turnId, p, op),
  });

  const runStartupMaintenance = () =>
    runCheckpointStartupMaintenance({
      workspaces: getWorkspaces(),
      // WP-G1.7 seam upgrade: dangling-open close runs through the LIVE coordinator.
      closeOpenTurns: (workspaceId: string) => coordinator.reconcileOpenTurns(workspaceId),
    });

  return {
    coordinator,
    completionTracker,
    buildTurnContext,
    witnessObserve: witness.observe,
    runStartupMaintenance,
  };
}
