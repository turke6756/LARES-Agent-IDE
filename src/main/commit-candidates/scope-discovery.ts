// SC-WP-1A — repository scope discovery (bundle contract v1 §1). MAIN-PROCESS ONLY.
//
// A single `repositoryKey` (one worktree index) is shared by EVERY Lares
// workspace that aliases that worktree — the architectural invariant that agents
// share a working directory means many workspaces map to one repo. This module
// groups a set of workspace probes by their derived `repositoryKey` and produces
// the canonical `RepositoryIdentity`, whose `workspaces` array is deterministically
// sorted by `workspaceId` (contract §1).
//
// Linked worktrees produce DISTINCT `repositoryKey`s (different index) even though
// they share `objectDatabaseKey`, so they land in SEPARATE groups here — exactly
// the "one graph per worktree, object writes serialized on the shared common-dir"
// topology the contract pins.

import type { RepositoryIdentity } from '../../shared/commit-candidates';
import type { GitCapability } from '../../shared/types';
import {
  deriveRepositoryIdentity,
  type RepositoryIdentityDeps,
  type RepositoryIdentityOutcome,
} from './repository-identity';

/** One workspace to probe: its id, the canonical dir its git seam is bound to,
 *  and its capability probe (source of `commonDirQueueKey` + `workspacePrefix`). */
export interface WorkspaceScopeInput {
  workspaceId: string;
  workspaceDir: string;
  capability: Pick<GitCapability, 'commonDirQueueKey' | 'workspacePrefix'>;
}

/** Per-workspace deps. `runGitFor` yields a `RunGit` bound to a given workspace
 *  dir (mirrors `makeRealRunGit(execPath, dir, platform)` in git-runtime); the
 *  rest of the seam is shared. */
export interface ScopeDiscoveryDeps extends Omit<RepositoryIdentityDeps, 'runGit'> {
  runGitFor(workspaceDir: string): RepositoryIdentityDeps['runGit'];
}

/** A discovered repository scope: the canonical identity plus the per-workspace
 *  derivation outcomes that contributed (diagnostics — some inputs may have been
 *  rejected, e.g. bare, and are surfaced separately). */
export interface RepositoryScope {
  identity: RepositoryIdentity;
}

/** Deterministic `workspaces` sort — by `workspaceId`, contract §1. Pure string
 *  order (locale-independent) so the array is stable across platforms. */
function byWorkspaceId(
  a: { workspaceId: string },
  b: { workspaceId: string },
): number {
  if (a.workspaceId < b.workspaceId) return -1;
  if (a.workspaceId > b.workspaceId) return 1;
  return 0;
}

/**
 * Derive every workspace's `repositoryKey` and group the ones that share it into
 * canonical `RepositoryIdentity` records. Workspaces whose derivation is rejected
 * (bare, non-repo, index-unresolvable, …) do NOT contribute to any group; their
 * outcomes are returned in `rejected` for the caller to surface.
 *
 * Returns scopes keyed by `repositoryKey`. Within a scope the `workspaces` array
 * is sorted by `workspaceId`; `objectDatabaseKey`/`gitObjectFormat` are taken from
 * the first contributing workspace (all aliases of one worktree agree by
 * construction — same common dir, same object format).
 */
export async function discoverRepositoryScopes(
  inputs: WorkspaceScopeInput[],
  deps: ScopeDiscoveryDeps,
): Promise<{
  scopes: Map<string, RepositoryScope>;
  rejected: Array<{ workspaceId: string; outcome: Extract<RepositoryIdentityOutcome, { ok: false }> }>;
}> {
  interface Accum {
    objectDatabaseKey: string;
    gitObjectFormat: 'sha1' | 'sha256';
    workspaces: Array<{ workspaceId: string; workspacePrefix: string }>;
  }
  const accum = new Map<string, Accum>();
  const rejected: Array<{ workspaceId: string; outcome: Extract<RepositoryIdentityOutcome, { ok: false }> }> = [];

  // Workspace probes are independent read-only operations. Resolve them
  // concurrently, then fold results in input order so scope and rejection
  // ordering remain deterministic.
  const derived = await Promise.all(inputs.map(async (input) => {
    try {
      const perWorkspaceDeps: RepositoryIdentityDeps = {
        runGit: deps.runGitFor(input.workspaceDir),
        platform: deps.platform,
        realpath: deps.realpath,
        fileExists: deps.fileExists,
      };
      const outcome = await deriveRepositoryIdentity(input.workspaceDir, input.capability, perWorkspaceDeps);
      return { ok: true as const, input, outcome };
    } catch (error) {
      return { ok: false as const, input, error };
    }
  }));

  for (const item of derived) {
    if (!item.ok) throw item.error;
    const { input, outcome } = item;
    if (!outcome.ok) {
      rejected.push({ workspaceId: input.workspaceId, outcome });
      continue;
    }
    let group = accum.get(outcome.repositoryKey);
    if (!group) {
      group = {
        objectDatabaseKey: outcome.objectDatabaseKey,
        gitObjectFormat: outcome.gitObjectFormat,
        workspaces: [],
      };
      accum.set(outcome.repositoryKey, group);
    }
    // `workspacePrefix` is '' when the workspace IS the repo root (POSIX,
    // top-anchored) — carried through verbatim from the capability probe.
    group.workspaces.push({
      workspaceId: input.workspaceId,
      workspacePrefix: input.capability.workspacePrefix ?? '',
    });
  }

  const scopes = new Map<string, RepositoryScope>();
  for (const [repositoryKey, group] of accum) {
    const workspaces = group.workspaces.slice().sort(byWorkspaceId);
    const identity: RepositoryIdentity = {
      repositoryKey,
      objectDatabaseKey: group.objectDatabaseKey,
      gitObjectFormat: group.gitObjectFormat,
      bareRepo: false,
      workspaces,
    };
    scopes.set(repositoryKey, { identity });
  }

  return { scopes, rejected };
}

/**
 * Convenience: discover the ONE `RepositoryIdentity` for the scope a given
 * workspace belongs to (all workspaces sharing that workspace's `repositoryKey`),
 * or `null` if that workspace's derivation was rejected.
 */
export async function discoverScopeForWorkspace(
  targetWorkspaceId: string,
  inputs: WorkspaceScopeInput[],
  deps: ScopeDiscoveryDeps,
): Promise<RepositoryIdentity | null> {
  const target = inputs.find((i) => i.workspaceId === targetWorkspaceId);
  if (!target) return null;
  const perWorkspaceDeps: RepositoryIdentityDeps = {
    runGit: deps.runGitFor(target.workspaceDir),
    platform: deps.platform,
    realpath: deps.realpath,
    fileExists: deps.fileExists,
  };
  const outcome = await deriveRepositoryIdentity(target.workspaceDir, target.capability, perWorkspaceDeps);
  if (!outcome.ok) return null;

  const { scopes } = await discoverRepositoryScopes(inputs, deps);
  return scopes.get(outcome.repositoryKey)?.identity ?? null;
}
