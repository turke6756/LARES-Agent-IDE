// SC-WP-1J — production Save-card routes (read-only).
//
// This is the bootstrap-side adapter that turns the renderer's `{ workspaceId }`
// request into a full `CandidateReadRequest` and delegates to the committed
// SC-WP-1G facade (`CommitCandidateService.listWorkBundles`). It owns NO new
// assembly logic — the facade already unions scoped inventories, projects
// witnesses, and emits renderer-safe `WorkBundle` DTOs (which are structurally
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

import type { Agent, GitCapability, SaveCardBundle, SaveCardBundleIdentity, SaveCardInventoryRequest, SaveCardInventoryResponse, SaveCardPackageSaveability, SaveCardWorkerUnit } from '../../shared/types';
import type { SaveCardQuotaWeakening } from '../../shared/commit-candidates';
import {
  getAgentsByWorkspace as dbGetAgentsByWorkspace,
  getAgent as dbGetAgent,
  getTurnRecord as dbGetTurnRecord,
  getWorkspaces as dbGetWorkspaces,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  listCommitPathLinks as dbListCommitPathLinks,
  listActivePackageFinalizationsForRepository as dbListActivePackageFinalizationsForRepository,
  listTurnRecords as dbListTurnRecords,
  type TurnRecord,
  type TurnWitnessRead,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
import type { RunGitBytesLike, RunGitTextLike } from './dirty-inventory';
import type { TurnWitnessReader } from './witness-projection';
import type { CommitPathLinkReader } from './protection-read';
import { createTurnStampSource, type TurnStampRecordReader } from './stamp-projection';
import type { SaveCardRoutes } from './save-card-ipc';
import type { WorkBundle } from './work-bundle';

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

const IDENTITY_NAME_MAX_LENGTH = 80;
const IDENTITY_ROLE_MAX_LENGTH = 200;

function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function mixedIdentityName(workerUnits: readonly SaveCardWorkerUnit[]): string {
  const visibleNames = workerUnits.slice(0, 2).map((unit) => unit.name);
  if (workerUnits.length <= 2) {
    return clampText(visibleNames.join(' + ') || 'Unknown agent', IDENTITY_NAME_MAX_LENGTH);
  }

  const suffix = ` + ${workerUnits.length - visibleNames.length} more agents`;
  const prefix = clampText(
    visibleNames.join(', '),
    IDENTITY_NAME_MAX_LENGTH - suffix.length,
  );
  return `${prefix}${suffix}`;
}

/** Attach presentation identity without changing component membership/topology. */
function attachBundleIdentity(
  bundle: WorkBundle,
  agents: ReadonlyMap<string, Agent>,
  turns: ReadonlyMap<string, BundleTurn>,
  witnesses: readonly TurnWitnessRead[],
  capabilityByWorkspaceId: ReadonlyMap<string, GitCapability>,
  workspaceTitleById: ReadonlyMap<string, string>,
  targetWorkspaceId: string,
): SaveCardBundle {
  // Saveability is a property of the PANE's workspace (the repository the commit
  // would land in), NOT of any contributing agent's home workspace. The inventory
  // is already repository-scoped to the pane's repo, so every package it surfaces
  // has its files inside that repo. A package is unsavable ONLY when the pane's
  // OWN workspace has no repoRoot (the genuine "Computer Root has no repo" case),
  // never because a contributor came from a repo-less workspace. This mirrors the
  // finalize routing, which pins by the pane's target workspace.
  const targetCapability = capabilityByWorkspaceId.get(targetWorkspaceId);
  const saveability: SaveCardPackageSaveability =
    targetCapability && !targetCapability.repoRoot
      ? {
          saveable: false,
          reason: 'no-repository',
          workspaceId: targetWorkspaceId,
          workspaceTitle: workspaceTitleById.get(targetWorkspaceId) ?? targetWorkspaceId,
          refusal: {
            stage: 'saveability',
            code: 'save-card-no-repository',
            message: `Saveability stage refused because workspace '${workspaceTitleById.get(targetWorkspaceId) ?? targetWorkspaceId}' has no Git repository.`,
          },
        }
      : { saveable: true };

  if (bundle.kind === 'unattributed' || !bundle.component) {
    return { ...bundle, identity: null, saveability };
  }

  const turnIds = new Set(bundle.component.associations.flatMap((a) => a.contributingTurnIds));
  const relevantWitnesses = witnesses.filter((witness) => turnIds.has(witness.turnId));
  const agentIds = new Set(relevantWitnesses.flatMap((w) => w.agentId ? [w.agentId] : []));
  const ownerIds = new Set<string>();

  // Owner resolution uses ONLY real data: the witness's recorded owner edge, else
  // the contributing agent's own owner edge. We never fabricate ownership — an
  // agent with no owner edge (even an isSupervised one) contributes as itself, and
  // a component whose contributors lack a single real owner resolves to 'agent'
  // (single contributor) or 'mixed' (multiple), never to a guessed supervisor.
  for (const witness of relevantWitnesses) {
    const agent = witness.agentId ? agents.get(witness.agentId) : undefined;
    const ownerId = witness.ownerAgentId ?? agent?.ownerAgentId;
    if (ownerId) ownerIds.add(ownerId);
  }

  const workerUnits: SaveCardWorkerUnit[] = [...agentIds].sort().map((agentId) => {
    const agent = agents.get(agentId);
    const agentTurns = relevantWitnesses
      .filter((witness) => witness.agentId === agentId)
      .map((witness) => turns.get(witness.turnId))
      .filter((turn): turn is BundleTurn => Boolean(turn));
    const memberEntryIds = Object.entries(bundle.component!.overlap.perPathContributors)
      .filter(([, contributors]) => contributors.agentIds.includes(agentId))
      .map(([entryId]) => entryId)
      .sort();
    return {
      agentId,
      name: rendererSafeText(nonEmpty(agent?.title, agentTurns.find((turn) => turn.agentTitle)?.agentTitle || 'Unknown agent')),
      roleDescription: rendererSafeText(nonEmpty(agent?.roleDescription, 'No role description recorded.')),
      kind: agent?.isSupervisor ? 'supervisor' : agent?.isWorker || agent?.isSupervised ? 'worker' : 'agent',
      startedAt: minTime(agentTurns.map((turn) => turn.startedAt)),
      endedAt: maxTime(agentTurns.map((turn) => turn.endedAt ?? turn.startedAt)),
      turnCount: new Set(agentTurns.map((turn) => turn.id)).size,
      memberEntryIds,
    };
  });

  const owners = [...ownerIds].map((id) => agents.get(id)).filter((agent): agent is Agent => Boolean(agent));
  let source: SaveCardBundleIdentity['source'];
  let identityAgent: Agent | undefined;
  if (owners.length === 1) {
    identityAgent = owners[0];
    source = identityAgent.isSupervisor ? 'supervisor' : 'agent';
  } else if (owners.length === 0 && workerUnits.length === 1) {
    source = 'agent';
    identityAgent = workerUnits[0].agentId ? agents.get(workerUnits[0].agentId) : undefined;
  } else {
    source = 'mixed';
  }

  const name = clampText(rendererSafeText(identityAgent?.title
    ?? (source === 'mixed' ? mixedIdentityName(workerUnits) : workerUnits[0]?.name)
    ?? 'Unknown agent'), IDENTITY_NAME_MAX_LENGTH);
  const distinctRoleDescriptions = workerUnits
    .map((unit) => unit.roleDescription)
    .filter((value, index, all) => all.indexOf(value) === index);
  const roleFallback = source === 'mixed'
    ? `Overlapping work from ${workerUnits.length} agents across ${turnIds.size} turns${
      distinctRoleDescriptions[0] ? ` — ${distinctRoleDescriptions[0]}` : ''
    }`
    : distinctRoleDescriptions.join(' ');
  const roleDescription = clampText(rendererSafeText(nonEmpty(
    identityAgent?.roleDescription,
    roleFallback,
  )), IDENTITY_ROLE_MAX_LENGTH);
  const identity: SaveCardBundleIdentity = {
    groupingKey: identityAgent
      ? `${source}:${identityAgent.id}`
      : `mixed:${bundle.component.componentId}`,
    source,
    agentId: identityAgent?.id ?? null,
    name,
    roleDescription,
    startedAt: minTime(workerUnits.map((unit) => unit.startedAt)),
    endedAt: maxTime(workerUnits.map((unit) => unit.endedAt)),
    workerUnits,
  };
  return {
    ...bundle,
    label: name,
    labels: [name, ...bundle.labels],
    identity,
    saveability,
  };
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
 * returns the facade's `WorkBundle[]` verbatim (identical to the DTO shape).
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
  });

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

    const { bundles, quotaWeakening } = await service.listInventoryView({
      targetWorkspaceId: req.workspaceId,
      workspaces,
    });

    const includedWorkspaceIds = new Set(bundles.flatMap((bundle) =>
      bundle.workspaces.map((workspace) => workspace.workspaceId),
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

    return {
      bundles: bundles.map((bundle) => attachBundleIdentity(
        bundle,
        agents,
        turns,
        witnesses,
        capabilityByWorkspaceId,
        workspaceTitleById,
        req.workspaceId,
      )),
      quotaWeakening,
    };
  }

  return { getInventory };
}
