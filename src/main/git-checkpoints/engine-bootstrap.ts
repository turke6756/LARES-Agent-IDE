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
  listTurnRecords,
  listActiveBoundaryRefs,
  recordWitnessedActivity,
  type WitnessObserver,
} from '../database';
import type { CheckpointRoutes, TurnCheckpointSummary } from '../api-server';
import type { HumanCheckpointRoutes } from './checkpoint-ipc';
import { resolveInternalGit, probeWorkspaceGit } from '../git/git-runtime';
import { CheckpointQueue } from './checkpoint-queue';
import { CheckpointService } from './checkpoint-service';
import { TurnCoordinator, type TurnContext } from './turn-coordinator';
import { TurnCompletionTracker } from '../supervisor/turn-completion-tracker';
import { WitnessRecorder } from './witness-recorder';
import {
  buildDispatchTurnContext,
  type DispatchContext,
  type DispatchAgentInfo,
  type PlanningActivityBinding,
} from './dispatch-context';
import { runCheckpointStartupMaintenance } from './reconciler';
import { reconcilePlanningActivityWorktrees } from './planning-worktree-reconciler';
import {
  runWorkspaceRetention,
  type RetentionDeps,
  type WorkspaceRetentionResult,
} from './retention';
import { initWorkspaceGitRepo } from './git-init';
import {
  pruneWorkspaceCheckpoints,
  enumerateRepoLaresRefs,
  repoWidePurgeExecute,
  type RepoLaresRefEnumeration,
} from './prune';
import { forcePrerequisiteRecheck } from '../runtime-prerequisites';
import type { RepoWidePurgeResult, RepoWidePurgeWorkspace } from '../../shared/types';

export interface CheckpointEngineHandle {
  /** The internal Git exe this engine resolved. Reused by the Save-card route
   *  wiring (SC-WP-1J) so it does not re-resolve a second copy at bootstrap. */
  gitExe: string;
  /** Shared object-database serializer. Commit composition must use the same
   * instance as checkpoint restore/capture, never a parallel queue. */
  queue: CheckpointQueue;
  /** Create a checkpoint-native raw snapshot commit for an explicit package
   * finalization; the finalization service immediately pins its returned OID. */
  captureFinalizationBoundary: (
    workspaceId: string,
    label: string,
  ) => Promise<{ oid: string; treeOid: string }>;
  coordinator: TurnCoordinator;
  completionTracker: TurnCompletionTracker;
  buildTurnContext: (agentId: string, dispatch: DispatchContext) => Promise<TurnContext | null>;
  /** The witness-join observer to hand to `setWitnessObserver`. */
  witnessObserve: WitnessObserver;
  /** Run the WP-G1.8 startup pass (temp-artifact sweep + ref/DB reconciliation)
   *  with the LIVE coordinator as the dangling-open close seam. */
  runStartupMaintenance: () => Promise<void>;
  /** WP-G3.3 — one retention cycle across every registered workspace: distill-
   *  before-prune → triggered loose-object maintenance → storage report. Uses the
   *  LIVE engine's CheckpointQueue so the MAINTENANCE idle-only slot serializes
   *  against real checkpoint traffic. Best-effort + isolated per workspace; never
   *  throws. index.ts schedules it on an interval. */
  runRetention: () => Promise<WorkspaceRetentionResult[]>;
  /** WP-G2.1 — the capability-bound HTTP checkpoint surface (list/diff/preview/
   *  restore/revert), resolving the git capability per workspace and delegating to
   *  the CheckpointService. Injected into ApiServer via `setCheckpointRoutes`. */
  checkpointRoutes: CheckpointRoutes;
  /** WP-G2.2 — the HUMAN renderer surface. Same service + domain checks as
   *  `checkpointRoutes`, but `restore`/`revert` accept `force` (the IPC-only
   *  stale-preview override). Injected into the IPC layer via
   *  `setHumanCheckpointRoutes`. The Open #4 force gate (refuse while an active
   *  turn witnesses a path) lives in the IPC layer, not here. */
  humanCheckpointRoutes: HumanCheckpointRoutes;
}

/** Build the exact dependency object used by the production retention call. The
 * accessor parameter is injectable so the database-to-retention bind is testable
 * without starting Electron or probing a live repository. */
export function buildWorkspaceRetentionDeps(
  deps: Omit<RetentionDeps, 'activeBoundaryRefs'>,
  readActiveBoundaryRefs: (repositoryKey: string) => readonly string[] | Promise<readonly string[]>
    = listActiveBoundaryRefs,
): RetentionDeps {
  return { ...deps, activeBoundaryRefs: readActiveBoundaryRefs };
}

/** TurnRecord → the workspace-scoped list DTO. Carries witnessed PATHS only, never
 *  worktree bytes. */
export function toCheckpointSummary(r: import('../database').TurnRecord): TurnCheckpointSummary {
  return {
    turnId: r.id,
    turnSeq: r.turnSeq,
    agentId: r.agentId,
    agentTitle: r.agentTitle,
    taskLabel: r.taskLabel,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    beforeReady: r.beforeReady,
    afterReady: r.afterReady,
    beforeQuality: r.beforeQuality,
    afterQuality: r.afterQuality,
    witnessedPaths: (r.touched ?? [])
      .filter((e) => e.op === 'write' || e.op === 'create')
      .map((e) => e.path),
    failureReason: r.failureReason,
    // CONTENT-semantics diagnostic — surfaced so RestoreDialog can warn that a
    // restore of filter-managed (LFS/git-crypt) paths rewrites on-disk bytes.
    beforeRawFilterBypassed: r.beforeRawFilterBypassed,
  };
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
  const resolveCapabilityByWorkspace = async (wsId: string): Promise<GitCapability | null> => {
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
  const resolveCapability = (agent: DispatchAgentInfo): Promise<GitCapability | null> =>
    resolveCapabilityByWorkspace(agent.workspaceId);
  const activityCapabilityCache = new Map<string, GitCapability | null>();
  const resolveActivityCapability = async (
    binding: PlanningActivityBinding,
  ): Promise<GitCapability | null> => {
    if (activityCapabilityCache.has(binding.executionRunId)) {
      return activityCapabilityCache.get(binding.executionRunId) ?? null;
    }
    let capability: GitCapability | null = null;
    try {
      capability = await probeWorkspaceGit(canonicalDir(binding.path));
      if (capability.commonDirQueueKey !== binding.objectDatabaseKey) capability = null;
    } catch {
      capability = null;
    }
    activityCapabilityCache.set(binding.executionRunId, capability);
    return capability;
  };

  // WP-G2.1 — the capability-bound HTTP checkpoint surface. Authorization (supervisor
  // capability, self-assertion, workspace scope) is enforced in ApiServer BEFORE any
  // of these run; here we only resolve the git capability for the (already-authorized)
  // workspace and delegate to the CheckpointService. A workspace with no usable repo
  // fails visibly rather than silently doing nothing.
  const requireCapability = async (workspaceId: string): Promise<GitCapability> => {
    const cap = await resolveCapabilityByWorkspace(workspaceId);
    if (!cap || !cap.repoRoot) {
      throw Object.assign(
        new Error(`no usable git checkpoint capability for workspace '${workspaceId}'`),
        { statusCode: 409, code: 'checkpoint-unavailable' },
      );
    }
    return cap;
  };
  const checkpointRoutes: CheckpointRoutes = {
    list: (workspaceId, opts) => listTurnRecords(workspaceId, opts).map(toCheckpointSummary),
    fileHistory: async (workspaceId, filePath, opts) => {
      const cap = await requireCapability(workspaceId);
      return service.fileHistory({
        workspaceId,
        path: filePath,
        repoRoot: cap.repoRoot as string,
        agentId: opts?.agentId,
      });
    },
    diff: async (turnId, workspaceId) => {
      const cap = await requireCapability(workspaceId);
      return service.generateDiffs(turnId, cap.repoRoot as string);
    },
    preview: async (turnId, workspaceId, requestedPaths) => {
      const cap = await requireCapability(workspaceId);
      return service.previewRestore({ turnId, workspaceId, capability: cap, requestedPaths });
    },
    restorePaths: async (args) => {
      const cap = await requireCapability(args.workspaceId);
      return service.restorePaths({
        turnId: args.turnId,
        requestedPaths: args.paths,
        workspaceId: args.workspaceId,
        actor: args.agentId,
        capability: cap,
        previewTokens: args.previewTokens,
      });
    },
    revertTurn: async (args) => {
      const cap = await requireCapability(args.workspaceId);
      return service.revertTurn({
        turnId: args.turnId,
        workspaceId: args.workspaceId,
        actor: args.agentId,
        capability: cap,
        previewTokens: args.previewTokens,
      });
    },
    // WP-G3.5 — the explicit "delete my checkpoint refs" command. Workspace-scoped
    // to the (already-authorized) claim: deletes BOTH encoded namespaces for this
    // workspace in one atomic batch under the object-db queue lock, and reports the
    // count. NOT retention (no distill-before-prune — the user asked to delete, not to
    // keep a distillate) and NOT a gc/prune of objects (left to git maintenance).
    prune: async ({ workspaceId }) => {
      const cap = await requireCapability(workspaceId);
      const r = await pruneWorkspaceCheckpoints({
        workspaceId,
        repoRoot: cap.repoRoot as string,
        gitExe,
        queue,
        commonDirQueueKey: cap.commonDirQueueKey ?? undefined,
      });
      return { workspaceId, deletedRefs: r.deletedRefs };
    },
  };

  // WP-G3.5 — build the "name the blast radius" plan for a repo-wide purge: map each
  // decoded workspaceId → its registered title/path (or `known:false` when the id is
  // no longer a live workspace — a stale/foreign scope in a shared repo is still
  // named, never silently swept). Pure metadata; carries no workspace bytes.
  const buildPurgePlan = (repoRoot: string, e: RepoLaresRefEnumeration): RepoWidePurgeResult => {
    const affectedWorkspaces: RepoWidePurgeWorkspace[] = e.byWorkspace.map((g) => {
      const ws = getWorkspace(g.workspaceId);
      return {
        workspaceId: g.workspaceId,
        workspaceTitle: ws?.title ?? null,
        workspacePath: ws?.path ?? null,
        known: !!ws,
        refCount: g.refs.length,
      };
    });
    return {
      repoRoot,
      totalRefs: e.allRefs.length,
      affectedWorkspaces,
      undecodableRefCount: e.undecodableRefs.length,
      executed: false,
      deletedRefs: 0,
    };
  };

  // WP-G2.2 — the HUMAN renderer surface. It REUSES the WP-G2.1 checkpointRoutes for
  // the read paths (list/diff/preview) so the workspace-scoped envelope and the
  // witnessed-subset / preview-token checks are shared, not reimplemented; only
  // restore/revert differ, adding the IPC-only `force` passed straight to the
  // CheckpointService (which bypasses a stale preview-token mismatch). The Open #4
  // gate that decides WHETHER a force is allowed (no active turn may witness a
  // requested path) is enforced one layer up, in checkpoint-ipc.ts, via this same
  // surface's `preview` contention. The row actor for every human op is 'human-ipc'.
  const humanCheckpointRoutes: HumanCheckpointRoutes = {
    list: async (workspaceId, opts) => ({
      workspaceId,
      turns: await checkpointRoutes.list(workspaceId, opts),
    }),
    fileHistory: async (workspaceId, filePath, opts) => ({
      workspaceId,
      path: filePath,
      versions: await checkpointRoutes.fileHistory(workspaceId, filePath, opts),
    }),
    diff: async (workspaceId, turnId) => {
      const d = await checkpointRoutes.diff(turnId, workspaceId);
      return { workspaceId, turnId, witnessed: d.witnessed, window: d.window };
    },
    preview: (workspaceId, turnId, paths) => checkpointRoutes.preview(turnId, workspaceId, paths),
    restore: async ({ workspaceId, turnId, paths, previewTokens, force }) => {
      const cap = await requireCapability(workspaceId);
      return service.restorePaths({
        turnId,
        requestedPaths: paths,
        workspaceId,
        actor: 'human-ipc',
        capability: cap,
        previewTokens,
        force,
      });
    },
    revert: async ({ workspaceId, turnId, previewTokens, force }) => {
      const cap = await requireCapability(workspaceId);
      return service.revertTurn({
        turnId,
        workspaceId,
        actor: 'human-ipc',
        capability: cap,
        previewTokens,
        force,
      });
    },
    // WP-G3.4 — the human-only `git init` consent action. It lives here, next to the
    // per-workspace `capabilityCache` + probe, because the ONLY thing it adds over
    // the pure init in git-init.ts is the invalidation of the two existing seams on
    // success: drop this workspace's cached capability so the send path re-probes and
    // the checkpoint engine picks up the fresh repo, and `forcePrerequisiteRecheck`
    // (WP-G0.3) so the prerequisite/status UI re-probes it as a repo. No parallel
    // probe or cache is introduced.
    initRepo: async (workspaceId) => {
      const ws = getWorkspace(workspaceId);
      if (!ws?.path) {
        return {
          ok: false,
          status: 'error',
          message: `Unknown workspace '${workspaceId}'. Nothing was created.`,
        };
      }
      const result = await initWorkspaceGitRepo(canonicalDir(ws.path), gitExe);
      if (result.ok) {
        capabilityCache.delete(workspaceId);
        forcePrerequisiteRecheck();
      }
      return result;
    },
    // WP-G3.5 — the human mirror of the supervisor prune: same workspace-scoped
    // namespace clear + count, actor is the human renderer.
    prune: async (workspaceId) => {
      const cap = await requireCapability(workspaceId);
      const r = await pruneWorkspaceCheckpoints({
        workspaceId,
        repoRoot: cap.repoRoot as string,
        gitExe,
        queue,
        commonDirQueueKey: cap.commonDirQueueKey ?? undefined,
      });
      return { workspaceId, deletedRefs: r.deletedRefs };
    },
    // WP-G3.5 — enumerate + NAME every workspace whose refs live in this repo, without
    // deleting. The repo is resolved from the asserted workspace's capability; in a
    // shared repo this surfaces OTHER workspaces' refs so the human sees them first.
    repoWidePurgePlan: async (workspaceId) => {
      const cap = await requireCapability(workspaceId);
      const repoRoot = cap.repoRoot as string;
      const e = await enumerateRepoLaresRefs({ repoRoot, gitExe });
      return buildPurgePlan(repoRoot, e);
    },
    // WP-G3.5 — the confirmed repo-wide purge. It ALWAYS enumerates + names first
    // (so the result reports the blast radius either way); it only DELETES when
    // `confirm === true`. A missing/false confirm returns the plan unexecuted — there
    // is no code path that purges without an explicit human confirmation.
    repoWidePurge: async ({ workspaceId, confirm }) => {
      const cap = await requireCapability(workspaceId);
      const repoRoot = cap.repoRoot as string;
      const e = await enumerateRepoLaresRefs({ repoRoot, gitExe });
      const plan = buildPurgePlan(repoRoot, e);
      if (!confirm) return plan;
      const res = await repoWidePurgeExecute({
        repoRoot,
        gitExe,
        queue,
        commonDirQueueKey: cap.commonDirQueueKey ?? undefined,
      });
      return { ...plan, executed: true, deletedRefs: res.deletedRefs };
    },
  };

  const buildTurnContext = (agentId: string, dispatch: DispatchContext) =>
    buildDispatchTurnContext(
      {
        getAgent: (id) => getAgent(id) as unknown as DispatchAgentInfo | null,
        resolveCapability,
        resolveActivityCapability,
      },
      agentId,
      dispatch,
    );

  const witness = new WitnessRecorder({
    currentWitnessTarget: (agentId) => coordinator.currentWitnessTarget(agentId),
    record: (turnId, p, op) => recordWitnessedActivity(turnId, p, op),
  });

  const runStartupMaintenance = async () => {
    await runCheckpointStartupMaintenance({
      workspaces: getWorkspaces(),
      // WP-G1.7 seam upgrade: dangling-open close runs through the LIVE coordinator.
      closeOpenTurns: (workspaceId: string) => coordinator.reconcileOpenTurns(workspaceId),
    });
    if (process.env.LARES_INTENT_PACKAGING === '1') {
      await reconcilePlanningActivityWorktrees({ gitExe });
    }
  };

  // WP-G3.3 — retention cycle. Each workspace resolves its git capability through the
  // shared per-workspace cache; a workspace with no usable repo (or no queue key) is
  // skipped (detect-and-degrade). The SAME `queue` the live engine uses is passed in
  // so the loose-object MAINTENANCE slot is genuinely idle-only against real traffic.
  const runRetention = async (): Promise<WorkspaceRetentionResult[]> => {
    const results: WorkspaceRetentionResult[] = [];
    for (const ws of getWorkspaces()) {
      try {
        const cap = await resolveCapabilityByWorkspace(ws.id);
        if (!cap || !cap.repoRoot || !cap.commonDirQueueKey) continue; // detect-and-degrade
        results.push(
          await runWorkspaceRetention(buildWorkspaceRetentionDeps({
            workspaceId: ws.id,
            repoRoot: cap.repoRoot,
            gitExe,
            queue,
            commonDirQueueKey: cap.commonDirQueueKey,
            workspacePrefix: cap.workspacePrefix ?? '',
          })),
        );
      } catch (err) {
        console.error(`[retention] workspace ${ws.id} cycle failed:`, err);
      }
    }
    return results;
  };

  const captureFinalizationBoundary = async (workspaceId: string, label: string) => {
    const capability = await requireCapability(workspaceId);
    // A finalization package may fuse sibling workspace aliases in one worktree.
    // Capture the repository root, not only the initiating alias's prefix, so the
    // pinned boundary commit reaches every member object in that package.
    return service.captureBoundary({
      capability: { ...capability, workspacePrefix: '' },
      label,
    });
  };

  return {
    gitExe,
    queue,
    captureFinalizationBoundary,
    coordinator,
    completionTracker,
    buildTurnContext,
    witnessObserve: witness.observe,
    runStartupMaintenance,
    runRetention,
    checkpointRoutes,
    humanCheckpointRoutes,
  };
}
