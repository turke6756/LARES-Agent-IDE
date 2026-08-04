// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveCardInventoryResponse } from '../../../shared/types';
import SaveCard from './SaveCard';
import {
  SAVE_CARD_INVENTORY_TTL_MS,
  useSaveCardStore,
} from '../../stores/save-card-store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const dashboardState = {
  selectedWorkspaceId: 'ws-cache' as string | null,
  workspaces: [{ id: 'ws-cache', title: 'Cached workspace', path: '/ws', pathType: 'windows' }],
  saveCardOpenGesture: false,
  consumeSaveCardGesture: vi.fn(),
};

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector: (state: typeof dashboardState) => unknown) =>
    selector(dashboardState),
}));

const emptyInventory = (): SaveCardInventoryResponse => ({
  bundles: [],
  quotaWeakening: null,
});

let container: HTMLDivElement;
let root: Root;
let getInventory: ReturnType<typeof vi.fn>;

async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SaveCard));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useSaveCardStore.getState().clearInventoryCache();
  getInventory = vi.fn();
  (window as unknown as { api: unknown }).api = {
    saveCard: { getInventory },
    demandProbe: { record: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SaveCard inventory cache', () => {
  it('renders a fresh cached inventory immediately without fetching again', async () => {
    useSaveCardStore.getState().cacheInventory('ws-cache', emptyInventory());

    await renderCard();

    expect(container.querySelector('[data-testid="save-card-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="save-card-loading"]')).toBeNull();
    expect(getInventory).not.toHaveBeenCalled();
  });

  it('keeps stale cached content visible while refreshing in the background', async () => {
    const fresh = emptyInventory();
    let resolveInventory!: (inventory: SaveCardInventoryResponse) => void;
    getInventory.mockReturnValue(new Promise((resolve) => { resolveInventory = resolve; }));
    useSaveCardStore.getState().cacheInventory(
      'ws-cache',
      emptyInventory(),
      Date.now() - SAVE_CARD_INVENTORY_TTL_MS,
    );

    await renderCard();

    expect(container.querySelector('[data-testid="save-card-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="save-card-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-card-refreshing"]')).toBeTruthy();
    expect(getInventory).toHaveBeenCalledTimes(1);

    await act(async () => { resolveInventory(fresh); });
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-cache'].inventory).toBe(fresh);
    expect(container.querySelector('[data-testid="save-card-refreshing"]')).toBeNull();
  });

  it('refreshes immediately when a mutation invalidates the current inventory', async () => {
    const fresh = emptyInventory();
    getInventory.mockResolvedValue(fresh);
    useSaveCardStore.getState().cacheInventory('ws-cache', emptyInventory());
    await renderCard();
    expect(getInventory).not.toHaveBeenCalled();

    await act(async () => {
      useSaveCardStore.getState().invalidateInventory('ws-cache');
      await Promise.resolve();
    });

    expect(getInventory).toHaveBeenCalledTimes(1);
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-cache'].inventory).toBe(fresh);
  });

  it('does not cache a failed initial inventory load', async () => {
    getInventory.mockRejectedValue(new Error('inventory failed'));

    await renderCard();

    expect(container.querySelector('[data-testid="save-card-error"]')?.textContent)
      .toContain('inventory failed');
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-cache']).toBeUndefined();
  });
});
