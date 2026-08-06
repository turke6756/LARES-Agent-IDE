import { createHash } from 'node:crypto';

import type {
  AttributionContributor,
  BundleAssociation,
  BundleOverlap,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  ReviewChallengeAtom,
  ReviewedAttributionTopology,
} from '../../shared/commit-candidates';
import type { DirtyInventoryDraft } from './dirty-inventory';
import { canonicalize } from './jcs';
import type { ProjectedWitness } from './witness-projection';

export interface ComponentAssembly {
  inventory: DirtyInventory;
  components: ConflictComponent[];
  selectedTopology: ReviewedAttributionTopology;
  ownershipGroupKeys: string[];
  overlapChallengeAtoms: ReviewChallengeAtom[];
}

interface TopologyContributor {
  turnId: string;
  agentId: string | null;
  ownerAgentId: string | null;
  planId: string | null;
  planItemId: string | null;
}

interface TopologyEntry {
  entryId: string;
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
    || compareNullableStrings(left.ownerAgentId, right.ownerAgentId)
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
          ownerAgentId: witness.ownerAgentId,
          planId: witness.planId,
          planItemId: witness.planItemId,
        };
        contributors.set(contributorKey(contributor), contributor);
      }
      return {
        entryId: entry.entryId,
        pathBytesBase64: entry.path.pathBytesBase64,
        contributors: [...contributors.values()].sort(compareContributors),
      };
    })
    .sort((left, right) =>
      compareStrings(left.pathBytesBase64, right.pathBytesBase64)
      || compareStrings(canonicalize(left.contributors), canonicalize(right.contributors)),
    );
}

function topologyDigestForEntries(
  repositoryKey: string,
  entries: readonly TopologyEntry[],
): string {
  return sha256(canonicalize({
    repositoryKey,
    entries: entries.map(({ pathBytesBase64, contributors }) => ({
      pathBytesBase64,
      contributors,
    })),
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
  entries: readonly TopologyEntry[],
  ownershipGroupKeys: readonly string[],
): BundleOverlap {
  const agentIds = new Set<string>();
  const perPathContributors: BundleOverlap['perPathContributors'] = {};

  for (const entry of entries) {
    const turnIds = new Set<string>();
    const pathAgentIds = new Set<string>();
    const planIds = new Set<string | null>();

    for (const contributor of entry.contributors) {
      turnIds.add(contributor.turnId);
      if (contributor.agentId !== null) {
        agentIds.add(contributor.agentId);
        pathAgentIds.add(contributor.agentId);
      }
      planIds.add(contributor.planId);

    }

    perPathContributors[entry.entryId] = {
      turnIds: sortedUnique(turnIds),
      agentIds: sortedUnique(pathAgentIds),
      planIds: [...planIds].sort(compareNullableStrings),
    };
  }

  const mergedGroupCount = ownershipGroupKeys.length;
  return {
    componentId,
    contributingAgentCount: agentIds.size,
    mergedGroupCount,
    perPathContributors,
    requiresOverlapAck: mergedGroupCount >= 2,
  };
}

function ownershipGroupKeysFor(entries: readonly TopologyEntry[]): string[] {
  // Workers launched by one owner remain one ownership unit. Unowned turns
  // fall back to their own agent identity (or one explicit owner-less unit).
  return sortedUnique(entries.flatMap((entry) => entry.contributors.map((contributor) =>
    canonicalize([
      contributor.ownerAgentId ?? contributor.agentId,
      contributor.planId,
      contributor.planItemId,
    ]),
  )));
}

function reviewedContributorsFor(entries: readonly TopologyEntry[]): AttributionContributor[] {
  return entries.flatMap((entry) => entry.contributors
    // A witness without an agent identity still participates in the existing
    // owner-less overlap group, but cannot satisfy AttributionContributor's
    // explicit agent identity contract.
    .filter((contributor): contributor is TopologyContributor & { agentId: string } =>
      contributor.agentId !== null)
    .map((contributor): AttributionContributor => ({
      pathBytesBase64: entry.pathBytesBase64,
      turnId: contributor.turnId,
      agentId: contributor.agentId,
      ownerAgentId: contributor.ownerAgentId,
      planId: contributor.planId,
      planItemId: contributor.planItemId,
    })));
}

function componentEdgesFor(entries: readonly TopologyEntry[]): ReviewedAttributionTopology['componentEdges'] {
  const edges: ReviewedAttributionTopology['componentEdges'] = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      const connected = left.contributors.some((leftContributor) =>
        right.contributors.some((rightContributor) =>
          leftContributor.turnId === rightContributor.turnId
          || (leftContributor.agentId !== null && leftContributor.agentId === rightContributor.agentId),
        ));
      if (connected) {
        const [leftPathBytesBase64, rightPathBytesBase64] = [
          left.pathBytesBase64,
          right.pathBytesBase64,
        ].sort(compareStrings);
        edges.push({ leftPathBytesBase64, rightPathBytesBase64 });
      }
    }
  }
  return edges.sort((left, right) =>
    compareStrings(left.leftPathBytesBase64, right.leftPathBytesBase64)
    || compareStrings(left.rightPathBytesBase64, right.rightPathBytesBase64));
}

function overlapChallengeAtomFor(
  entries: readonly TopologyEntry[],
  ownershipGroupKeys: readonly string[],
): ReviewChallengeAtom {
  const memberPathBytesBase64 = sortedUnique(entries.map((entry) => entry.pathBytesBase64));
  const contributors = reviewedContributorsFor(entries);
  const atomBody = {
    reasonVersion: 1 as const,
    memberPathBytesBase64,
    contributors,
    ownershipGroupKeys: [...ownershipGroupKeys],
  };
  return {
    kind: 'overlap',
    atomId: `overlap:${sha256(canonicalize(memberPathBytesBase64))}`,
    digest: sha256(canonicalize(atomBody)),
    ...atomBody,
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

  const allTopologyEntries = topologyEntries(entries, witnessesByEntry);
  const topologyByEntryId = new Map(allTopologyEntries.map((entry) => [entry.entryId, entry]));
  const topologyEntriesByComponentId = new Map<string, TopologyEntry[]>();
  const ownershipGroupKeysByComponentId = new Map<string, string[]>();
  const components = [...entryIdsByRoot.values()]
    .map((entryIds): ConflictComponent => {
      const dirtyEntryIds = sortedUnique(entryIds);
      const componentTopologyEntries = dirtyEntryIds.map((entryId) => topologyByEntryId.get(entryId)!);
      const componentId = sha256(draft.repository.repositoryKey + dirtyEntryIds.join(''));
      const componentOwnershipGroupKeys = ownershipGroupKeysFor(componentTopologyEntries);
      topologyEntriesByComponentId.set(componentId, componentTopologyEntries);
      ownershipGroupKeysByComponentId.set(componentId, componentOwnershipGroupKeys);
      return {
        componentId,
        dirtyEntryIds,
        associations: associationsFor(dirtyEntryIds, witnessesByEntry),
        overlap: overlapFor(componentId, componentTopologyEntries, componentOwnershipGroupKeys),
        componentTopologyDigest: topologyDigestForEntries(
          draft.repository.repositoryKey,
          componentTopologyEntries,
        ),
      };
    })
    .sort((left, right) => compareStrings(left.componentId, right.componentId));

  const unattributedEntryIds = entries
    .filter((entry) => !witnessesByEntry.has(entry.entryId))
    .map((entry) => entry.entryId)
    .sort(compareStrings);

  const selectedUnattributedPathBytesBase64 = sortedUnique(unattributedEntryIds.map(
    (entryId) => entriesById.get(entryId)!.path.pathBytesBase64,
  ));
  const componentTopologyEntries = components.map(
    (component) => topologyEntriesByComponentId.get(component.componentId)!,
  );
  const ownershipGroupKeys = sortedUnique(components.flatMap(
    (component) => ownershipGroupKeysByComponentId.get(component.componentId)!,
  ));
  const overlapChallengeAtoms = components
    .filter((component) => component.overlap.requiresOverlapAck)
    .map((component) => {
      const topology = topologyEntriesByComponentId.get(component.componentId)!;
      return overlapChallengeAtomFor(
        topology,
        ownershipGroupKeysByComponentId.get(component.componentId)!,
      );
    })
    .sort((left, right) => compareStrings(left.atomId, right.atomId));
  const selectedTopology: ReviewedAttributionTopology = {
    componentPathSets: componentTopologyEntries.map((componentEntries) =>
      sortedUnique(componentEntries.map((entry) => entry.pathBytesBase64))),
    contributors: componentTopologyEntries.flatMap(reviewedContributorsFor),
    ownershipGroupKeys,
    componentEdges: componentTopologyEntries.flatMap(componentEdgesFor),
    requiresOverlapAck: overlapChallengeAtoms.length > 0,
    selectedUnattributedPathBytesBase64,
  };

  return {
    inventory: {
      repository: draft.repository,
      entries,
      unattributedEntryIds,
      topologyDigest: topologyDigestForEntries(draft.repository.repositoryKey, allTopologyEntries),
    },
    components,
    selectedTopology,
    ownershipGroupKeys,
    overlapChallengeAtoms,
  };
}
