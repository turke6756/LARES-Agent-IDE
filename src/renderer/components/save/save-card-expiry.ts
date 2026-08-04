// SC-WP-N2 — pure helpers for the Save pane's checkpoint-expiry block.
//
// The retention pass emits a `SaveCardCheckpointExpiryNotice` whose edges carry
// `affectedEntryIds` (renderer-safe dirty-entry identities). The Save pane already
// renders WorkBundle cards; this module maps expiring edges onto those bundles by
// intersecting each edge's `affectedEntryIds` with the bundle's member entry ids,
// so an "expiring soon" warning lands on the exact card that holds the work.

import type { SaveCardCheckpointExpiryNotice } from '../../../shared/types';
import type { WorkBundleDto } from './SaveBundle';

export type ExpiryEdge = SaveCardCheckpointExpiryNotice['edges'][number];

export interface BundleExpiry {
  bundle: WorkBundleDto;
  /** The notice edges whose `affectedEntryIds` intersect this bundle's members,
   *  soonest-expiring first. */
  edges: ExpiryEdge[];
  /** The soonest `expiresAt` across this bundle's edges (its overall deadline). */
  earliestExpiresAt: number;
}

/** The set of dirty-entry ids a bundle holds (its member entries). */
export function bundleEntryIds(bundle: WorkBundleDto): Set<string> {
  return new Set(bundle.members.map((member) => member.entry.entryId));
}

/**
 * Group a notice's expiring edges onto the given bundles. An edge attaches to a
 * bundle when at least one of its `affectedEntryIds` is a member of that bundle.
 * One edge can touch several bundles (its entries may span cards); a bundle with
 * no intersecting edge is omitted. Result is ordered by soonest bundle deadline,
 * then by bundle id, so the block is deterministic. A null notice ⇒ [].
 */
export function groupExpiryEdgesByBundle(
  notice: SaveCardCheckpointExpiryNotice | null | undefined,
  bundles: readonly WorkBundleDto[],
): BundleExpiry[] {
  if (!notice || notice.edges.length === 0) return [];
  const grouped: BundleExpiry[] = [];
  for (const bundle of bundles) {
    const memberIds = bundleEntryIds(bundle);
    if (memberIds.size === 0) continue;
    const edges = notice.edges
      .filter((edge) => edge.affectedEntryIds.some((id) => memberIds.has(id)))
      .sort((a, b) => a.expiresAt - b.expiresAt);
    if (edges.length === 0) continue;
    grouped.push({ bundle, edges, earliestExpiresAt: edges[0].expiresAt });
  }
  return grouped.sort((a, b) =>
    a.earliestExpiresAt !== b.earliestExpiresAt
      ? a.earliestExpiresAt - b.earliestExpiresAt
      : a.bundle.bundleId < b.bundle.bundleId
        ? -1
        : a.bundle.bundleId > b.bundle.bundleId
          ? 1
          : 0,
  );
}

/** SC-WP-N2 — a compact human string for "expires in N". Rounds up to the coarsest
 *  useful unit; never negative (an already-past deadline reads "now"). */
export function formatExpiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'now';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return 'under an hour';
  if (hours < 24) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
