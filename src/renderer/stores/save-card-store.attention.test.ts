// @vitest-environment jsdom
// SC-WP-N2 — Save-card store checkpoint-expiry attention contract:
//  - setAttention records a per-workspace notice (session-only);
//  - hasCheckpointExpiryAttention / useSaveCardAttentionActive are true ONLY when a
//    notice carries at least one expiring edge;
//  - attention is isolated per workspace and never disturbs the SC-WP-C1 inventory
//    stale-while-revalidate cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useSaveCardStore,
  hasCheckpointExpiryAttention,
  useSaveCardAttentionActive,
} from './save-card-store';
import type {
  SaveCardCheckpointExpiryNotice,
  SaveCardInventoryResponse,
} from '../../shared/types';

function notice(edges = 1, workspaceId = 'ws-1'): SaveCardCheckpointExpiryNotice {
  return {
    observedAt: 1000,
    expiresWithinMs: 60_000,
    edges: Array.from({ length: edges }, (_, i) => ({
      repositoryKey: `repo-of-${workspaceId}`,
      turnId: `turn-${i}`,
      edge: 'after' as const,
      expiresAt: 2000 + i,
      affectedEntryIds: [`entry-${i}`],
    })),
  };
}

function inventory(): SaveCardInventoryResponse {
  return { intentUnits: [], unwitnessed: [], legacyTaskIdentityUnavailable: [],
    legacyFinalizations: [], planningActivities: [], quotaWeakening: null };
}

beforeEach(() => {
  useSaveCardStore.setState({ inventoryByWorkspace: {}, attentionByWorkspace: {} });
});

describe('hasCheckpointExpiryAttention', () => {
  it('is false for null/undefined and for an edgeless notice', () => {
    expect(hasCheckpointExpiryAttention(null)).toBe(false);
    expect(hasCheckpointExpiryAttention(undefined)).toBe(false);
    expect(hasCheckpointExpiryAttention({ observedAt: 0, expiresWithinMs: 0, edges: [] })).toBe(false);
  });
  it('is true when at least one edge is present', () => {
    expect(hasCheckpointExpiryAttention(notice(1))).toBe(true);
  });
});

describe('setAttention', () => {
  it('records and clears a per-workspace notice', () => {
    useSaveCardStore.getState().setAttention('ws-1', notice(2));
    expect(useSaveCardStore.getState().attentionByWorkspace['ws-1']?.edges).toHaveLength(2);

    useSaveCardStore.getState().setAttention('ws-1', null);
    expect(useSaveCardStore.getState().attentionByWorkspace['ws-1']).toBeNull();
  });

  it('isolates workspaces from one another', () => {
    useSaveCardStore.getState().setAttention('ws-1', notice(1, 'ws-1'));
    useSaveCardStore.getState().setAttention('ws-2', null);
    const { attentionByWorkspace } = useSaveCardStore.getState();
    expect(hasCheckpointExpiryAttention(attentionByWorkspace['ws-1'])).toBe(true);
    expect(hasCheckpointExpiryAttention(attentionByWorkspace['ws-2'])).toBe(false);
  });

  it('does not disturb the SC-WP-C1 inventory cache', () => {
    useSaveCardStore.getState().cacheInventory('ws-1', inventory(), 12345);
    useSaveCardStore.getState().setAttention('ws-1', notice(1));
    const cached = useSaveCardStore.getState().inventoryByWorkspace['ws-1'];
    expect(cached).toBeDefined();
    expect(cached.loadedAt).toBe(12345);
  });
});

describe('useSaveCardAttentionActive selector (rendered)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: boolean | null = null;

  function Probe({ workspaceId }: { workspaceId: string | null }) {
    observed = useSaveCardAttentionActive(workspaceId);
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observed = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('is true when the workspace has an expiring edge, and re-renders on update', () => {
    act(() => root.render(React.createElement(Probe, { workspaceId: 'ws-1' })));
    expect(observed).toBe(false);

    act(() => useSaveCardStore.getState().setAttention('ws-1', notice(1)));
    expect(observed).toBe(true);

    act(() => useSaveCardStore.getState().setAttention('ws-1', null));
    expect(observed).toBe(false);
  });

  it('is false for a null workspaceId regardless of store contents', () => {
    act(() => useSaveCardStore.getState().setAttention('ws-1', notice(1)));
    act(() => root.render(React.createElement(Probe, { workspaceId: null })));
    expect(observed).toBe(false);
  });
});
