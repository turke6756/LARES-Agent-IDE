// SC-WP-1H — read-only Save-card IPC transport.
//
// The routes object owns the CommitCandidateService and all Git/database
// dependencies. This layer only validates the renderer request and transports
// the renderer-safe WorkBundle DTO. There is deliberately no mutating channel.

import {
  SAVECARD_CHANNELS,
  type SaveCardInventoryRequest,
  type SaveCardInventoryResponse,
} from '../../shared/types';

/** Narrow read-only surface injected after the Save-card engine is available. */
export interface SaveCardRoutes {
  getInventory(req: SaveCardInventoryRequest): Promise<SaveCardInventoryResponse>;
}

/** Minimal `ipcMain.handle` shape for testing without a live Electron main. */
export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

class SaveCardIpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SaveCardIpcError';
  }
}

function requireRoutes(routes: SaveCardRoutes | null): SaveCardRoutes {
  if (!routes) {
    throw new SaveCardIpcError(
      'Save-card engine unavailable (the engine has not finished bootstrapping)',
      'save-card-engine-unavailable',
    );
  }
  return routes;
}

function requireRequest(raw: unknown): SaveCardInventoryRequest {
  if (!raw || typeof raw !== 'object') {
    throw new SaveCardIpcError(
      'a request with a non-empty workspaceId is required',
      'save-card-bad-request',
    );
  }
  const workspaceId = (raw as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new SaveCardIpcError(
      'a non-empty workspaceId is required',
      'save-card-bad-request',
    );
  }
  return { workspaceId };
}

/**
 * Register the single Stage 1 Save-card read channel.
 *
 * `getRoutes` is evaluated per invocation so registration can happen before the
 * asynchronous production engine injects its route object.
 */
export function registerSaveCardIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardRoutes | null,
): void {
  ipc.handle(SAVECARD_CHANNELS.getInventory, async (_event, raw: unknown) => {
    const routes = requireRoutes(getRoutes());
    return routes.getInventory(requireRequest(raw));
  });
}
