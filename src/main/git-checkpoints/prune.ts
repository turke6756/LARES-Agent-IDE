// prune.ts — the explicit, user-initiated "delete my checkpoint refs" command
// (Git-Native WP-G3.5). MAIN-PROCESS ONLY.
//
// This is NOT retention (retention.ts). Retention is age/status-driven and MUST
// distill-before-prune (shape §2.10) so the before→after diff survives as
// `diff_stats` + `compact_diff`. THIS command is the human/supervisor saying
// "clear my recovery refs" outright: it deletes both encoded namespaces for the
// asserted workspace and reports the deleted-ref count. It does not distill (the
// user asked to delete, not to keep a distillate), does not force-prune objects,
// and never runs gc/repack/maintenance — unreachable objects are left to normal
// git maintenance exactly as retention leaves them.
//
// Two encoded namespaces are deleted for a workspace (WP-G1.3a ref-encoding):
//   refs/lares/checkpoints/<enc(workspaceId)>/*
//   refs/lares/recovery/<enc(workspaceId)>/*
// Enumeration is by the encoded prefix, then FILTERED by an exact decode back to
// the target workspaceId — so even if another workspace's encoding shared a string
// prefix, its refs can never be swept in. Deletion is ONE atomic
// `git update-ref --stdin` batch (WP-G1.8 `deleteRefPair`): git locks every ref
// simultaneously and applies all-or-nothing, so a prune never half-clears a repo.
//
// The repo-wide purge (enumerateRepoLaresRefs + repoWidePurgeExecute) is a DISTINCT,
// human-only, explicitly-confirmed disaster action for the pre-`git filter-repo`
// case. It deliberately has NO workspace scope — it clears EVERY `refs/lares/*` in a
// shared repo — so the human surface (checkpoint-ipc) FIRST enumerates and NAMES the
// affected workspaces before acting. There is no unscoped `--all` on the
// capability/MCP surface that could silently delete another workspace's recovery refs.

import { runGit as realRunGit } from './git-command';
import type { RunGitLike } from './checkpoint-service';
import { deleteRefPair } from './reconciler';
import { parseCheckpointRef, parseRecoveryRef, encodeIdComponent } from './ref-encoding';
import { CheckpointQueue, type SkippedDeadline } from './checkpoint-queue';

const CHECKPOINTS_PREFIX = 'refs/lares/checkpoints';
const RECOVERY_PREFIX = 'refs/lares/recovery';

/** Ref names round-trip through a bounded buffer; a large repo can hold many turns,
 *  so this cap is generous (a refname is ~120 bytes; 32 MiB is ~250k refs). */
const REF_LIST_MAX_BYTES = 32 << 20;

// ── the workspace this ref belongs to, or null when it is not a Lares ref ──────────

/** Decode a Lares checkpoint/recovery ref to the workspaceId it is scoped to, or
 *  null when the ref is neither namespace or does not decode (a hand-mangled ref
 *  never throws). This is the authority for scoping — the encoded-prefix match that
 *  git does is only a coarse filter. */
export function refWorkspaceId(ref: string): string | null {
  const cp = parseCheckpointRef(ref);
  if (cp) return cp.workspaceId;
  const rc = parseRecoveryRef(ref);
  if (rc) return rc.workspaceId;
  return null;
}

// ── low-level enumeration ─────────────────────────────────────────────────────────

/** `git for-each-ref --format=%(refname) <patterns…>` → the matching ref names.
 *  Patterns match at `/` boundaries, so an encoded-id prefix never bleeds into a
 *  longer sibling; the caller still re-decodes to be certain. A non-zero exit (an
 *  unusable repo) surfaces as a thrown error — a prune must report an honest count,
 *  never a silent zero. Zero matches is exit 0 + empty output. */
async function forEachRef(
  runGit: RunGitLike,
  repoRoot: string,
  gitExe: string,
  patterns: string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const res = await runGit(repoRoot, ['for-each-ref', '--format=%(refname)', ...patterns], {
    gitExe,
    allowNonzero: true,
    timeoutMs: 30_000,
    maxBytes: REF_LIST_MAX_BYTES,
  });
  if (res.code !== 0) {
    throw Object.assign(new Error(`git for-each-ref failed (code ${res.code}): ${res.stderr}`), {
      code: 'checkpoint-prune-enumerate-failed',
    });
  }
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Delete a batch of refs in ONE atomic `update-ref --stdin` transaction. No expected
 *  old-OID: this is an unconditional "delete the whole namespace" op (the user asked
 *  to clear it), so a concurrent re-point does not abort the batch. All-or-nothing. */
async function deleteAll(
  runGit: RunGitLike,
  repoRoot: string,
  gitExe: string,
  refs: string[],
): Promise<void> {
  if (refs.length === 0) return;
  const del = await deleteRefPair({
    repoRoot,
    gitExe,
    deletions: refs.map((ref) => ({ ref })),
    runGit,
  });
  if (!del.ok) {
    throw Object.assign(new Error(`atomic ref delete failed (code ${del.code}): ${del.stderr}`), {
      code: 'checkpoint-prune-delete-failed',
    });
  }
}

/** Run `fn` under the object-database queue lock when a queue+key are supplied, so
 *  the enumerate→delete pair does not interleave with live checkpoint traffic on the
 *  same common dir. `withLock` uses an Infinite deadline, so it never expires; the
 *  SkippedDeadline branch is defensive only. Without a queue (tests), run directly. */
async function serialize<T>(
  queue: CheckpointQueue | undefined,
  key: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!queue || !key) return fn();
  const settled = await queue.withLock(key, fn);
  if (isSkippedDeadline(settled)) {
    throw Object.assign(new Error('prune could not acquire the object-db lock'), {
      code: 'checkpoint-prune-unavailable',
    });
  }
  return settled;
}

function isSkippedDeadline(v: unknown): v is SkippedDeadline {
  return typeof v === 'object' && v !== null && (v as SkippedDeadline).skipped === 'deadline';
}

// ── workspace-scoped prune (the default command) ───────────────────────────────────

export interface WorkspacePruneDeps {
  workspaceId: string;
  repoRoot: string;
  gitExe: string;
  runGit?: RunGitLike;
  /** The shared CheckpointQueue — the enumerate→delete runs under its object-db lock
   *  when this + `commonDirQueueKey` are supplied (production). Omitted in unit tests. */
  queue?: CheckpointQueue;
  /** `capability.commonDirQueueKey` — the object-database serialization key. */
  commonDirQueueKey?: string;
}

export interface WorkspacePruneResult {
  workspaceId: string;
  /** How many refs the atomic batch deleted (both namespaces combined). */
  deletedRefs: number;
  /** The exact ref names deleted — diagnostic; carries NO workspace bytes. */
  refs: string[];
}

/**
 * Delete BOTH encoded namespaces for one workspace — checkpoints + recovery — in a
 * single atomic batch, and report the count. Objects are left for normal git
 * maintenance (no gc/prune). Enumerates by the encoded prefix, then keeps only refs
 * that DECODE back to exactly this workspaceId, so a sibling workspace's refs in a
 * shared repo are never touched.
 */
export async function pruneWorkspaceCheckpoints(deps: WorkspacePruneDeps): Promise<WorkspacePruneResult> {
  const runGit = deps.runGit ?? realRunGit;
  const enc = encodeIdComponent(deps.workspaceId);
  const patterns = [`${CHECKPOINTS_PREFIX}/${enc}`, `${RECOVERY_PREFIX}/${enc}`];

  return serialize(deps.queue, deps.commonDirQueueKey, async () => {
    const candidates = await forEachRef(runGit, deps.repoRoot, deps.gitExe, patterns);
    // Exact-decode scope guard: only refs that resolve to THIS workspace.
    const refs = candidates.filter((ref) => refWorkspaceId(ref) === deps.workspaceId);
    await deleteAll(runGit, deps.repoRoot, deps.gitExe, refs);
    return { workspaceId: deps.workspaceId, deletedRefs: refs.length, refs };
  });
}

// ── repo-wide enumeration + purge (human-only, pre-filter-repo) ─────────────────────

export interface RepoPurgeDeps {
  repoRoot: string;
  gitExe: string;
  runGit?: RunGitLike;
  queue?: CheckpointQueue;
  commonDirQueueKey?: string;
}

export interface RepoLaresRefEnumeration {
  /** Every `refs/lares/checkpoints/*` + `refs/lares/recovery/*` ref in the repo. */
  allRefs: string[];
  /** Decodable refs grouped by their workspaceId (sorted by id for a stable UI). */
  byWorkspace: { workspaceId: string; refs: string[] }[];
  /** Lares-namespace refs that do NOT decode to a workspace (hand-mangled / legacy).
   *  A repo-wide purge still clears them; they are surfaced so the human sees them. */
  undecodableRefs: string[];
}

/**
 * Enumerate EVERY Lares ref in the repo and group by decoded workspace. This is the
 * "name the blast radius" step: a shared repo may hold refs for several workspaces,
 * and the human MUST see all of them before a repo-wide purge. Pure read — deletes
 * nothing.
 */
export async function enumerateRepoLaresRefs(deps: RepoPurgeDeps): Promise<RepoLaresRefEnumeration> {
  const runGit = deps.runGit ?? realRunGit;
  const allRefs = await forEachRef(runGit, deps.repoRoot, deps.gitExe, [
    CHECKPOINTS_PREFIX,
    RECOVERY_PREFIX,
  ]);
  const byId = new Map<string, string[]>();
  const undecodableRefs: string[] = [];
  for (const ref of allRefs) {
    const wsId = refWorkspaceId(ref);
    if (wsId === null) {
      undecodableRefs.push(ref);
      continue;
    }
    const bucket = byId.get(wsId);
    if (bucket) bucket.push(ref);
    else byId.set(wsId, [ref]);
  }
  const byWorkspace = [...byId.entries()]
    .map(([workspaceId, refs]) => ({ workspaceId, refs }))
    .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0));
  return { allRefs, byWorkspace, undecodableRefs };
}

export interface RepoWidePurgeResult {
  deletedRefs: number;
  refs: string[];
}

/**
 * Delete EVERY Lares ref in the repo — both namespaces, ALL workspaces — in one
 * atomic batch. Human-only disaster action; the caller (checkpoint-ipc) enforces the
 * explicit-confirmation gate and surfaces the enumeration first. Objects are left for
 * normal git maintenance (no gc/prune).
 */
export async function repoWidePurgeExecute(deps: RepoPurgeDeps): Promise<RepoWidePurgeResult> {
  const runGit = deps.runGit ?? realRunGit;
  return serialize(deps.queue, deps.commonDirQueueKey, async () => {
    const { allRefs } = await enumerateRepoLaresRefs({ ...deps, runGit });
    await deleteAll(runGit, deps.repoRoot, deps.gitExe, allRefs);
    return { deletedRefs: allRefs.length, refs: allRefs };
  });
}
