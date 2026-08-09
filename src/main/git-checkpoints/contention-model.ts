// WP-P7B — pre-dispatch path-contention advisories.
//
// `turn_records.touched` paths are already repository-relative (the witness
// recorder establishes that invariant). Planned package paths are different:
// P5A stores them workspace-relative. This module maps the latter through the
// workspace prefix, encodes both sides as Git path bytes, and compares them only
// inside one per-worktree repository identity.
//
// This is deliberately a pure projection. It does not dispatch, mutate package
// state, inspect hunks, or expose a blocking decision.

import * as path from 'node:path';

import type { EncodedGitPath } from '../../shared/commit-candidates';
import type { TurnRecord, TurnWitnessEntry } from '../database';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { recordIntentArchitectureEvent } from './intent-architecture-telemetry';

export const DEFAULT_CONTENTION_RECENT_WINDOW_MS = 30 * 60 * 1000;

export interface ContentionWorkspaceScope {
  workspaceId: string;
  /** Per-worktree identity. Linked worktrees must have distinct values. */
  repositoryKey: string;
  /** Repository-relative POSIX prefix; empty when workspace === repository root. */
  workspacePrefix: string;
}

export interface ContentionTurnEvidence {
  turnId: string;
  intentId: string | null;
  workspaceId: string;
  agentId: string | null;
  taskLabel: string | null;
  status: string;
  active: boolean;
  startedAt: number | null;
  endedAt: number | null;
}

export interface ContentionPathNode {
  repositoryKey: string;
  path: EncodedGitPath;
  turns: ContentionTurnEvidence[];
}

export interface PathContentionGraph {
  generatedAt: number;
  recentWindowMs: number;
  paths: ContentionPathNode[];
}

export interface PackagePlannedPath {
  path: string;
  intentKind?: string | null;
}

export interface ContentionOverlap {
  plannedPath: string;
  intentKind: string | null;
  repositoryKey: string;
  path: EncodedGitPath;
  turns: ContentionTurnEvidence[];
}

/** A warning payload, never an authorization or dispatch-gate result. */
export interface PackageContentionAdvisory {
  kind: 'path-contention';
  packageId: string;
  advisoryOnly: true;
  blocks: false;
  overlaps: ContentionOverlap[];
}

export interface BuildContentionGraphInput {
  turns: readonly TurnRecord[];
  workspaces: readonly ContentionWorkspaceScope[];
  now?: number;
  recentWindowMs?: number;
}

function normalizedRepoRelativePath(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\\')) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '' || normalized === '.' || normalized === '..'
      || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function normalizedWorkspacePrefix(raw: string): string | null {
  if (raw === '') return '';
  return normalizedRepoRelativePath(raw);
}

function pathKey(repositoryKey: string, pathBytesBase64: string): string {
  return `${repositoryKey}\0${pathBytesBase64}`;
}

function encodeRepoRelativePath(raw: string): EncodedGitPath | null {
  const normalized = normalizedRepoRelativePath(raw);
  return normalized === null ? null : encodeGitPath(Buffer.from(normalized, 'utf8'));
}

/** Map a P5A workspace-relative planned path into Git's repository-relative bytes. */
export function encodePlannedPath(
  workspace: ContentionWorkspaceScope,
  plannedPath: string,
): EncodedGitPath | null {
  const prefix = normalizedWorkspacePrefix(workspace.workspacePrefix);
  const relative = normalizedRepoRelativePath(plannedPath);
  if (prefix === null || relative === null) return null;
  return encodeRepoRelativePath(prefix === '' ? relative : path.posix.join(prefix, relative));
}

function turnIsInWindow(turn: TurnRecord, now: number, recentWindowMs: number): boolean {
  if (turn.status === 'open') return true;
  const lastActivityAt = turn.endedAt ?? turn.startedAt;
  return lastActivityAt !== null
    && lastActivityAt <= now
    && lastActivityAt >= now - recentWindowMs;
}

function evidence(turn: TurnRecord): ContentionTurnEvidence {
  return {
    turnId: turn.id,
    intentId: turn.intentId ?? null,
    workspaceId: turn.workspaceId,
    agentId: turn.agentId,
    taskLabel: turn.taskLabel,
    status: turn.status,
    active: turn.status === 'open',
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  };
}

function witnessedWritePaths(touched: readonly TurnWitnessEntry[] | null): string[] {
  return (touched ?? [])
    .filter((entry) => entry.op === 'write' || entry.op === 'create')
    .map((entry) => entry.path);
}

/** Build the rolling graph from active turns plus closed turns in the recent window. */
export function buildPathContentionGraph(input: BuildContentionGraphInput): PathContentionGraph {
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? DEFAULT_CONTENTION_RECENT_WINDOW_MS;
  if (!Number.isFinite(recentWindowMs) || recentWindowMs < 0) {
    throw new Error('recentWindowMs must be a finite non-negative number');
  }

  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const nodes = new Map<string, ContentionPathNode>();

  for (const turn of input.turns) {
    if (!turnIsInWindow(turn, now, recentWindowMs)) continue;
    const workspace = workspaceById.get(turn.workspaceId);
    if (!workspace || workspace.repositoryKey === '') continue;
    for (const touchedPath of witnessedWritePaths(turn.touched)) {
      // Witness paths are already repository-relative; never apply the workspace
      // prefix a second time.
      const encoded = encodeRepoRelativePath(touchedPath);
      if (!encoded) continue;
      const key = pathKey(workspace.repositoryKey, encoded.pathBytesBase64);
      const node = nodes.get(key) ?? {
        repositoryKey: workspace.repositoryKey,
        path: encoded,
        turns: [],
      };
      if (!node.turns.some((candidate) => candidate.turnId === turn.id)) {
        node.turns.push(evidence(turn));
      }
      nodes.set(key, node);
    }
  }

  return {
    generatedAt: now,
    recentWindowMs,
    paths: [...nodes.values()].sort((a, b) =>
      a.repositoryKey.localeCompare(b.repositoryKey)
      || a.path.pathBytesBase64.localeCompare(b.path.pathBytesBase64)),
  };
}

/**
 * Return an advisory only when at least one planned path overlaps the graph.
 * Invalid planned rows are ignored defensively; P5A rejects them at persistence.
 */
export function advisePackageContention(
  graph: PathContentionGraph,
  packageId: string,
  workspace: ContentionWorkspaceScope,
  plannedPaths: readonly PackagePlannedPath[],
): PackageContentionAdvisory | null {
  const nodes = new Map(graph.paths.map((node) => [
    pathKey(node.repositoryKey, node.path.pathBytesBase64),
    node,
  ]));
  const overlaps: ContentionOverlap[] = [];
  const seen = new Set<string>();

  for (const planned of plannedPaths) {
    const encoded = encodePlannedPath(workspace, planned.path);
    if (!encoded) continue;
    const key = pathKey(workspace.repositoryKey, encoded.pathBytesBase64);
    if (seen.has(key)) continue;
    const node = nodes.get(key);
    if (!node) continue;
    seen.add(key);
    overlaps.push({
      plannedPath: planned.path,
      intentKind: planned.intentKind ?? null,
      repositoryKey: workspace.repositoryKey,
      path: encoded,
      turns: node.turns.map((turn) => ({ ...turn })),
    });
  }

  if (overlaps.length === 0) return null;
  recordIntentArchitectureEvent('predicted', overlaps.length);
  return { kind: 'path-contention', packageId, advisoryOnly: true, blocks: false, overlaps };
}
