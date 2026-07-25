// checkpoint-ipc.ts — Git-Native WP-G2.2: the HUMAN renderer's checkpoint IPC.
// MAIN-PROCESS ONLY.
//
// Mirrors the capability-bound HTTP routes (WP-G2.1) for the renderer, but this
// path is TRUSTED (it is the renderer — no capability token) while staying
// workspace-scoped and reusing the SAME domain checks (witnessed-subset,
// preview token, active-turn contention) through the shared engine/service
// surface. The engine bootstrap builds the force-capable `HumanCheckpointRoutes`
// (reusing CheckpointService + the WP-G2.1 CheckpointRoutes) and injects it here
// late via `setHumanCheckpointRoutes`, because the engine resolves asynchronously
// after the IPC handlers are registered.
//
// The one thing this surface adds over the agent HTTP routes is `force` — the
// stale-preview override. Open #4 (plans/git-native-plan-shape.md §5): a human may
// force past a stale preview conflict ONLY once NO active turn witnesses a
// requested path. That gate lives HERE (IPC-only policy) and is enforced by
// re-deriving the active-turn contention server-side via the shared `preview`
// (whose `contention` is the service's open-turn witness join — the durable form
// of the coordinator's live `currentOpenTurnId`/`currentWitnessTarget` state).

import {
  CHECKPOINT_CHANNELS,
  type CheckpointDiffResult,
  type CheckpointFileHistoryResult,
  type CheckpointListResult,
  type CheckpointPreviewResult,
  type CheckpointPruneResult,
  type CheckpointRestoreRequest,
  type CheckpointRestoreResult,
  type CheckpointRevertRequest,
  type GitInitResult,
  type RepoWidePurgeResult,
} from '../../shared/types';

/** The force-capable engine surface the IPC layer drives. Built by the engine
 *  bootstrap over the SAME CheckpointService + WP-G2.1 CheckpointRoutes, so the
 *  witnessed-subset and preview-token checks are shared, not reimplemented. Unlike
 *  the HTTP `CheckpointRoutes`, `restore`/`revert` here DO accept `force` — that is
 *  the whole point of the IPC-only path. All args are workspace-scoped. */
export interface HumanCheckpointRoutes {
  list(workspaceId: string, opts?: { agentId?: string }): Promise<CheckpointListResult>;
  /** WP-G3.1 — versions of one canonical path across retained, live-verified turns. */
  fileHistory(workspaceId: string, path: string, opts?: { agentId?: string }): Promise<CheckpointFileHistoryResult>;
  diff(workspaceId: string, turnId: string): Promise<CheckpointDiffResult>;
  preview(workspaceId: string, turnId: string, paths?: string[]): Promise<CheckpointPreviewResult>;
  restore(args: {
    workspaceId: string;
    turnId: string;
    paths: string[];
    previewTokens?: Record<string, string>;
    force?: boolean;
  }): Promise<CheckpointRestoreResult>;
  revert(args: {
    workspaceId: string;
    turnId: string;
    previewTokens?: Record<string, string>;
    force?: boolean;
  }): Promise<CheckpointRestoreResult>;
  /** WP-G3.4 — the human-only `git init` consent action. Creates a repository at a
   *  non-repo workspace root (refusing an already-repo / protected root / unusable
   *  git), then invalidates the WP-G0.2/G0.3 capability + prerequisite caches so the
   *  workspace re-probes as a repo. Human-side only — never an agent MCP tool or a
   *  capability HTTP route. */
  initRepo(workspaceId: string): Promise<GitInitResult>;
  /** WP-G3.5 — delete this workspace's checkpoint + recovery refs (both encoded
   *  namespaces) in one atomic batch and report the count. Same semantics as the
   *  supervisor MCP tool / capability route; objects are left for git maintenance. */
  prune(workspaceId: string): Promise<CheckpointPruneResult>;
  /** WP-G3.5 — enumerate + NAME every workspace whose `refs/lares/*` live in the
   *  (possibly shared) repo this workspace belongs to, WITHOUT deleting. The
   *  "name the blast radius" step the human sees before a repo-wide purge. */
  repoWidePurgePlan(workspaceId: string): Promise<RepoWidePurgeResult>;
  /** WP-G3.5 — apply the repo-wide purge (ALL `refs/lares/*` in the repo, every
   *  workspace) ONLY when `confirm` is true; otherwise returns the plan unexecuted.
   *  Human-only; there is no unscoped `--all` on the agent surface. */
  repoWidePurge(args: { workspaceId: string; confirm: boolean }): Promise<RepoWidePurgeResult>;
}

/** The minimal `ipcMain.handle` shape (mirrors lifecycle-ipc's IpcLike) so the
 *  registrar is unit-testable without a live Electron main. */
export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Failure reason stamped on a restore/revert refused because an active turn
 *  witnesses a requested path (Open #4). */
export const FORCE_REFUSED_ACTIVE_TURN = 'active-turn-witnesses-path';

class CheckpointIpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CheckpointIpcError';
  }
}

/** The engine has not finished bootstrapping (or there is no usable git). Trusted
 *  renderer, so we surface the honest reason rather than a silent empty result. */
function requireRoutes(routes: HumanCheckpointRoutes | null): HumanCheckpointRoutes {
  if (!routes) {
    throw new CheckpointIpcError(
      'Checkpoint engine not available (no usable git, or the engine has not finished bootstrapping)',
      'checkpoint-engine-unavailable',
    );
  }
  return routes;
}

function requireWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new CheckpointIpcError('a non-empty workspaceId is required', 'checkpoint-bad-request');
  }
  return raw;
}

function requireTurnId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new CheckpointIpcError('a non-empty turnId is required', 'checkpoint-bad-request');
  }
  return raw;
}

function normalizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function normalizeTokens(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A "nothing happened" refusal outcome — the shape the renderer's RestoreDialog
 *  reads to explain WHY a force was declined, with the contended turns attached. */
function refusal(
  kind: 'restore_paths' | 'revert_turn',
  requestedPaths: string[],
  contention: { path: string; turnId: string }[],
): CheckpointRestoreResult {
  return {
    status: 'failed',
    operationId: '',
    kind,
    preRef: null,
    preOid: null,
    requestedPaths,
    completedPaths: [],
    rejectedPaths: [],
    failures: [],
    contention,
    failureReason: FORCE_REFUSED_ACTIVE_TURN,
  };
}

/**
 * The Open #4 gate. A human `force` is permitted ONLY when no active turn
 * witnesses a requested path. We re-derive the active-turn witness set
 * SERVER-SIDE from the shared `preview` (never from renderer-supplied data) — its
 * `contention` is the service's join over OPEN turn_records, the durable form of
 * the coordinator's live `currentOpenTurnId`/`currentWitnessTarget`. Returns the
 * contention that must block the force, or an empty array when force is clear.
 *
 * When `force` is not requested this is skipped entirely: a non-force restore
 * relies on the preview token and never needs this override gate.
 */
async function activeTurnContention(
  routes: HumanCheckpointRoutes,
  workspaceId: string,
  turnId: string,
  paths: string[] | undefined,
): Promise<{ path: string; turnId: string }[]> {
  const pv = await routes.preview(workspaceId, turnId, paths);
  return pv.contention ?? [];
}

export function registerCheckpointIpc(ipc: IpcLike, getRoutes: () => HumanCheckpointRoutes | null): void {
  ipc.handle(CHECKPOINT_CHANNELS.list, async (_e, workspaceId: unknown, opts: unknown) => {
    const routes = requireRoutes(getRoutes());
    const wsId = requireWorkspaceId(workspaceId);
    const agentId = (opts as { agentId?: unknown } | undefined)?.agentId;
    return routes.list(wsId, typeof agentId === 'string' && agentId ? { agentId } : undefined);
  });

  ipc.handle(CHECKPOINT_CHANNELS.fileHistory, async (_e, workspaceId: unknown, filePath: unknown, opts: unknown) => {
    const routes = requireRoutes(getRoutes());
    const wsId = requireWorkspaceId(workspaceId);
    if (typeof filePath !== 'string' || filePath === '') {
      throw new CheckpointIpcError('a non-empty path is required', 'checkpoint-bad-request');
    }
    const agentId = (opts as { agentId?: unknown } | undefined)?.agentId;
    return routes.fileHistory(wsId, filePath, typeof agentId === 'string' && agentId ? { agentId } : undefined);
  });

  ipc.handle(CHECKPOINT_CHANNELS.diff, async (_e, workspaceId: unknown, turnId: unknown) => {
    const routes = requireRoutes(getRoutes());
    return routes.diff(requireWorkspaceId(workspaceId), requireTurnId(turnId));
  });

  ipc.handle(CHECKPOINT_CHANNELS.preview, async (_e, workspaceId: unknown, turnId: unknown, paths: unknown) => {
    const routes = requireRoutes(getRoutes());
    const p = normalizePaths(paths);
    return routes.preview(requireWorkspaceId(workspaceId), requireTurnId(turnId), p.length > 0 ? p : undefined);
  });

  ipc.handle(CHECKPOINT_CHANNELS.restore, async (_e, raw: unknown) => {
    const routes = requireRoutes(getRoutes());
    const req = (raw ?? {}) as Partial<CheckpointRestoreRequest>;
    const workspaceId = requireWorkspaceId(req.workspaceId);
    const turnId = requireTurnId(req.turnId);
    const paths = normalizePaths(req.paths);
    if (paths.length === 0) {
      throw new CheckpointIpcError(
        'restore requires a non-empty `paths` array (a subset of the turn\'s witnessed set)',
        'checkpoint-bad-request',
      );
    }
    const previewTokens = normalizeTokens(req.previewTokens);
    const force = req.force === true;
    if (force) {
      // Open #4: refuse a force while an active turn witnesses any requested path.
      const contention = await activeTurnContention(routes, workspaceId, turnId, paths);
      if (contention.length > 0) return refusal('restore_paths', paths, contention);
    }
    return routes.restore({ workspaceId, turnId, paths, previewTokens, force });
  });

  ipc.handle(CHECKPOINT_CHANNELS.revert, async (_e, raw: unknown) => {
    const routes = requireRoutes(getRoutes());
    const req = (raw ?? {}) as Partial<CheckpointRevertRequest>;
    const workspaceId = requireWorkspaceId(req.workspaceId);
    const turnId = requireTurnId(req.turnId);
    const previewTokens = normalizeTokens(req.previewTokens);
    const force = req.force === true;
    if (force) {
      // Full-turn revert: the gate consults the turn's whole witnessed set
      // (preview with no paths defaults to it).
      const contention = await activeTurnContention(routes, workspaceId, turnId, undefined);
      if (contention.length > 0) return refusal('revert_turn', [], contention);
    }
    return routes.revert({ workspaceId, turnId, previewTokens, force });
  });

  // WP-G3.4 — the human-only `git init` consent action. Registered here alongside
  // the other renderer checkpoint channels so it shares the trusted-renderer,
  // NO-capability-token surface; it is deliberately NOT mirrored as an agent MCP
  // tool or a `/api/checkpoints*` HTTP route (a human clicks to create a repo, an
  // agent never does). `requireRoutes` answers an honest "engine unavailable" when
  // there is no usable git, which is itself a truthful reason init cannot run.
  ipc.handle(CHECKPOINT_CHANNELS.gitInit, async (_e, workspaceId: unknown) => {
    const routes = requireRoutes(getRoutes());
    return routes.initRepo(requireWorkspaceId(workspaceId));
  });

  // WP-G3.5 — the explicit "delete my checkpoint refs" command. `prune` is the
  // human mirror of the supervisor MCP tool / capability route: workspace-scoped,
  // deletes both encoded namespaces, reports the count. It carries no `force` and
  // needs no preview — it is a namespace clear, not a path restore.
  ipc.handle(CHECKPOINT_CHANNELS.prune, async (_e, workspaceId: unknown) => {
    const routes = requireRoutes(getRoutes());
    return routes.prune(requireWorkspaceId(workspaceId));
  });

  // WP-G3.5 — the DISTINCT, human-only pre-`filter-repo` purge. The PLAN channel
  // enumerates and NAMES every affected workspace in the (possibly shared) repo
  // without deleting anything, so the UI can show the full blast radius. The EXECUTE
  // channel only clears the refs when `confirm === true`; a missing/false confirm
  // returns the same plan, unexecuted (never a silent purge). Neither is exposed as
  // an MCP tool or an HTTP route.
  ipc.handle(CHECKPOINT_CHANNELS.pruneRepoWidePlan, async (_e, workspaceId: unknown) => {
    const routes = requireRoutes(getRoutes());
    return routes.repoWidePurgePlan(requireWorkspaceId(workspaceId));
  });

  ipc.handle(CHECKPOINT_CHANNELS.pruneRepoWide, async (_e, raw: unknown) => {
    const routes = requireRoutes(getRoutes());
    const req = (raw ?? {}) as { workspaceId?: unknown; confirm?: unknown };
    const workspaceId = requireWorkspaceId(req.workspaceId);
    return routes.repoWidePurge({ workspaceId, confirm: req.confirm === true });
  });
}
