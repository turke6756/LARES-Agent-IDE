import type { BundleCaptureHealth, DirtyInventory, ProtectionRung } from '../../shared/commit-candidates';
import type { SaveIntent } from '../database';
import type { ComponentAssembly } from './component-assembler';
import type { ProjectedWitness } from './witness-projection';

export interface NamedSaveSetMember {
  intentId: string;
  entryId: string;
  pathBytesBase64: string;
  inventoryDigest: string;
}

export interface IntentConcurrencyEvidence {
  pathsWithMultipleIntents: string[];
}

export interface SaveIntentUnit {
  intent: SaveIntent;
  memberEntryIds: string[];
  contributingTurnIds: string[];
  contributingAgentIds: string[];
  topologyComponentIds: string[];
  concurrency: IntentConcurrencyEvidence;
  captureHealth: BundleCaptureHealth;
  weakestProtection: ProtectionRung | null;
}

export interface IntentAssemblyInput {
  inventory: DirtyInventory;
  witnesses: ProjectedWitness[];
  intents: SaveIntent[];
  namedMembers: NamedSaveSetMember[];
  topology: ComponentAssembly;
}

export interface IntentAssembly {
  intentUnits: SaveIntentUnit[];
  unwitnessedEntryIds: string[];
  legacyTaskIdentityUnavailableEntryIds: string[];
  staleNamedSaveSetIds: string[];
}

const emptyHealth = (): BundleCaptureHealth => ({
  turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [],
});

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Pure intent projector: immutable witness and byte-addressed named membership
 * define units. Component connectivity contributes evidence links only. */
export function projectIntentUnits(input: IntentAssemblyInput): IntentAssembly {
  const entries = new Map(input.inventory.entries.map((entry) => [entry.entryId, entry]));
  const witnessesByEntry = new Map<string, ProjectedWitness[]>();
  for (const witness of input.witnesses) {
    if (!entries.has(witness.entryId)) continue;
    const list = witnessesByEntry.get(witness.entryId) ?? [];
    list.push(witness);
    witnessesByEntry.set(witness.entryId, list);
  }
  const componentsByEntry = new Map<string, string[]>();
  for (const component of input.topology.components) {
    for (const entryId of component.dirtyEntryIds) {
      const list = componentsByEntry.get(entryId) ?? [];
      list.push(component.componentId);
      componentsByEntry.set(entryId, list);
    }
  }

  const namedByIntent = new Map<string, string[]>();
  const namedMemberEntryIds = new Set<string>();
  const staleNamedSaveSetIds = new Set<string>();
  for (const member of input.namedMembers) {
    const entry = entries.get(member.entryId);
    if (member.inventoryDigest !== input.inventory.topologyDigest
      || !entry || entry.path.pathBytesBase64 !== member.pathBytesBase64) {
      staleNamedSaveSetIds.add(member.intentId);
      continue;
    }
    const list = namedByIntent.get(member.intentId) ?? [];
    list.push(member.entryId);
    namedByIntent.set(member.intentId, list);
    namedMemberEntryIds.add(member.entryId);
  }

  const intentUnits = input.intents.map((intent): SaveIntentUnit => {
    const intentWitnesses = input.witnesses.filter((witness) => witness.intentId === intent.id);
    const memberEntryIds = uniqueSorted([
      ...intentWitnesses.map((witness) => witness.entryId),
      ...(namedByIntent.get(intent.id) ?? []),
    ]);
    return {
      intent,
      memberEntryIds,
      contributingTurnIds: uniqueSorted(intentWitnesses.map((witness) => witness.turnId)),
      contributingAgentIds: uniqueSorted(intentWitnesses.flatMap((witness) =>
        witness.agentId === null ? [] : [witness.agentId])),
      topologyComponentIds: uniqueSorted(memberEntryIds.flatMap((entryId) =>
        componentsByEntry.get(entryId) ?? [])),
      concurrency: {
        pathsWithMultipleIntents: memberEntryIds.filter((entryId) => new Set(
          (witnessesByEntry.get(entryId) ?? []).flatMap((witness) =>
            witness.intentId === null ? [] : [witness.intentId]),
        ).size > 1),
      },
      captureHealth: emptyHealth(),
      weakestProtection: null,
    };
  }).filter((unit) => unit.memberEntryIds.length > 0 || staleNamedSaveSetIds.has(unit.intent.id))
    .sort((left, right) => left.intent.id.localeCompare(right.intent.id));

  const unwitnessedEntryIds: string[] = [];
  const legacyTaskIdentityUnavailableEntryIds: string[] = [];
  for (const entry of input.inventory.entries) {
    const witnesses = witnessesByEntry.get(entry.entryId) ?? [];
    if (witnesses.length === 0 && !namedMemberEntryIds.has(entry.entryId)) {
      unwitnessedEntryIds.push(entry.entryId);
    }
    else if (witnesses.every((witness) => witness.intentId === null)) {
      legacyTaskIdentityUnavailableEntryIds.push(entry.entryId);
    }
  }
  return {
    intentUnits,
    unwitnessedEntryIds: uniqueSorted(unwitnessedEntryIds),
    legacyTaskIdentityUnavailableEntryIds: uniqueSorted(legacyTaskIdentityUnavailableEntryIds),
    staleNamedSaveSetIds: uniqueSorted(staleNamedSaveSetIds),
  };
}
