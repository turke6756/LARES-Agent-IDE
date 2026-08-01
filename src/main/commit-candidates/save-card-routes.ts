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

import type { Agent, GitCapability, SaveCardBundleIdentity, SaveCardInventoryRequest, SaveCardInventoryResponse, SaveCardWorkerUnit } from '../../shared/types';
import {
  getAgentsByWorkspace as dbGetAgentsByWorkspace,
  getAgent as dbGetAgent,
  getWorkspaces as dbGetWorkspaces,
  getTurnWitnessReads as dbGetTurnWitnessReads,
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
import type { SaveCardRoutes } from './save-card-ipc';
import type { WorkBundle } from './work-bundle';

type BundleTurn = Pick<TurnRecord, 'id' | 'agentId' | 'agentTitle' | 'startedAt' | 'endedAt'>;

/** Injected seams. Production passes only `gitExe`; the rest default to the live
 *  database / git runtime. Tests override every seam with in-memory fakes. */
export interface SaveCardRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readCaptureTurns?: CaptureTurnReader;
  getAgentsByWorkspace?: (workspaceId: string) => readonly Agent[];
  getAgent?: (agentId: string) => Agent | null;
  readBundleTurns?: (workspaceId: string) => readonly BundleTurn[];
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  /** Best-effort canonicalizer; defaults to `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
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

/** Attach presentation identity without changing component membership/topology. */
function attachBundleIdentity(
  bundle: WorkBundle,
  agents: ReadonlyMap<string, Agent>,
  turns: ReadonlyMap<string, BundleTurn>,
  witnesses: readonly TurnWitnessRead[],
  structuralSupervisors: ReadonlyMap<string, Agent>,
): SaveCardInventoryResponse[number] {
  if (bundle.kind === 'unattributed' || !bundle.component) {
    return { ...bundle, identity: null };
  }

  const turnIds = new Set(bundle.component.associations.flatMap((a) => a.contributingTurnIds));
  const relevantWitnesses = witnesses.filter((witness) => turnIds.has(witness.turnId));
  const agentIds = new Set(relevantWitnesses.flatMap((w) => w.agentId ? [w.agentId] : []));
  const ownerIds = new Set<string>();

  for (const witness of relevantWitnesses) {
    const agent = witness.agentId ? agents.get(witness.agentId) : undefined;
    const structural = agent ? structuralSupervisors.get(agent.workspaceId) : undefined;
    const ownerId = witness.ownerAgentId
      ?? agent?.ownerAgentId
      ?? (agent?.isSupervisor ? agent.id : undefined)
      ?? (agent?.isSupervised ? structural?.id : undefined);
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

  const name = rendererSafeText(identityAgent?.title
    ?? (source === 'mixed' ? workerUnits.map((unit) => unit.name).join(' + ') : workerUnits[0]?.name)
    ?? 'Unknown agent');
  const roleDescription = rendererSafeText(nonEmpty(
    identityAgent?.roleDescription,
    workerUnits.map((unit) => unit.roleDescription).filter((value, index, all) => all.indexOf(value) === index).join(' '),
  ));
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
  // Read ALL turns for a workspace (large limit), matching the unbounded witness
  // read, so capture-health and protection-edge projection see the same turn
  // universe rather than only the newest default window.
  const readCaptureTurns: CaptureTurnReader =
    deps.readCaptureTurns ??
    ((workspaceId) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
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
    readCaptureTurns,
  });

  async function getInventory(
    req: SaveCardInventoryRequest,
  ): Promise<SaveCardInventoryResponse> {
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      getWorkspaces().map(async (ws): Promise<CandidateWorkspaceInput> => {
        const workspaceDir = canonicalDir(realpath, ws.path);
        const capability = await probeWorkspaceGit(workspaceDir);
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

    const bundles = await service.listWorkBundles({
      targetWorkspaceId: req.workspaceId,
      workspaces,
    });

    const includedWorkspaceIds = new Set(bundles.flatMap((bundle) =>
      bundle.workspaces.map((workspace) => workspace.workspaceId),
    ));
    const agentRows = [...includedWorkspaceIds].flatMap((workspaceId) => getAgentsByWorkspace(workspaceId));
    const agents = new Map(agentRows.map((agent) => [agent.id, agent]));
    const structuralSupervisors = new Map(
      agentRows.filter((agent) => agent.isSupervisor).map((agent) => [agent.workspaceId, agent]),
    );
    const bundleTurns = [...includedWorkspaceIds].flatMap((workspaceId) => readBundleTurns(workspaceId));
    const turns = new Map(bundleTurns.map((turn) => [turn.id, turn]));
    const witnesses = [...includedWorkspaceIds].flatMap((workspaceId) => readTurnWitnesses(workspaceId));
    for (const ownerId of new Set(witnesses.flatMap((witness) => witness.ownerAgentId ? [witness.ownerAgentId] : []))) {
      if (!agents.has(ownerId)) {
        const owner = getAgent(ownerId);
        if (owner) agents.set(ownerId, owner);
      }
    }

    return bundles.map((bundle) => attachBundleIdentity(
      bundle,
      agents,
      turns,
      witnesses,
      structuralSupervisors,
    ));
  }

  return { getInventory };
}
