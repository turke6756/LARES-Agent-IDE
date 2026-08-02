// SC-WP-1G — renderer-safe WorkBundle projection.
//
// This module is intentionally a projector, not an assembler. Component
// boundaries and unattributed membership arrive fully formed from WP-1D. The
// projector only attaches display labels, capture health, and protection state.

import type {
  BundleCaptureHealth,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  ProtectionRung,
} from '../../shared/commit-candidates';
import type { SaveCardBundleIdentity } from '../../shared/types';
import { weakestProtectionRung } from './protection-read';

export interface WorkBundleMember {
  entry: DirtyEntry;
  protection: ProtectionRung;
}

export interface WorkBundle {
  bundleId: string;
  kind: 'component' | 'unattributed';
  label: string;
  labels: string[];
  repositoryKey: string;
  workspaces: Array<{ workspaceId: string; workspacePrefix: string }>;
  component: ConflictComponent | null;
  members: WorkBundleMember[];
  captureHealth: BundleCaptureHealth;
  weakestProtection: ProtectionRung | null;
  /** Populated from the app DB by save-card-routes; null in the pure projector. */
  identity: SaveCardBundleIdentity | null;
}

export interface WorkBundleProjectionInput {
  inventory: DirtyInventory;
  components: readonly ConflictComponent[];
  captureHealthByComponentId: Readonly<Record<string, BundleCaptureHealth>>;
  unattributedCaptureHealth: BundleCaptureHealth;
  protectionByEntryId: Readonly<Record<string, ProtectionRung>>;
  planAttributionUnavailableTurnIds?: ReadonlySet<string>;
}

function componentLabels(
  component: ConflictComponent,
  unavailableTurnIds: ReadonlySet<string>,
): string[] {
  const planIds = [...new Set(
    component.associations
      .map((association) => association.planId)
      .filter((planId): planId is string => planId !== null),
  )].sort();
  const labels: string[] = [];
  if (planIds.length === 1) labels.push(`Plan ${planIds[0]}`);
  else if (planIds.length > 1) labels.push(`${planIds.length} plans`);
  if (component.associations.some((association) =>
    association.contributingTurnIds.some((turnId) => unavailableTurnIds.has(turnId)))) {
    labels.push('Plan attribution unavailable — legacy-unstamped');
  }
  if (component.overlap.requiresOverlapAck) labels.push('Overlapping work');
  return labels;
}

function membersFor(
  entryIds: readonly string[],
  entriesById: ReadonlyMap<string, DirtyEntry>,
  protectionByEntryId: Readonly<Record<string, ProtectionRung>>,
): WorkBundleMember[] {
  return entryIds.map((entryId) => {
    const entry = entriesById.get(entryId);
    if (!entry) {
      throw new Error(`bundle references unknown dirty entry: ${entryId}`);
    }
    return {
      entry,
      protection: protectionByEntryId[entryId] ?? 'unprotected',
    };
  });
}

function weakest(members: readonly WorkBundleMember[]): ProtectionRung | null {
  return members.length === 0
    ? null
    : weakestProtectionRung(members.map((member) => member.protection));
}

/**
 * Project canonical inventory/components into renderer DTOs.
 *
 * D-1/D-5 discipline: component membership is copied verbatim; unattributed
 * entry IDs are copied verbatim into one display-only pseudo-bundle. No witness
 * joins, connected-component pass, or inferred grouping occurs here.
 */
export function projectWorkBundles(input: WorkBundleProjectionInput): WorkBundle[] {
  const entriesById = new Map(
    input.inventory.entries.map((entry) => [entry.entryId, entry]),
  );
  const workspaces = input.inventory.repository.workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    workspacePrefix: workspace.workspacePrefix,
  }));

  const bundles = input.components.map((component): WorkBundle => {
    const members = membersFor(
      component.dirtyEntryIds,
      entriesById,
      input.protectionByEntryId,
    );
    const labels = componentLabels(
      component,
      input.planAttributionUnavailableTurnIds ?? new Set<string>(),
    );
    return {
      bundleId: `component:${component.componentId}`,
      kind: 'component',
      // Identity is deliberately not guessed here. The production adapter owns
      // the agents-table join and replaces this neutral fallback before IPC.
      label: 'Work package',
      labels,
      repositoryKey: input.inventory.repository.repositoryKey,
      workspaces,
      component,
      members,
      captureHealth: input.captureHealthByComponentId[component.componentId] ?? {
        turns: [],
        captureOutage: false,
        pathsWithoutFinalizationEdge: members.map(
          (member) => member.entry.path.pathBytesBase64,
        ),
      },
      weakestProtection: weakest(members),
      identity: null,
    };
  });

  const unattributedMembers = membersFor(
    input.inventory.unattributedEntryIds,
    entriesById,
    input.protectionByEntryId,
  );
  bundles.push({
    bundleId: `unattributed:${input.inventory.repository.repositoryKey}`,
    kind: 'unattributed',
    label: 'Unattributed changes',
    labels: [
      'Unattributed changes',
    ],
    repositoryKey: input.inventory.repository.repositoryKey,
    workspaces,
    component: null,
    members: unattributedMembers,
    captureHealth: input.unattributedCaptureHealth,
    weakestProtection: weakest(unattributedMembers),
    identity: null,
  });

  return bundles;
}
