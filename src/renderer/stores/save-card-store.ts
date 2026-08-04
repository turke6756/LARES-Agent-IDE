import { create } from 'zustand';
import type { SaveCardInventoryResponse } from '../../shared/types';

export const SAVE_CARD_INVENTORY_TTL_MS = 3 * 60_000;

export interface SaveCardInventoryCacheEntry {
  inventory: SaveCardInventoryResponse;
  loadedAt: number;
}

interface SaveCardStoreState {
  inventoryByWorkspace: Record<string, SaveCardInventoryCacheEntry>;
  cacheInventory: (
    workspaceId: string,
    inventory: SaveCardInventoryResponse,
    loadedAt?: number,
  ) => void;
  invalidateInventory: (workspaceId: string) => void;
  clearInventoryCache: () => void;
}

/**
 * Session-only Save-card inventory cache. Successful inventories survive the
 * SaveCard component unmounting, while errors remain local to the component.
 */
export const useSaveCardStore = create<SaveCardStoreState>((set) => ({
  inventoryByWorkspace: {},
  cacheInventory: (workspaceId, inventory, loadedAt = Date.now()) =>
    set((state) => ({
      inventoryByWorkspace: {
        ...state.inventoryByWorkspace,
        [workspaceId]: { inventory, loadedAt },
      },
    })),
  invalidateInventory: (workspaceId) =>
    set((state) => {
      const cached = state.inventoryByWorkspace[workspaceId];
      if (!cached) return state;
      return {
        inventoryByWorkspace: {
          ...state.inventoryByWorkspace,
          [workspaceId]: { ...cached, loadedAt: 0 },
        },
      };
    }),
  clearInventoryCache: () => set({ inventoryByWorkspace: {} }),
}));

export function isSaveCardInventoryFresh(
  entry: SaveCardInventoryCacheEntry,
  now = Date.now(),
): boolean {
  return entry.loadedAt > 0 && now - entry.loadedAt < SAVE_CARD_INVENTORY_TTL_MS;
}
