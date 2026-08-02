// Pure retention-pin quota policy. Git/DB/fs discovery and normal pruning stay
// in the retention executor; this module only selects otherwise-prunable edges.

import {
  RETENTION_PIN_MAX_EXTENSION_MS,
  RETENTION_PIN_QUOTA_BYTES,
} from '../../shared/constants';

export interface EdgePinCandidate {
  turnId: string;
  edge: 'before' | 'after';
  dirtyEntryIds: string[];
  normalPruneEligibleAt: number;
  estimatedBytes: number;
}

export interface EdgePinRef {
  turnId: string;
  edge: EdgePinCandidate['edge'];
}

export interface RetentionPinWeakeningWarning {
  quotaBytes: number;
  usedBytes: number;
  releasedEdges: EdgePinRef[];
  /** Dirty-entry identifiers are renderer-safe identities, never raw paths. */
  willWeakenPaths: string[];
}

export interface RetentionPinSelection {
  /** Edges whose complete estimated byte cost fits and whose extension is live. */
  retainedEdges: EdgePinCandidate[];
  /** Edges that must fall through to the executor's normal prune decision. */
  releasedEdges: EdgePinCandidate[];
  warning: RetentionPinWeakeningWarning | null;
}

/**
 * Select retention pins from edges that the normal retention policy could prune.
 *
 * The caller supplies `now`; this module deliberately has no clock or impure I/O.
 * Ordering is total and input-order independent. For the same turn and eligibility
 * time, AFTER is considered first so the recoverable end-state wins when only one
 * edge fits. Each edge is charged atomically: it is retained in full or not at all.
 */
export function selectRetentionPins(
  candidates: ReadonlyArray<EdgePinCandidate>,
  now: number,
): RetentionPinSelection {
  const ordered = [...candidates].sort(compareCandidates);
  const retainedEdges: EdgePinCandidate[] = [];
  const releasedEdges: EdgePinCandidate[] = [];
  let usedBytes = 0;

  for (const candidate of ordered) {
    const pinExpiresAt = candidate.normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS;
    const extensionExpired = now > pinExpiresAt;
    const fitsQuota = usedBytes + candidate.estimatedBytes <= RETENTION_PIN_QUOTA_BYTES;

    if (!extensionExpired && fitsQuota) {
      retainedEdges.push(candidate);
      usedBytes += candidate.estimatedBytes;
    } else {
      releasedEdges.push(candidate);
    }
  }

  const weakeningEdges = releasedEdges.filter((candidate) => candidate.dirtyEntryIds.length > 0);
  const warning = weakeningEdges.length === 0
    ? null
    : {
        quotaBytes: RETENTION_PIN_QUOTA_BYTES,
        usedBytes,
        releasedEdges: weakeningEdges.map(toEdgeRef),
        willWeakenPaths: sortedUnique(weakeningEdges.flatMap((candidate) => candidate.dirtyEntryIds)),
      };

  return { retainedEdges, releasedEdges, warning };
}

function compareCandidates(left: EdgePinCandidate, right: EdgePinCandidate): number {
  if (left.normalPruneEligibleAt !== right.normalPruneEligibleAt) {
    return left.normalPruneEligibleAt - right.normalPruneEligibleAt;
  }
  const turnOrder = compareStrings(left.turnId, right.turnId);
  if (turnOrder !== 0) return turnOrder;
  if (left.edge === right.edge) return 0;
  return left.edge === 'after' ? -1 : 1;
}

function toEdgeRef(candidate: EdgePinCandidate): EdgePinRef {
  return { turnId: candidate.turnId, edge: candidate.edge };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
