// SC-WP-N2 — the Save pane's expiry grouping: map expiring recovery edges onto the
// displayed bundles by intersecting each edge's affectedEntryIds with the bundle's
// member entry ids. Pure logic — no DOM.
import { describe, it, expect } from 'vitest';
import {
  groupExpiryEdgesByBundle,
  bundleEntryIds,
  formatExpiresIn,
} from './save-card-expiry';
import type { WorkBundleDto } from './SaveBundle';
import type { SaveCardCheckpointExpiryNotice } from '../../../shared/types';

function bundle(bundleId: string, entryIds: string[]): WorkBundleDto {
  return {
    bundleId,
    kind: 'unattributed',
    label: `Bundle ${bundleId}`,
    labels: [],
    repositoryKey: 'repo-1',
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
    component: null,
    members: entryIds.map((entryId) => ({
      // Only entryId is read by the grouping; the rest is structural filler.
      entry: { entryId } as WorkBundleDto['members'][number]['entry'],
      protection: 'working-tree' as WorkBundleDto['members'][number]['protection'],
    })),
    captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
    weakestProtection: null,
    identity: null,
  };
}

function edge(
  turnId: string,
  affectedEntryIds: string[],
  expiresAt: number,
  e: 'before' | 'after' = 'after',
): SaveCardCheckpointExpiryNotice['edges'][number] {
  return { repositoryKey: 'repo-1', turnId, edge: e, expiresAt, affectedEntryIds };
}

function notice(edges: SaveCardCheckpointExpiryNotice['edges']): SaveCardCheckpointExpiryNotice {
  return { observedAt: 1000, expiresWithinMs: 100_000, edges };
}

describe('bundleEntryIds', () => {
  it('collects each member entry id', () => {
    expect([...bundleEntryIds(bundle('b1', ['a', 'b']))].sort()).toEqual(['a', 'b']);
  });
});

describe('groupExpiryEdgesByBundle', () => {
  it('returns [] for a null/empty notice', () => {
    expect(groupExpiryEdgesByBundle(null, [bundle('b1', ['a'])])).toEqual([]);
    expect(groupExpiryEdgesByBundle(notice([]), [bundle('b1', ['a'])])).toEqual([]);
  });

  it('attaches an edge only to bundles whose members intersect affectedEntryIds', () => {
    const bundles = [bundle('b1', ['a', 'b']), bundle('b2', ['c'])];
    const grouped = groupExpiryEdgesByBundle(notice([edge('t1', ['b'], 3000)]), bundles);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].bundle.bundleId).toBe('b1');
    expect(grouped[0].edges.map((e) => e.turnId)).toEqual(['t1']);
  });

  it('lets one edge span several bundles when its entries do', () => {
    const bundles = [bundle('b1', ['a']), bundle('b2', ['c'])];
    const grouped = groupExpiryEdgesByBundle(notice([edge('t1', ['a', 'c'], 3000)]), bundles);
    expect(grouped.map((g) => g.bundle.bundleId)).toEqual(['b1', 'b2']);
  });

  it('omits bundles with no intersecting edge and bundles with no members', () => {
    const bundles = [bundle('b1', ['a']), bundle('empty', [])];
    const grouped = groupExpiryEdgesByBundle(notice([edge('t1', ['z'], 3000)]), bundles);
    expect(grouped).toEqual([]);
  });

  it('orders bundles by soonest deadline and reports earliestExpiresAt', () => {
    const bundles = [bundle('late', ['x']), bundle('soon', ['y'])];
    const grouped = groupExpiryEdgesByBundle(
      notice([edge('t-late', ['x'], 9000), edge('t-soon', ['y'], 2000)]),
      bundles,
    );
    expect(grouped.map((g) => g.bundle.bundleId)).toEqual(['soon', 'late']);
    expect(grouped[0].earliestExpiresAt).toBe(2000);
  });

  it('sorts multiple edges on one bundle soonest-first', () => {
    const grouped = groupExpiryEdgesByBundle(
      notice([edge('t2', ['a'], 5000, 'after'), edge('t1', ['a'], 3000, 'before')]),
      [bundle('b1', ['a'])],
    );
    expect(grouped[0].edges.map((e) => e.expiresAt)).toEqual([3000, 5000]);
    expect(grouped[0].earliestExpiresAt).toBe(3000);
  });
});

describe('formatExpiresIn', () => {
  const H = 60 * 60 * 1000;
  it('never goes negative', () => {
    expect(formatExpiresIn(500, 1000)).toBe('now');
  });
  it('formats sub-hour, hours, and days', () => {
    expect(formatExpiresIn(1000 + 30 * 60 * 1000, 1000)).toBe('under an hour');
    expect(formatExpiresIn(1000 + 3 * H, 1000)).toBe('3 hours');
    expect(formatExpiresIn(1000 + 1 * H, 1000)).toBe('1 hour');
    expect(formatExpiresIn(1000 + 48 * H, 1000)).toBe('2 days');
    expect(formatExpiresIn(1000 + 24 * H, 1000)).toBe('1 day');
  });
});
