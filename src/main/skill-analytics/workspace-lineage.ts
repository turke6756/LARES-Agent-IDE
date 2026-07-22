// workspace-lineage.ts — workspace-LEVEL identity resolution for behavior data
// (Priority 0 / WP-2B). Folds a stream's launch working directory to its WORKSPACE
// root and, when that root maps to EXACTLY one registered workspace, its workspace_id.
//
// SHARED-CWD INVARIANT (root CLAUDE.md): a cwd/root identifies a WORKSPACE, never an
// individual agent. Many agents launch from the SAME `.dashboard/**` template dir, so
// this module NEVER attributes a cwd to an agent — only to a workspace. Ambiguity (a
// folded root that maps to zero or > 1 workspace) resolves to null, never a guess:
// unique root ownership is the leak firewall (brief risk: permissive fallback leaks
// cross-workspace behavior).
//
// Pure + IO-free: the caller injects the workspace registry (id + path list). Path
// folding delegates to `normalizeExecPath` so ingestion, backfill, and the guidance
// compiler collapse Windows/WSL/POSIX forms to ONE key identically.

import { normalizeExecPath } from './command-path-extractor';

/** Attribution-method + version stamped on lineage we RESOLVE (as opposed to a
 *  directly-witnessed launch association) so a later correction never masquerades as a
 *  direct ingestion-time identity (brief risk: corrections masquerading as identity). */
export const WORKSPACE_LINEAGE_VERSION = 1;

/** How a stream's persisted `workspace_id` was derived. Only `root` is emitted today
 *  (we fold a launch cwd → root → workspace). `explicit` is reserved for a future
 *  direct launch-time association and is NEVER claimed by this resolver. */
export type WorkspaceAttributionMethod = 'explicit' | 'root';

/** The `.dashboard/**` template tails a dashboard agent launches under. A launch cwd
 *  ending in one of these folds to its PARENT as the workspace root. Kept local (a copy
 *  of lane-attribution's TEMPLATE_TAILS) so the workspace concern stays decoupled from
 *  the lane concern — the two evolve independently. */
const TEMPLATE_TAILS: readonly string[] = [
  '.lares/supervisor',
  '.lares/researcher',
  '.lares/workers/claude',
  '.lares/workers/codex',
  // Legacy `.dashboard/**` — historical session streams permanently carry the
  // pre-rename template dirs; folding must keep recognizing them.
  '.dashboard/supervisor',
  '.dashboard/researcher',
  '.dashboard/workers/claude',
  '.dashboard/workers/codex',
];

export interface WorkspaceRecordLite { id: string; path: string; }
export interface WorkspaceLineage {
  workspaceId: string;
  workspaceRoot: string;
  method: WorkspaceAttributionMethod;
}

/** Normalize a path to fwd-slash, no trailing sep, lowercased — comparison key only
 *  (case-insensitive for Windows; the canonical case is preserved for storage). */
function normKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Fold a launch working directory to its candidate WORKSPACE root (canonical absolute
 * form, forward-slashed, case preserved). Strips a recognized `.dashboard/**` template
 * tail; a cwd with NO such tail is returned canonicalized as-is (a legacy agent may
 * launch directly in the workspace root). Returns null for an unusable/relative path,
 * or a bare `.dashboard/**` tail with no parent (no knowable root).
 */
export function foldLaunchCwdToWorkspaceRoot(workingDir: string | null | undefined): string | null {
  if (!workingDir || !workingDir.trim()) return null;
  const canon = normalizeExecPath(workingDir, null).normalizedPath;
  if (!canon) return null;
  const fwd = canon.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!fwd) return null;
  const low = fwd.toLowerCase();
  for (const tail of TEMPLATE_TAILS) {
    if (low.endsWith('/' + tail)) {
      const root = fwd.slice(0, fwd.length - (tail.length + 1));
      return root || null;
    }
    if (low === tail) return null; // bare template dir, no parent → workspace unknowable
  }
  return fwd;
}

/**
 * Resolve a launch cwd to EXACTLY-ONE registered workspace (workspace-LEVEL). Returns
 * null unless the folded root matches one and only one workspace path — ambiguity (a
 * root mapping to 0 or > 1 workspace) resolves to null so a permissive fallback can
 * never leak one workspace's behavior into another's scope (brief risk / unique-root
 * ownership rule). The returned `workspaceRoot` is the folded canonical root; `method`
 * is always `root` (this resolver folds, it never witnesses a direct association).
 */
export function resolveWorkspaceForCwd(
  workingDir: string | null | undefined,
  workspaces: readonly WorkspaceRecordLite[],
): WorkspaceLineage | null {
  const root = foldLaunchCwdToWorkspaceRoot(workingDir);
  if (!root) return null;
  const rootKey = normKey(root);
  let hit: WorkspaceRecordLite | null = null;
  for (const w of workspaces) {
    if (!w.path) continue;
    const wc = normalizeExecPath(w.path, null).normalizedPath;
    if (wc != null && normKey(wc) === rootKey) {
      if (hit) return null; // > 1 match → ambiguous, retain null
      hit = w;
    }
  }
  if (!hit) return null;
  return { workspaceId: hit.id, workspaceRoot: root, method: 'root' };
}
