import type { DirtyEntry, DirtyInventory, ConflictComponent } from '../../shared/commit-candidates';
import type { SaveCardPinnedSelection, SelectionDrift } from '../../shared/types';
import type { PackageFinalization } from '../database';
import type { FrozenManifestMember } from './finalization-service';

export interface PinnedSelectionDriftResult {
  drift: SelectionDrift;
  displayPaths: Record<string, string>;
  pinnedSelection: SaveCardPinnedSelection;
  frozenEntries: DirtyEntry[];
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function parseFinalizationManifest(
  finalization: PackageFinalization,
): FrozenManifestMember[] {
  try {
    const parsed: unknown = JSON.parse(finalization.memberManifestJson);
    return Array.isArray(parsed) ? parsed as FrozenManifestMember[] : [];
  } catch {
    return [];
  }
}

function fallbackDisplayPath(pathBytesBase64: string): string {
  const decoded = Buffer.from(pathBytesBase64, 'base64').toString('utf8');
  return decoded.replace(/[\x00-\x1f\x7f]/g, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/** Resolve the exact frozen path set while independently comparing it with the
 * package main resolves today. This deliberately never expands candidate members
 * from today's package: additions are drift, not part of the pinned commit. */
export function resolvePinnedSelectionDrift(input: {
  repositoryKey: string;
  inventory: DirtyInventory;
  components: readonly ConflictComponent[];
  finalizations: readonly PackageFinalization[];
  requestedComponentIds: readonly string[];
  requestedUnattributedEntryIds: readonly string[];
}): PinnedSelectionDriftResult {
  const finalizations = input.finalizations.filter((row) =>
    row.repositoryKey === input.repositoryKey && row.lifecycleStatus === 'active');
  const entriesByPath = new Map(input.inventory.entries.map((entry) => [entry.path.pathBytesBase64, entry]));
  const entriesById = new Map(input.inventory.entries.map((entry) => [entry.entryId, entry]));
  const componentById = new Map(input.components.map((component) => [component.componentId, component]));
  const unattributedIds = new Set(input.inventory.unattributedEntryIds);
  const frozenByPath = new Map<string, FrozenManifestMember>();
  const currentPackageIds = new Set<string>();
  const expectedComponentIds = new Set<string>();
  let frozenWasUnattributed = false;

  for (const finalization of finalizations) {
    for (const member of parseFinalizationManifest(finalization)) {
      frozenByPath.set(member.pathBytesBase64, member);
    }
    if (finalization.packageId.startsWith('component:')) {
      const componentId = finalization.packageId.slice('component:'.length);
      expectedComponentIds.add(componentId);
      for (const id of componentById.get(componentId)?.dirtyEntryIds ?? []) currentPackageIds.add(id);
    } else if (finalization.packageId.startsWith('unattributed:')) {
      frozenWasUnattributed = true;
      for (const id of input.inventory.unattributedEntryIds) currentPackageIds.add(id);
    } else {
      for (const id of input.requestedUnattributedEntryIds) currentPackageIds.add(id);
      for (const componentId of input.requestedComponentIds) {
        expectedComponentIds.add(componentId);
        for (const id of componentById.get(componentId)?.dirtyEntryIds ?? []) currentPackageIds.add(id);
      }
    }
  }

  const missing: string[] = [];
  const byteMoved: string[] = [];
  const reAttributed: string[] = [];
  const frozenEntries: DirtyEntry[] = [];
  const displayPaths: Record<string, string> = {};

  for (const [pathBytesBase64, frozen] of frozenByPath) {
    const entry = entriesByPath.get(pathBytesBase64);
    displayPaths[pathBytesBase64] = entry?.path.displayPath ?? fallbackDisplayPath(pathBytesBase64);
    if (!entry) {
      missing.push(pathBytesBase64);
      continue;
    }
    frozenEntries.push(entry);
    if (entry.expectedWorktreeState !== frozen.expectedState || entry.rawWorktreeBlobOid !== frozen.rawBlobOid) {
      byteMoved.push(pathBytesBase64);
    }
    const expectedComponent = [...expectedComponentIds].find((componentId) =>
      componentById.get(componentId)?.dirtyEntryIds.includes(entry.entryId));
    if ((frozenWasUnattributed && !unattributedIds.has(entry.entryId))
      || (expectedComponentIds.size > 0 && !expectedComponent)) {
      reAttributed.push(pathBytesBase64);
    }
  }

  const added: string[] = [];
  for (const entryId of currentPackageIds) {
    const entry = entriesById.get(entryId);
    if (!entry || frozenByPath.has(entry.path.pathBytesBase64)) continue;
    added.push(entry.path.pathBytesBase64);
    displayPaths[entry.path.pathBytesBase64] = entry.path.displayPath;
  }

  frozenEntries.sort((left, right) => left.path.pathBytesBase64.localeCompare(right.path.pathBytesBase64));
  const componentIds = expectedComponentIds.size > 0
    ? sorted(expectedComponentIds)
    : sorted(input.requestedComponentIds);
  const frozenUnattributedIds = frozenWasUnattributed
    ? frozenEntries.map((entry) => entry.entryId)
    : input.requestedUnattributedEntryIds.filter((id) => {
        const entry = entriesById.get(id);
        return entry ? frozenByPath.has(entry.path.pathBytesBase64) : true;
      });

  return {
    drift: {
      added: sorted(added),
      missing: sorted(missing),
      reAttributed: sorted(reAttributed),
      byteMoved: sorted(byteMoved),
    },
    displayPaths,
    pinnedSelection: {
      selectedComponentIds: componentIds,
      selectedUnattributedEntryIds: sorted(frozenUnattributedIds),
      frozenMemberCount: frozenByPath.size,
    },
    frozenEntries,
  };
}

export function selectionDriftBlocks(drift: SelectionDrift): boolean {
  return drift.missing.length > 0 || drift.reAttributed.length > 0 || drift.byteMoved.length > 0;
}
