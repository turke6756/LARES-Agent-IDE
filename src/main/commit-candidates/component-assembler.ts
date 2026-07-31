import { createHash } from 'node:crypto';

import type {
  BundleAssociation,
  BundleOverlap,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
} from '../../shared/commit-candidates';
import type { DirtyInventoryDraft } from './dirty-inventory';
import { canonicalize } from './jcs';
import type { ProjectedWitness } from './witness-projection';

export interface ComponentAssembly {
  inventory: DirtyInventory;
  components: ConflictComponent[];
}

interface TopologyContributor {
  turnId: string;
  agentId: string | null;
  planId: string | null;
  planItemId: string | null;
}

interface TopologyEntry {
  pathBytesBase64: string;
  contributors: TopologyContributor[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareStrings(left, right);
}

function compareContributors(left: TopologyContributor, right: TopologyContributor): number {
  return compareStrings(left.turnId, right.turnId)
    || compareNullableStrings(left.agentId, right.agentId)
    || compareNullableStrings(left.planId, right.planId)
    || compareNullableStrings(left.planItemId, right.planItemId);
}

function contributorKey(contributor: TopologyContributor): string {
  return canonicalize(contributor);
}

function topologyEntries(
  entries: readonly DirtyEntry[],
  witnessesByEntry: ReadonlyMap<string, readonly ProjectedWitness[]>,
): TopologyEntry[] {
  return entries
    .map((entry): TopologyEntry => {
      const contributors = new Map<string, TopologyContributor>();
      for (const witness of witnessesByEntry.get(entry.entryId) ?? []) {
        const contributor: TopologyContributor = {
          turnId: witness.turnId,
          agentId: witness.agentId,
          planId: witness.planId,
          planItemId: witness.planItemId,
        };
        contributors.set(contributorKey(contributor), contributor);
      }
      return {
        pathBytesBase64: entry.path.pathBytesBase64,
        contributors: [...contributors.values()].sort(compareContributors),
      };
    })
    .sort((left, right) =>
      compareStrings(left.pathBytesBase64, right.pathBytesBase64)
      || compareStrings(canonicalize(left.contributors), canonicalize(right.contributors)),
    );
}

function topologyDigest(
  repositoryKey: string,
  entries: readonly DirtyEntry[],
  witnessesByEntry: ReadonlyMap<string, readonly ProjectedWitness[]>,
): string {
  return sha256(canonicalize({
    repositoryKey,
    entries: topologyEntries(entries, witnessesByEntry),
  }));
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error(`Unknown disjoint-set member: ${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareStrings);
    this.parent.set(second, first);
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function associationsFor(
  entryIds: readonly string[],
  witnessesByEntry: ReadonlyMap<string, readonly ProjectedWitness[]>,
): BundleAssociation[] {
  const groups = new Map<string, {
    planId: string | null;
    planItemId: string | null;
    turnIds: Set<string>;
    entryIds: Set<string>;
  }>();

  for (const entryId of entryIds) {
    for (const witness of witnessesByEntry.get(entryId) ?? []) {
      const key = canonicalize([witness.planId, witness.planItemId]);
      let group = groups.get(key);
      if (!group) {
        group = {
          planId: witness.planId,
          planItemId: witness.planItemId,
          turnIds: new Set(),
          entryIds: new Set(),
        };
        groups.set(key, group);
      }
      group.turnIds.add(witness.turnId);
      group.entryIds.add(entryId);
    }
  }

  return [...groups.values()]
    .map((group): BundleAssociation => ({
      planId: group.planId,
      planItemId: group.planItemId,
      contributingTurnIds: sortedUnique(group.turnIds),
      memberEntryIds: sortedUnique(group.entryIds),
    }))
    .sort((left, right) =>
      compareNullableStrings(left.planId, right.planId)
      || compareNullableStrings(left.planItemId, right.planItemId),
    );
}

function overlapFor(
  componentId: string,
  entryIds: readonly string[],
  witnessesByEntry: ReadonlyMap<string, readonly ProjectedWitness[]>,
): BundleOverlap {
  const agentIds = new Set<string>();
  const ownershipPlanGroups = new Set<string>();
  const perPathContributors: BundleOverlap['perPathContributors'] = {};

  for (const entryId of entryIds) {
    const turnIds = new Set<string>();
    const pathAgentIds = new Set<string>();
    const planIds = new Set<string | null>();

    for (const witness of witnessesByEntry.get(entryId) ?? []) {
      turnIds.add(witness.turnId);
      if (witness.agentId !== null) {
        agentIds.add(witness.agentId);
        pathAgentIds.add(witness.agentId);
      }
      planIds.add(witness.planId);

      // Workers launched by one owner remain one ownership unit. Unowned turns
      // fall back to their own agent identity (or one explicit owner-less unit).
      const ownerId = witness.ownerAgentId ?? witness.agentId;
      ownershipPlanGroups.add(canonicalize([
        ownerId,
        witness.planId,
        witness.planItemId,
      ]));
    }

    perPathContributors[entryId] = {
      turnIds: sortedUnique(turnIds),
      agentIds: sortedUnique(pathAgentIds),
      planIds: [...planIds].sort(compareNullableStrings),
    };
  }

  const mergedGroupCount = ownershipPlanGroups.size;
  return {
    componentId,
    contributingAgentCount: agentIds.size,
    mergedGroupCount,
    perPathContributors,
    requiresOverlapAck: mergedGroupCount >= 2,
  };
}

/**
 * Assemble the contract-v1 witnessed component graph without performing I/O.
 *
 * Only inventory entry IDs are accepted as graph vertices. Stale witness rows
 * for entries no longer dirty are ignored. Entries with no valid witness stay
 * outside all components and are emitted as independent unattributed atoms.
 */
export function assembleConflictComponents(
  draft: DirtyInventoryDraft,
  witnesses: readonly ProjectedWitness[],
): ComponentAssembly {
  const entries = [...draft.entries].sort((left, right) =>
    compareStrings(left.path.pathBytesBase64, right.path.pathBytesBase64)
    || compareStrings(left.entryId, right.entryId),
  );
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
  const witnessesByEntry = new Map<string, ProjectedWitness[]>();

  for (const witness of witnesses) {
    if (!entriesById.has(witness.entryId)) continue;
    const entryWitnesses = witnessesByEntry.get(witness.entryId);
    if (entryWitnesses) entryWitnesses.push(witness);
    else witnessesByEntry.set(witness.entryId, [witness]);
  }

  const disjointSet = new DisjointSet();
  const firstEntryByTurn = new Map<string, string>();
  const firstEntryByAgent = new Map<string, string>();

  for (const [entryId, entryWitnesses] of witnessesByEntry) {
    disjointSet.add(entryId);
    for (const witness of entryWitnesses) {
      const turnEntry = firstEntryByTurn.get(witness.turnId);
      if (turnEntry) disjointSet.union(entryId, turnEntry);
      else firstEntryByTurn.set(witness.turnId, entryId);

      // A missing agent identity must not collapse every owner-less/human turn
      // into one component; the shared-turn/shared-path edges still apply.
      if (witness.agentId !== null) {
        const agentEntry = firstEntryByAgent.get(witness.agentId);
        if (agentEntry) disjointSet.union(entryId, agentEntry);
        else firstEntryByAgent.set(witness.agentId, entryId);
      }
    }
  }

  const entryIdsByRoot = new Map<string, string[]>();
  for (const entryId of witnessesByEntry.keys()) {
    const root = disjointSet.find(entryId);
    const componentEntries = entryIdsByRoot.get(root);
    if (componentEntries) componentEntries.push(entryId);
    else entryIdsByRoot.set(root, [entryId]);
  }

  const components = [...entryIdsByRoot.values()]
    .map((entryIds): ConflictComponent => {
      const dirtyEntryIds = sortedUnique(entryIds);
      const componentEntries = dirtyEntryIds.map((entryId) => entriesById.get(entryId)!);
      const componentId = sha256(draft.repository.repositoryKey + dirtyEntryIds.join(''));
      return {
        componentId,
        dirtyEntryIds,
        associations: associationsFor(dirtyEntryIds, witnessesByEntry),
        overlap: overlapFor(componentId, dirtyEntryIds, witnessesByEntry),
        componentTopologyDigest: topologyDigest(
          draft.repository.repositoryKey,
          componentEntries,
          witnessesByEntry,
        ),
      };
    })
    .sort((left, right) => compareStrings(left.componentId, right.componentId));

  const unattributedEntryIds = entries
    .filter((entry) => !witnessesByEntry.has(entry.entryId))
    .map((entry) => entry.entryId)
    .sort(compareStrings);

  return {
    inventory: {
      repository: draft.repository,
      entries,
      unattributedEntryIds,
      topologyDigest: topologyDigest(draft.repository.repositoryKey, entries, witnessesByEntry),
    },
    components,
  };
}
