import { create } from 'zustand';
import type {
  SaveCardInventoryResponse,
  SaveCardCheckpointExpiryNotice,
} from '../../shared/types';

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
  refreshInventory: (workspaceId: string) => Promise<SaveCardInventoryResponse>;
  clearInventoryCache: () => void;
  // SC-WP-N2 — session-only checkpoint-expiry attention, keyed by workspace. Fed by
  // the `savecard:getAttention` read + `savecard:attentionChanged` push; drives the
  // Save entry's amber glow and the Save pane's expiry block. Never persisted.
  attentionByWorkspace: Record<string, SaveCardCheckpointExpiryNotice | null>;
  setAttention: (
    workspaceId: string,
    notice: SaveCardCheckpointExpiryNotice | null,
  ) => void;
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
  refreshInventory: async (workspaceId) => {
    // Invalidate before the read so every mounted Save surface observes stale
    // state immediately; replace it only with the authoritative post-commit read.
    useSaveCardStore.getState().invalidateInventory(workspaceId);
    const inventory = await window.api.saveCard.getInventory({ workspaceId });
    useSaveCardStore.getState().cacheInventory(workspaceId, inventory);
    return inventory;
  },
  clearInventoryCache: () => set({ inventoryByWorkspace: {} }),
  attentionByWorkspace: {},
  setAttention: (workspaceId, notice) =>
    set((state) => ({
      attentionByWorkspace: {
        ...state.attentionByWorkspace,
        [workspaceId]: notice,
      },
    })),
}));

export function isSaveCardInventoryFresh(
  entry: SaveCardInventoryCacheEntry,
  now = Date.now(),
): boolean {
  return entry.loadedAt > 0 && now - entry.loadedAt < SAVE_CARD_INVENTORY_TTL_MS;
}

/** SC-WP-N2 — pure predicate: does this notice represent live attention? True only
 *  when a notice exists AND carries at least one expiring edge. */
export function hasCheckpointExpiryAttention(
  notice: SaveCardCheckpointExpiryNotice | null | undefined,
): boolean {
  return !!notice && notice.edges.length > 0;
}

/** SC-WP-N2 — the notice for one workspace (null/absent ⇒ null). */
export function useSaveCardAttention(
  workspaceId: string | null | undefined,
): SaveCardCheckpointExpiryNotice | null {
  return useSaveCardStore((s) =>
    workspaceId ? s.attentionByWorkspace[workspaceId] ?? null : null,
  );
}

/** SC-WP-N2 — boolean selector for the Save entry's glow: true when the workspace
 *  has a checkpoint edge expiring soon. */
export function useSaveCardAttentionActive(
  workspaceId: string | null | undefined,
): boolean {
  return useSaveCardStore((s) =>
    hasCheckpointExpiryAttention(
      workspaceId ? s.attentionByWorkspace[workspaceId] : null,
    ),
  );
}
