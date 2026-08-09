// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSaveCardStore } from './save-card-store';

describe('save-card post-commit refresh', () => {
  beforeEach(() => {
    useSaveCardStore.setState({ inventoryByWorkspace: {}, attentionByWorkspace: {} });
  });

  it('invalidates stale unsaved work and replaces it with the forced fresh inventory', async () => {
    useSaveCardStore.getState().cacheInventory('ws-1', {
      intentUnits: [{ intentId: 'obsolete-unsaved-intent' }] as never,
      unwitnessed: [], legacyTaskIdentityUnavailable: [], legacyFinalizations: [], planningActivities: [],
      quotaWeakening: null,
    }, 123);
    const fresh = { intentUnits: [], unwitnessed: [], legacyTaskIdentityUnavailable: [],
      legacyFinalizations: [], planningActivities: [], quotaWeakening: null };
    const getInventory = vi.fn(async () => fresh);
    (window as unknown as { api: unknown }).api = { saveCard: { getInventory } };

    await expect(useSaveCardStore.getState().refreshInventory('ws-1')).resolves.toBe(fresh);
    expect(getInventory).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-1'].inventory.intentUnits).toEqual([]);
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-1'].loadedAt).toBeGreaterThan(0);
  });
});
