// SC-WP-1G — read-only CommitCandidateService facade.
//
// Every external effect is an injected read seam. The service discovers all
// workspace aliases of one worktree, unions their scoped porcelain inventories,
// projects witnesses across that whole repository identity, and invokes the
// canonical component assembler exactly once.

import * as fs from 'node:fs';

import type {
  BundleCaptureHealth,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  ProtectionRung,
} from '../../shared/commit-candidates';
import type { GitCapability } from '../../shared/types';
import type { RunGit } from '../git/git-runtime';
import {
  type RunGitBytesLike,
  type RunGitTextLike,
  produceDirtyInventory,
} from './dirty-inventory';
import {
  discoverScopeForWorkspace,
  type ScopeDiscoveryDeps,
  type WorkspaceScopeInput,
} from './scope-discovery';
import {
  projectWitnesses,
  type TurnWitnessReader,
} from './witness-projection';
import { assembleConflictComponents } from './component-assembler';
import {
  computeBundleCaptureHealth,
  type CaptureHealthTurn,
} from './capture-health';
import {
  evaluateCheckpointProtection,
  type ProtectionCheckpointEdge,
  type RunProtectionGitBytes,
} from './protection-read';
import {
  projectWorkBundles,
  type WorkBundle,
} from './work-bundle';

export interface CandidateWorkspaceInput extends WorkspaceScopeInput {
  capability: Pick<
    GitCapability,
    'commonDirQueueKey' | 'workspacePrefix' | 'repoRoot'
  >;
  /** Internal Git executable selected by the capability probe. */
  gitExe?: string;
}

export interface CandidateReadRequest {
  targetWorkspaceId: string;
  workspaces: readonly CandidateWorkspaceInput[];
}

export type CaptureTurnReader = (
  workspaceId: string,
) => readonly CaptureHealthTurn[];

export interface CandidateServiceDeps {
  runGit: RunGitTextLike;
  runGitBytes: RunGitBytesLike;
  readTurnWitnesses: TurnWitnessReader;
  readCaptureTurns: CaptureTurnReader;
  platform?: NodeJS.Platform;
  realpath?(path: string): string;
  fileExists?(path: string): boolean;
}

export interface CandidateInventoryRead {
  inventory: DirtyInventory;
  components: ConflictComponent[];
  captureHealthByComponentId: Record<string, BundleCaptureHealth>;
  unattributedCaptureHealth: BundleCaptureHealth;
  protectionByEntryId: Record<string, ProtectionRung>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueScopePrefixes(
  workspaces: readonly { workspacePrefix: string }[],
): string[] {
  const prefixes = [...new Set(workspaces.map((workspace) => workspace.workspacePrefix))];
  // A root workspace already covers every nested alias in the same worktree.
  return prefixes.includes('') ? [''] : prefixes.sort(compareStrings);
}

function dedupeEntries(entries: readonly DirtyEntry[]): DirtyEntry[] {
  const byId = new Map<string, DirtyEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.entryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`inconsistent dirty entry across workspace scopes: ${entry.entryId}`);
    }
    byId.set(entry.entryId, entry);
  }
  return [...byId.values()].sort((left, right) =>
    compareStrings(left.path.pathBytesBase64, right.path.pathBytesBase64)
    || compareStrings(left.entryId, right.entryId),
  );
}

function contributingTurnIds(component: ConflictComponent): Set<string> {
  return new Set(
    component.associations.flatMap((association) => association.contributingTurnIds),
  );
}

function checkpointEdges(turns: readonly CaptureHealthTurn[]): ProtectionCheckpointEdge[] {
  return turns.flatMap((turn) => [
    { ref: turn.beforeRef, oid: turn.beforeOid },
    { ref: turn.afterRef, oid: turn.afterOid },
  ]);
}

function gitExeFor(workspace: CandidateWorkspaceInput): string | undefined {
  return workspace.gitExe;
}

export class CommitCandidateService {
  private readonly deps: Required<
    Pick<CandidateServiceDeps, 'platform' | 'realpath' | 'fileExists'>
  > & Omit<CandidateServiceDeps, 'platform' | 'realpath' | 'fileExists'>;

  constructor(deps: CandidateServiceDeps) {
    this.deps = {
      ...deps,
      platform: deps.platform ?? process.platform,
      realpath: deps.realpath ?? ((path) => fs.realpathSync.native(path)),
      fileExists: deps.fileExists ?? ((path) => fs.existsSync(path)),
    };
  }

  async assembleInventory(request: CandidateReadRequest): Promise<CandidateInventoryRead> {
    const target = request.workspaces.find(
      (workspace) => workspace.workspaceId === request.targetWorkspaceId,
    );
    if (!target) {
      throw new Error(`unknown target workspace: ${request.targetWorkspaceId}`);
    }

    const inputs = request.workspaces.map((workspace): WorkspaceScopeInput => ({
      workspaceId: workspace.workspaceId,
      workspaceDir: workspace.workspaceDir,
      capability: workspace.capability,
    }));
    const workspaceByDir = new Map(
      request.workspaces.map((workspace) => [workspace.workspaceDir, workspace]),
    );
    // Request-local only: discoverScopeForWorkspace probes the target once to
    // identify its repository, then probes every input (including that target)
    // to assemble aliases. Share identical reads within this assembly without
    // carrying potentially stale repository state across separate requests.
    const scopeGitReads = new Map<string, ReturnType<RunGit>>();
    const scopeDeps: ScopeDiscoveryDeps = {
      platform: this.deps.platform,
      realpath: this.deps.realpath,
      fileExists: this.deps.fileExists,
      runGitFor: (workspaceDir): RunGit => {
        const workspace = workspaceByDir.get(workspaceDir);
        return (args) => {
          const key = JSON.stringify([workspaceDir, args]);
          let read = scopeGitReads.get(key);
          if (!read) {
            read = (async () => {
              try {
                return await this.deps.runGit(workspaceDir, args, {
                  gitExe: workspace ? gitExeFor(workspace) : undefined,
                  allowNonzero: true,
                  timeoutMs: 10_000,
                  maxBytes: 1 << 20,
                });
              } catch (error) {
                return {
                  code: 1,
                  stdout: '',
                  stderr: error instanceof Error ? error.message : String(error),
                };
              }
            })();
            scopeGitReads.set(key, read);
          }
          return read;
        };
      },
    };

    const repository = await discoverScopeForWorkspace(
      request.targetWorkspaceId,
      inputs,
      scopeDeps,
    );
    if (!repository) {
      throw new Error(`workspace is not in an assemblable repository: ${request.targetWorkspaceId}`);
    }
    if (!target.capability.repoRoot) {
      throw new Error(`workspace has no repository root: ${request.targetWorkspaceId}`);
    }

    const scopedWorkspaces = repository.workspaces.map((identityWorkspace) => {
      const workspace = request.workspaces.find(
        (candidate) => candidate.workspaceId === identityWorkspace.workspaceId,
      );
      if (!workspace) {
        throw new Error(`repository scope references unknown workspace: ${identityWorkspace.workspaceId}`);
      }
      return workspace;
    });
    const gitExe = gitExeFor(target);
    const drafts = await Promise.all(
      uniqueScopePrefixes(repository.workspaces).map((workspacePrefix) =>
        produceDirtyInventory({
          repoRoot: target.capability.repoRoot!,
          workspacePrefix,
          repository,
          runGitBytes: this.deps.runGitBytes,
          runGit: this.deps.runGit,
          gitExe,
        }),
      ),
    );
    const draft = {
      repository,
      entries: dedupeEntries(drafts.flatMap((item) => item.entries)),
    };

    const witnesses = projectWitnesses(
      repository,
      draft.entries,
      this.deps.readTurnWitnesses,
    );
    const assembly = assembleConflictComponents(draft, witnesses);

    const allTurns = scopedWorkspaces.flatMap(
      (workspace) => [...this.deps.readCaptureTurns(workspace.workspaceId)],
    );
    const turnsById = new Map(allTurns.map((turn) => [turn.id, turn]));
    const captureHealthByComponentId: Record<string, BundleCaptureHealth> = {};
    for (const component of assembly.components) {
      const turns = [...contributingTurnIds(component)]
        .map((turnId) => turnsById.get(turnId))
        .filter((turn): turn is CaptureHealthTurn => turn !== undefined);
      const entries = component.dirtyEntryIds.map(
        (entryId) => assembly.inventory.entries.find((entry) => entry.entryId === entryId)!,
      );
      captureHealthByComponentId[component.componentId] =
        await computeBundleCaptureHealth({
          repoRoot: target.capability.repoRoot,
          turns,
          dirtyEntries: entries,
          runGit: this.deps.runGit,
          gitExe,
        });
    }

    const unattributedEntries = assembly.inventory.unattributedEntryIds.map(
      (entryId) => assembly.inventory.entries.find((entry) => entry.entryId === entryId)!,
    );
    const unattributedCaptureHealth = await computeBundleCaptureHealth({
      repoRoot: target.capability.repoRoot,
      turns: [],
      dirtyEntries: unattributedEntries,
      runGit: this.deps.runGit,
      gitExe,
    });

    const protectionByEntryId: Record<string, ProtectionRung> = {};
    if (assembly.inventory.entries.length > 0) {
      const protection = await evaluateCheckpointProtection({
        repoRoot: target.capability.repoRoot,
        members: assembly.inventory.entries,
        checkpointEdges: checkpointEdges(allTurns),
        runGit: this.deps.runGit,
        runGitBytes: this.deps.runGitBytes as RunProtectionGitBytes,
        gitExe,
      });
      for (const member of protection.members) {
        protectionByEntryId[member.entryId] = member.protection;
      }
    }

    return {
      inventory: assembly.inventory,
      components: assembly.components,
      captureHealthByComponentId,
      unattributedCaptureHealth,
      protectionByEntryId,
    };
  }

  async listWorkBundles(request: CandidateReadRequest): Promise<WorkBundle[]> {
    return projectWorkBundles(await this.assembleInventory(request));
  }
}

// Kept structural and read-only for consumers that prefer a facade interface.
export interface CommitCandidateReadFacade {
  assembleInventory(request: CandidateReadRequest): Promise<CandidateInventoryRead>;
  listWorkBundles(request: CandidateReadRequest): Promise<WorkBundle[]>;
}
