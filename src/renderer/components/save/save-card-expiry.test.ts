import { describe, expect, it } from 'vitest';

import type { DirtyEntry } from '../../../shared/commit-candidates';
import type { SaveCardCheckpointExpiryNotice, SaveIntentUnitDto } from '../../../shared/types';
import {
  formatExpiresIn,
  groupExpiryEdgesByIntentUnit,
  intentUnitEntryIds,
} from './save-card-expiry';

function unit(intentId: string, entryIds: string[]): SaveIntentUnitDto {
  return {
    intentId,
    kind: 'task',
    title: `Intent ${intentId}`,
    state: 'open',
    plan: null,
    planItem: null,
    members: entryIds.map((entryId) => ({
      entry: { entryId } as DirtyEntry,
      protection: 'unprotected',
    })),
    contributors: [],
    topologyEvidence: {
      componentIds: [],
      pathsWithMultipleTurns: [],
      captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
    },
    concurrencyCases: [],
    saveability: { saveable: true },
  };
}

function edge(
  turnId: string,
  affectedEntryIds: string[],
  expiresAt: number,
  edgeKind: 'before' | 'after' = 'after',
): SaveCardCheckpointExpiryNotice['edges'][number] {
  return { repositoryKey: 'repo-1', turnId, edge: edgeKind, expiresAt, affectedEntryIds };
}

function notice(edges: SaveCardCheckpointExpiryNotice['edges']): SaveCardCheckpointExpiryNotice {
  return { observedAt: 1_000, expiresWithinMs: 100_000, edges };
}

describe('intent-unit checkpoint expiry', () => {
  it('collects member entry ids', () => {
    expect([...intentUnitEntryIds(unit('one', ['a', 'b']))].sort()).toEqual(['a', 'b']);
  });

  it('groups intersecting edges by intent and orders by deadline', () => {
    const grouped = groupExpiryEdgesByIntentUnit(notice([
      edge('late', ['a'], 9_000),
      edge('soon', ['c'], 2_000),
    ]), [unit('late', ['a', 'b']), unit('soon', ['c']), unit('none', ['z'])]);

    expect(grouped.map((row) => row.unit.intentId)).toEqual(['soon', 'late']);
    expect(grouped[0].earliestExpiresAt).toBe(2_000);
    expect(grouped[1].edges.map((item) => item.turnId)).toEqual(['late']);
  });

  it('returns no rows without a notice or matching entries', () => {
    expect(groupExpiryEdgesByIntentUnit(null, [unit('one', ['a'])])).toEqual([]);
    expect(groupExpiryEdgesByIntentUnit(notice([edge('x', ['z'], 3_000)]), [unit('one', ['a'])])).toEqual([]);
  });

  it('orders several edges on one intent soonest first', () => {
    const [row] = groupExpiryEdgesByIntentUnit(notice([
      edge('second', ['a'], 5_000),
      edge('first', ['a'], 3_000, 'before'),
    ]), [unit('one', ['a'])]);
    expect(row.edges.map((item) => item.turnId)).toEqual(['first', 'second']);
  });
});

describe('formatExpiresIn', () => {
  const hour = 60 * 60 * 1_000;

  it('formats elapsed, sub-hour, hour, and day deadlines', () => {
    expect(formatExpiresIn(500, 1_000)).toBe('now');
    expect(formatExpiresIn(1_000 + 30 * 60 * 1_000, 1_000)).toBe('under an hour');
    expect(formatExpiresIn(1_000 + hour, 1_000)).toBe('1 hour');
    expect(formatExpiresIn(1_000 + 3 * hour, 1_000)).toBe('3 hours');
    expect(formatExpiresIn(1_000 + 24 * hour, 1_000)).toBe('1 day');
    expect(formatExpiresIn(1_000 + 48 * hour, 1_000)).toBe('2 days');
  });
});
