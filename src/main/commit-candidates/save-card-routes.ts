// SC-WP-1J — production Save-card routes (read-only).
//
// This is the bootstrap-side adapter that turns the renderer's `{ workspaceId }`
// request into a full `CandidateReadRequest` and delegates to the committed
// intent-first projection. It owns no new
// assembly logic — the facade already unions scoped inventories, projects
// witnesses, and emits renderer-safe intent-unit DTOs (which are structurally
// `SaveCardInventoryResponse`).
//
// Read-only invariant: every Git seam here is a read (`runGit`/`runGitBytes`
// pass through to the facade, which issues only status/rev-parse/hash-object).
// Nothing in this module mutates the worktree, the index, or any ref.
//
// Repository-scope honesty (architectural invariant "agents share a working
// directory"): the request carries EVERY registered workspace as a candidate,
// each with its own capability probe. The facade's scope discovery then narrows
// to the aliases that actually share the target's worktree, so sibling lanes in
// the same folder are unioned rather than silently dropped.

import * as fs from 'node:fs';

import type { Agent, GitCapability, SaveCardInventoryRequest, SaveCardInventoryResponse, SaveIntentUnitDto, SaveCardPackageSaveability, SaveCardWorkerUnit } from '../../shared/types';
import type { SaveCardQuotaWeakening } from '../../shared/commit-candidates';
import {
  getAgentsByWorkspace as dbGetAgentsByWorkspace,
  getAgent as dbGetAgent,
  getTurnRecord as dbGetTurnRecord,
  getWorkspaces as dbGetWorkspaces,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  listCommitPathLinks as dbListCommitPathLinks,
  listActivePackageFinalizationsForRepository as dbListActivePackageFinalizationsForRepository,
  listSaveIntentsForRepository as dbListSaveIntentsForRepository,
  listNamedSaveSetMembers as dbListNamedSaveSetMembers,
  getPlan as dbGetPlan,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  createNamedSaveSet as dbCreateNamedSaveSet,
  listPlanningActivityWorktrees as dbListPlanningActivityWorktrees,
  listActivityMergeAttempts as dbListActivityMergeAttempts,
  listActivityMergeConflicts as dbListActivityMergeConflicts,
  listTurnRecords as dbListTurnRecords,
  type TurnRecord,
  type TurnWitnessRead,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  type CandidateInventoryRead,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
import type { RunGitBytesLike, RunGitTextLike } from './dirty-inventory';
import type { TurnWitnessReader } from './witness-projection';
import type { CommitPathLinkReader } from './protection-read';
import { createTurnStampSource, type TurnStampRecordReader } from './stamp-projection';
import type { SaveCardRoutes } from './save-card-ipc';
import { projectWitnesses } from './witness-projection';
import { projectIntentUnits } from './intent-assembler';

type BundleTurn = Pick<TurnRecord, 'id' | 'agentId' | 'agentTitle' | 'startedAt' | 'endedAt'>;

/** Injected seams. Production passes only `gitExe`; the rest default to the live
 *  database / git runtime. Tests override every seam with in-memory fakes. */
export interface SaveCardRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string; title?: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readTurnRecord?: TurnStampRecordReader;
  readCaptureTurns?: CaptureTurnReader;
  readCommitPathLinks?: CommitPathLinkReader;
  readActiveFinalizations?: (repositoryKey: string) => readonly import('../database').PackageFinalization[];
  getAgentsByWorkspace?: (workspaceId: string) => readonly Agent[];
  getAgent?: (agentId: string) => Agent | null;
  readBundleTurns?: (workspaceId: string) => readonly BundleTurn[];
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  /** Best-effort canonicalizer; defaults to `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
  /**
   * SC-WP-2L — the latest retention pin quota-weakening warning for the assembled
   * repository (from the WP-2K retention pass). Defaults to none until a warning
   * source is wired in; the Save card simply omits the banner while it is null.
   */
  readQuotaWeakening?: (repositoryKey: string) => SaveCardQuotaWeakening | null;
  listSaveIntents?: typeof dbListSaveIntentsForRepository;
  listNamedSaveSetMembers?: typeof dbListNamedSaveSetMembers;
  getPlan?: typeof dbGetPlan;
  getPlanItem?: typeof dbGetPlanWorkPackage;
  createNamedSaveSet?: typeof dbCreateNamedSaveSet;
  listPlanningActivities?: typeof dbListPlanningActivityWorktrees;
  listActivityMergeAttempts?: typeof dbListActivityMergeAttempts;
  listActivityMergeConflicts?: typeof dbListActivityMergeConflicts;
}

function minTime(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? Math.min(...present) : null;
}

function maxTime(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? Math.max(...present) : null;
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function rendererSafeText(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, '[local path]')
    .replace(/(^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/[^\s,;]+/g, '$1[local path]');
}
/** Canonicalize a workspace directory best-effort, mirroring the checkpoint
 *  engine's `canonicalDir` so a probe keys off the same root the facade reads. */
function canonicalDir(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/**
 * Build the production `SaveCardRoutes`. `getInventory` probes every registered
 * workspace once per request, assembles the repository-scoped candidate set, and
 * returns renderer-safe intent units projected from current evidence.
 */
export function createSaveCardRoutes(deps: SaveCardRoutesDeps): SaveCardRoutes {
  const gitExe = deps.gitExe;
  const getWorkspaces = deps.getWorkspaces ?? dbGetWorkspaces;
  const probeWorkspaceGit = deps.probeWorkspaceGit ?? realProbeWorkspaceGit;
  const readTurnWitnesses = deps.readTurnWitnesses ?? dbGetTurnWitnessReads;
  const readTurnRecord = deps.readTurnRecord ?? dbGetTurnRecord;
  // Read ALL turns for a workspace (large limit), matching the unbounded witness
  // read, so capture-health and protection-edge projection see the same turn
  // universe rather than only the newest default window.
  const readCaptureTurns: CaptureTurnReader =
    deps.readCaptureTurns ??
    ((workspaceId) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
  const readCommitPathLinks = deps.readCommitPathLinks ?? dbListCommitPathLinks;
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const realpath = deps.realpath ?? ((p) => fs.realpathSync.native(p));
  const getAgentsByWorkspace = deps.getAgentsByWorkspace ?? dbGetAgentsByWorkspace;
  const getAgent = deps.getAgent ?? dbGetAgent;
  const readBundleTurns = deps.readBundleTurns
    ?? ((workspaceId: string) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));

  const service = new CommitCandidateService({
    runGit,
    runGitBytes,
    readTurnWitnesses,
    stampSource: createTurnStampSource(readTurnRecord),
    readCaptureTurns,
    readCommitPathLinks,
    readActiveFinalizations: deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository,
    readQuotaWeakening: deps.readQuotaWeakening,
    readActivePlanningWorktrees: deps.listPlanningActivities ?? dbListPlanningActivityWorktrees,
    listSaveIntents: deps.listSaveIntents ?? dbListSaveIntentsForRepository,
    listNamedSaveSetMembers: deps.listNamedSaveSetMembers ?? dbListNamedSaveSetMembers,
    getPlan: deps.getPlan ?? dbGetPlan,
    getPlanItem: deps.getPlanItem ?? dbGetPlanWorkPackage,
  });
  const latestReadByWorkspace = new Map<string, CandidateInventoryRead>();

  async function getInventory(
    req: SaveCardInventoryRequest,
  ): Promise<SaveCardInventoryResponse> {
    const registeredWorkspaces = getWorkspaces();
    const capabilityByWorkspaceId = new Map<string, GitCapability>();
    const workspaceTitleById = new Map(
      registeredWorkspaces.map((workspace) => [workspace.id, workspace.title ?? workspace.id]),
    );
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      registeredWorkspaces.map(async (ws): Promise<CandidateWorkspaceInput> => {
        const workspaceDir = canonicalDir(realpath, ws.path);
        const capability = await probeWorkspaceGit(workspaceDir);
        capabilityByWorkspaceId.set(ws.id, capability);
        return {
          workspaceId: ws.id,
          workspaceDir,
          capability: {
            commonDirQueueKey: capability.commonDirQueueKey,
            workspacePrefix: capability.workspacePrefix,
            repoRoot: capability.repoRoot,
          },
          gitExe,
        };
      }),
    );

    const read = await service.assembleInventory({
      targetWorkspaceId: req.workspaceId,
      workspaces,
    });
    latestReadByWorkspace.set(req.workspaceId, read);
    const quotaWeakening = read.quotaWeakening;

    const includedWorkspaceIds = new Set(read.inventory.repository.workspaces.map(
      (workspace) => workspace.workspaceId,
    ));
    const agentRows = [...includedWorkspaceIds].flatMap((workspaceId) => getAgentsByWorkspace(workspaceId));
    const agents = new Map(agentRows.map((agent) => [agent.id, agent]));
    const bundleTurns = [...includedWorkspaceIds].flatMap((workspaceId) => readBundleTurns(workspaceId));
    const turns = new Map(bundleTurns.map((turn) => [turn.id, turn]));
    const witnesses = [...includedWorkspaceIds].flatMap((workspaceId) => readTurnWitnesses(workspaceId));
    for (const agentId of new Set(witnesses.flatMap((witness) => witness.agentId ? [witness.agentId] : []))) {
      if (!agents.has(agentId)) {
        const agent = getAgent(agentId);
        if (agent) agents.set(agentId, agent);
      }
    }
    for (const ownerId of new Set(witnesses.flatMap((witness) => witness.ownerAgentId ? [witness.ownerAgentId] : []))) {
      if (!agents.has(ownerId)) {
        const owner = getAgent(ownerId);
        if (owner) agents.set(ownerId, owner);
      }
    }

    const projectedWitnesses = projectWitnesses(
      read.inventory.repository,
      read.inventory.entries,
      readTurnWitnesses,
      createTurnStampSource(readTurnRecord),
    );
    const workspaceIds = read.inventory.repository.workspaces.map((workspace) => workspace.workspaceId);
    const intents = (deps.listSaveIntents ?? dbListSaveIntentsForRepository)(
      read.inventory.repository.repositoryKey,
      workspaceIds,
    );
    const assembly = projectIntentUnits({
      inventory: read.inventory,
      witnesses: projectedWitnesses,
      intents,
      namedMembers: (deps.listNamedSaveSetMembers ?? dbListNamedSaveSetMembers)(
        read.inventory.repository.repositoryKey,
      ),
      topology: { components: read.components } as import('./component-assembler').ComponentAssembly,
    });
    const entriesById = new Map(read.inventory.entries.map((entry) => [entry.entryId, entry]));
    const workerByAgentId = new Map([...agents].map(([agentId, agent]) => {
      const agentWitnesses = witnesses.filter((witness) => witness.agentId === agentId);
      const agentTurns = agentWitnesses.map((witness) => turns.get(witness.turnId))
        .filter((turn): turn is BundleTurn => Boolean(turn));
      const worker: SaveCardWorkerUnit = {
        agentId,
        name: rendererSafeText(nonEmpty(agent.title, agentTurns.find((turn) => turn.agentTitle)?.agentTitle || 'Unknown agent')),
        roleDescription: rendererSafeText(nonEmpty(agent.roleDescription, 'No role description recorded.')),
        kind: agent.isSupervisor ? 'supervisor' : agent.isWorker || agent.isSupervised ? 'worker' : 'agent',
        startedAt: minTime(agentTurns.map((turn) => turn.startedAt)),
        endedAt: maxTime(agentTurns.map((turn) => turn.endedAt ?? turn.startedAt)),
        turnCount: new Set(agentTurns.map((turn) => turn.id)).size,
        memberEntryIds: [],
      };
      return [agentId, worker] as const;
    }));
    const targetCapability = capabilityByWorkspaceId.get(req.workspaceId);
    const saveability: SaveCardPackageSaveability = targetCapability && !targetCapability.repoRoot
      ? {
          saveable: false,
          reason: 'no-repository',
          workspaceId: req.workspaceId,
          workspaceTitle: workspaceTitleById.get(req.workspaceId) ?? req.workspaceId,
          refusal: {
            stage: 'saveability', code: 'save-card-no-repository',
            message: `Saveability stage refused because workspace '${workspaceTitleById.get(req.workspaceId) ?? req.workspaceId}' has no Git repository.`,
          },
        }
      : { saveable: true };
    const intentUnits = assembly.intentUnits.map((unit): SaveIntentUnitDto => {
      const plan = unit.intent.planId ? (deps.getPlan ?? dbGetPlan)(unit.intent.planId) : null;
      const planItem = unit.intent.planItemId
        ? (deps.getPlanItem ?? dbGetPlanWorkPackage)(unit.intent.planItemId) : null;
      const componentHealth = unit.topologyComponentIds.flatMap((id) =>
        read.captureHealthByComponentId[id] ? [read.captureHealthByComponentId[id]] : []);
      return {
        intentId: unit.intent.id,
        kind: unit.intent.kind,
        title: unit.intent.title,
        state: unit.intent.state,
        plan: plan ? { id: plan.id, title: plan.slug ?? plan.path } : null,
        planItem: planItem ? { id: planItem.id, title: planItem.title } : null,
        members: unit.memberEntryIds.map((entryId) => ({
          entry: entriesById.get(entryId)!,
          protection: read.protectionByEntryId[entryId] ?? 'unprotected',
        })),
        contributors: unit.contributingAgentIds.flatMap((id) => {
          const worker = workerByAgentId.get(id);
          return worker ? [worker] : [];
        }),
        topologyEvidence: {
          componentIds: unit.topologyComponentIds,
          pathsWithMultipleTurns: unit.concurrency.pathsWithMultipleIntents,
          captureHealth: {
            turns: componentHealth.flatMap((health) => health.turns),
            captureOutage: componentHealth.some((health) => health.captureOutage),
            pathsWithoutFinalizationEdge: [...new Set(componentHealth.flatMap(
              (health) => health.pathsWithoutFinalizationEdge))],
          },
        },
        concurrencyCases: [],
        saveability,
        membershipStale: assembly.staleNamedSaveSetIds.includes(unit.intent.id),
      };
    });
    const members = (entryIds: readonly string[]) => entryIds.map((entryId) => ({
      entry: entriesById.get(entryId)!,
      protection: read.protectionByEntryId[entryId] ?? 'unprotected' as const,
    }));
    const unwitnessed = members(assembly.unwitnessedEntryIds);
    const legacyTaskIdentityUnavailable = members(
      assembly.legacyTaskIdentityUnavailableEntryIds,
    );
    const planningActivities = (deps.listPlanningActivities ?? dbListPlanningActivityWorktrees)()
      .filter((activity) => activity.logicalWorkspaceId === req.workspaceId)
      .map((activity) => {
        const attempt = (deps.listActivityMergeAttempts ?? dbListActivityMergeAttempts)(activity.executionRunId)[0] ?? null;
        const conflicts = attempt
          ? (deps.listActivityMergeConflicts ?? dbListActivityMergeConflicts)(attempt.id)
          : [];
        const status = activity.state === 'merge-conflicted' ? 'merge-conflicted' as const
          : activity.state === 'merge-pending' ? 'saved-in-plan-promotion-pending' as const
            : activity.state === 'recovery-required' ? 'recovery-required' as const
              : activity.state === 'cleaned' ? 'cleaned' as const
                : activity.promotedHeadOid ? 'promoted' as const : 'active' as const;
        const plan = (deps.getPlan ?? dbGetPlan)(activity.planId);
        return {
          executionRunId: activity.executionRunId,
          planId: activity.planId,
          planTitle: plan ? plan.slug ?? plan.path : activity.planId,
          status,
          promotedHeadOid: activity.promotedHeadOid,
          latestAttemptId: attempt?.id ?? null,
          conflicts: conflicts.map((conflict) => ({
            pathBytesBase64: conflict.pathBytesBase64,
            displayPath: Buffer.from(conflict.pathBytesBase64, 'base64').toString('utf8'),
            baseBlobOid: conflict.baseBlobOid,
            primaryBlobOid: conflict.primaryBlobOid,
            activityBlobOid: conflict.activityBlobOid,
            resolution: conflict.resolution,
          })),
          failureCode: activity.failureCode,
        };
      });
    const legacyFinalizations = (deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository)(
      read.inventory.repository.repositoryKey,
    ).filter((row) => row.contractVersion !== 2).map((row) => ({
      finalizationId: row.id,
      packageId: row.packageId,
      packageRevision: row.packageRevision,
      finalizationKind: row.finalizationKind,
      boundaryStatus: row.boundaryStatus,
      finalizedAt: row.finalizedAt,
    }));
    return {
      intentUnits,
      unwitnessed,
      legacyTaskIdentityUnavailable,
      legacyFinalizations,
      planningActivities,
      quotaWeakening,
    };
  }

  async function adoptAllAsBaseline(
    req: import('../../shared/types').SaveCardAdoptBaselineRequest,
  ): Promise<import('../../shared/types').SaveCardAdoptBaselineResponse> {
    const inventory = await getInventory(req);
    const read = latestReadByWorkspace.get(req.workspaceId);
    if (!read) throw new Error('fresh intent inventory unavailable');
    const members = inventory.unwitnessed ?? [];
    if (members.length === 0) throw new Error('there are no unwitnessed changes to adopt');
    const createdAt = Date.now();
    const title = `Baseline ${new Date(createdAt).toISOString().slice(0, 10)}`;
    const intent = (deps.createNamedSaveSet ?? dbCreateNamedSaveSet)({
      workspaceId: req.workspaceId,
      repositoryKey: read.inventory.repository.repositoryKey,
      title,
      inventoryDigest: read.inventory.topologyDigest,
      members: members.map((member) => ({
        entryId: member.entry.entryId,
        pathBytesBase64: member.entry.path.pathBytesBase64,
      })),
      createdAt,
    });
    return { intentId: intent.id, title: intent.title, memberCount: members.length };
  }

  return { getInventory, adoptAllAsBaseline };
}
