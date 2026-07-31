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

import type { GitCapability } from '../../shared/types';
import type { SaveCardInventoryRequest, SaveCardInventoryResponse } from '../../shared/types';
import {
  getWorkspaces as dbGetWorkspaces,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  listTurnRecords as dbListTurnRecords,
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

/** Injected seams. Production passes only `gitExe`; the rest default to the live
 *  database / git runtime. Tests override every seam with in-memory fakes. */
export interface SaveCardRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readCaptureTurns?: CaptureTurnReader;
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  /** Best-effort canonicalizer; defaults to `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
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

    return service.listWorkBundles({
      targetWorkspaceId: req.workspaceId,
      workspaces,
    });
  }

  return { getInventory };
}
