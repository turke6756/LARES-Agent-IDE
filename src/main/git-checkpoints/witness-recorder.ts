// witness-recorder.ts — the witness-join choke point (Git-Native WP-G1.7).
// MAIN-PROCESS ONLY.
//
// This is the `recordWitnessedActivity(agentId, path, op)` observer that
// `database.ts:addFileActivity` invokes at its TOP (before the 5-second live-cache
// dedupe early-return). It maps a raw witnessed file event onto the agent's OPEN
// turn and appends a normalized, repo-relative write/create path to that turn's
// `touched[]`, with the DB's own transactional `(turnId,path,op)` dedupe.
//
// It uses the coordinator's PULL seam (`currentWitnessTarget`) rather than a push
// WitnessRouter: the pull is authoritative (the target is derived from the open
// turn's own capability, so it can never drift from what the before-snapshot
// captured) and needs no separate active-turn bookkeeping. Every dependency is an
// injected seam so the whole thing is unit-testable with no real DB / coordinator.
//
// SAFETY (plan §0 invariant #6):
//   • accept ONLY `write`/`create` (a `read` is never recovery-relevant);
//   • normalize the absolute path against the canonical workspace
//     (`join(repoRoot, workspacePrefix)`) and REJECT anything out-of-scope or that
//     escapes via `..` traversal — a witnessed path outside the workspace is never
//     recorded;
//   • store the path REPO-RELATIVE (relative to `repoRoot`, POSIX separators) so it
//     lines up with the captured tree's pathspecs used by diff/restore.

import * as path from 'path';

import type { FileOperation } from '../../shared/types';

/** The open-turn pull target — the coordinator's `currentWitnessTarget` shape. */
export interface WitnessTarget {
  turnId: string;
  repoRoot: string;
  /** Repo-relative POSIX prefix of the canonical workspace ('' when workspace === repoRoot). */
  workspacePrefix: string;
}

export interface WitnessRecorderDeps {
  /** Pull the agent's current open-turn witness target (coordinator seam). */
  currentWitnessTarget: (agentId: string) => WitnessTarget | null;
  /** Transactional `(turnId,path,op)` append into the open turn's `touched[]`
   *  (defaults to database.ts `recordWitnessedActivity`). Returns true on a fresh
   *  append, false on a dedupe no-op / unknown turn. */
  record: (turnId: string, filePath: string, op: 'write' | 'create') => boolean;
}

/** Normalize an incoming witnessed path to a repo-relative POSIX path, or null if
 *  it is out-of-scope / traversal / not a real workspace path. Absolute inputs are
 *  resolved directly; a relative input is resolved against the workspace root
 *  (`join(repoRoot, workspacePrefix)`). */
export function normalizeWitnessPath(
  target: WitnessTarget,
  rawPath: string,
): string | null {
  rawPath = rawPath.trim();
  if (!rawPath) return null;
  const repoRoot = target.repoRoot;
  // WSL / POSIX-rooted paths captured on Windows can never be normalized against a
  // Windows repoRoot (a Windows git exe cannot operate on them) — reject rather
  // than mis-anchor. This mirrors the WSL guard in git-runtime.
  const repoIsWindows = /^[A-Za-z]:[\\/]/.test(repoRoot) || repoRoot.startsWith('\\\\');
  if (repoIsWindows && (rawPath.startsWith('/') && !/^[A-Za-z]:/.test(rawPath))) return null;

  const workspaceRoot = target.workspacePrefix
    ? path.resolve(repoRoot, target.workspacePrefix)
    : path.resolve(repoRoot);

  const abs = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);

  // In-scope check: the absolute path must live under the canonical workspace root.
  const relToWorkspace = path.relative(workspaceRoot, abs);
  if (relToWorkspace === '' || relToWorkspace.startsWith('..') || path.isAbsolute(relToWorkspace)) {
    return null; // out-of-workspace or traversal escape
  }

  // Stored form: repo-relative (aligned with the captured tree). Never absolute /
  // traversal after this — the in-scope check above already proved containment.
  const relToRepo = path.relative(repoRoot, abs);
  if (relToRepo === '' || relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) return null;
  return relToRepo.split(path.sep).join('/');
}

/**
 * The injectable witness observer. `observe(agentId, filePath, op)` is the exact
 * signature `addFileActivity` calls; bind it via `setWitnessObserver(recorder.observe)`.
 */
export class WitnessRecorder {
  private readonly deps: WitnessRecorderDeps;

  constructor(deps: WitnessRecorderDeps) {
    this.deps = deps;
  }

  observe = (agentId: string, filePath: string, op: FileOperation): void => {
    // Only writes/creates are recovery-relevant; a read never enters `touched[]`.
    if (op !== 'write' && op !== 'create') return;
    const target = this.deps.currentWitnessTarget(agentId);
    if (!target) return; // no open turn for this agent — nothing to attach to
    const rel = normalizeWitnessPath(target, filePath);
    if (rel === null) return; // out-of-scope / traversal — rejected
    this.deps.record(target.turnId, rel, op);
  };
}
