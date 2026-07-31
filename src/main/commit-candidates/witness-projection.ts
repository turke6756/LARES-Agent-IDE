// SC-WP-1W — pure turn-witness projection (bundle contract v1 §§2–3).
//
// `turn_records.touched[].path` is workspace-relative POSIX text, while Git
// inventory paths are repository-root-relative bytes. Each touched path is
// therefore prefixed with the witnessing workspace's `workspacePrefix` before
// matching. Git bytes remain authoritative: only a losslessly UTF-8 path may
// participate in this string-valued join. Display paths are never join keys.
//
// Stage ① passes `stampSource = null`, yielding honest null plan associations.
// Stage ② can inject its immutable stamp reader without changing this projection.
// The database module is imported for types only; all reads are injected.

import type { DirtyEntry, RepositoryIdentity } from '../../shared/commit-candidates';
import type { TurnWitnessRead } from '../database';

/** Synchronous reader shaped like WP-1A's `getTurnWitnessReads`. */
export type TurnWitnessReader = (workspaceId: string) => readonly TurnWitnessRead[];

/** Frozen association fields supplied by the Stage ② stamp accessor. */
export interface WitnessAssociationStamp {
  planId: string | null;
  planItemId: string | null;
}

/**
 * Optional immutable stamp lookup. `null` is the explicit Stage ① source and
 * must never be replaced with a live agent-default lookup.
 */
export type WitnessStampSource = (
  workspaceId: string,
  turnId: string,
) => WitnessAssociationStamp | null;

/** One repository entry ↔ witnessing turn edge for the component assembler. */
export interface ProjectedWitness {
  entryId: string;
  workspaceId: string;
  turnId: string;
  agentId: string | null;
  ownerAgentId: string | null;
  ownerBrickGeneration: number | null;
  planId: string | null;
  planItemId: string | null;
}

function repositoryPath(workspacePrefix: string, touchedPath: string): string {
  return workspacePrefix === '' ? touchedPath : `${workspacePrefix}/${touchedPath}`;
}

/**
 * Decode an authoritative Git path only when it is demonstrably lossless UTF-8.
 * The round-trip check is deliberately retained even though `utf8Clean` was set
 * upstream, so an inconsistent/injected inventory cannot force a lossy match.
 */
function matchableGitPath(entry: DirtyEntry): string | null {
  if (!entry.path.utf8Clean) return null;
  const bytes = Buffer.from(entry.path.pathBytesBase64, 'base64');
  const decoded = bytes.toString('utf8');
  return Buffer.compare(Buffer.from(decoded, 'utf8'), bytes) === 0 ? decoded : null;
}

/**
 * Project all witnessed write/create reads in a repository onto its dirty
 * entries. The WP-1A reader already filters `touched` to write/create operations.
 *
 * Output order is deterministic for canonical `repository.workspaces` and the
 * reader's turn order. Repeated touches by one turn produce only one edge.
 */
export function projectWitnesses(
  repository: RepositoryIdentity,
  entries: readonly DirtyEntry[],
  readTurnWitnesses: TurnWitnessReader,
  stampSource: WitnessStampSource | null = null,
): ProjectedWitness[] {
  const entryIdsByPath = new Map<string, string[]>();
  for (const entry of entries) {
    const path = matchableGitPath(entry);
    if (path === null) continue;
    const ids = entryIdsByPath.get(path);
    if (ids) ids.push(entry.entryId);
    else entryIdsByPath.set(path, [entry.entryId]);
  }

  const projected: ProjectedWitness[] = [];
  for (const workspace of repository.workspaces) {
    for (const turn of readTurnWitnesses(workspace.workspaceId)) {
      const stamp = stampSource?.(workspace.workspaceId, turn.turnId) ?? null;
      const matchedEntryIds = new Set<string>();

      for (const touched of turn.touched) {
        const path = repositoryPath(workspace.workspacePrefix, touched.path);
        for (const entryId of entryIdsByPath.get(path) ?? []) {
          matchedEntryIds.add(entryId);
        }
      }

      for (const entryId of matchedEntryIds) {
        projected.push({
          entryId,
          workspaceId: workspace.workspaceId,
          turnId: turn.turnId,
          agentId: turn.agentId,
          ownerAgentId: turn.ownerAgentId,
          ownerBrickGeneration: turn.ownerBrickGeneration,
          planId: stamp?.planId ?? null,
          planItemId: stamp?.planItemId ?? null,
        });
      }
    }
  }
  return projected;
}
