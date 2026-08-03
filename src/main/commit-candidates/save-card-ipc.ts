// SC-WP-1H — read-only Save-card IPC transport.
//
// The routes object owns the CommitCandidateService and all Git/database
// dependencies. This layer only validates the renderer request and transports
// the renderer-safe WorkBundle DTO. The Stage 1 inventory channel is deliberately
// read-only.
//
// SC-WP-3E — fleet-adhoc mark-done finalization channel.
//
// Stage 3 adds ONE explicit mutating channel, registered by a DISTINCT function
// (`registerSaveCardFinalizeIpc`) so the read-only inventory surface above stays
// read-only. A fleet-adhoc "mark done" is an explicit mint step — never silently
// folded into a commit mutation. The channel pins `finalizationKind='fleet-adhoc'`
// itself (NULL plan attribution) and always surfaces the captured `boundary_ref`.

import {
  SAVECARD_CHANNELS,
  type SaveCardInventoryRequest,
  type SaveCardInventoryResponse,
} from '../../shared/types';
import type {
  FinalizationBoundaryStatus,
  PackageFinalization,
} from '../database';
import {
  finalizePackage,
  type FinalizeOutcome,
  type FinalizePackageDeps,
  type FinalizePackageRequest,
} from './finalization-service';

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

// ── SC-WP-3E — fleet-adhoc mark-done finalization channel ─────────────────────

/** The DISTINCT mutating channel. Kept out of `SAVECARD_CHANNELS` so the Stage 1
 *  read-only audit stays exact; carries the explicit `markDone` verb. */
export const SAVECARD_FINALIZE_CHANNEL = 'savecard:markDoneFleetAdhoc' as const;

/** Renderer request to mint a fleet-adhoc finalization for one package. Only the
 *  stable `packageId` crosses the wire; the main process resolves the boundary. */
export interface SaveCardFleetAdhocMarkDoneRequest {
  packageId: string;
}

/**
 * Everything `finalizePackage` needs EXCEPT the fleet-adhoc discriminants, which
 * this channel pins itself. A main-process provider resolves it (boundary oid,
 * frozen members, git seams) from the renderer's `packageId`; the discriminant
 * fields are deliberately excluded so a fleet-adhoc mark-done can never be minted
 * with plan attribution.
 */
export type FleetAdhocBoundaryContext = Omit<
  FinalizePackageRequest,
  'finalizationKind' | 'planId' | 'planItemId'
>;

/** Renderer-safe result of a fleet-adhoc mark-done. `boundaryRef` is always
 *  captured — even an `unavailable` outcome names the ref it failed to pin. */
export interface SaveCardFleetAdhocMarkDoneResponse {
  finalizationId: string;
  packageId: string;
  finalizationKind: 'fleet-adhoc';
  outcome: FinalizeOutcome;
  boundaryRef: string | null;
  boundaryStatus: FinalizationBoundaryStatus;
  packageRevision: number;
}

/** The main-process seam the mark-done channel drives. `resolveBoundary` maps a
 *  renderer `packageId` to the full finalize context; `finalizeDeps` is left
 *  undefined in production so the live DB store + real ref writer are used. */
export interface SaveCardFinalizeRoutes {
  resolveBoundary(req: SaveCardFleetAdhocMarkDoneRequest): Promise<FleetAdhocBoundaryContext>;
  finalizeDeps?: FinalizePackageDeps;
}

function requireFinalizeRoutes(routes: SaveCardFinalizeRoutes | null): SaveCardFinalizeRoutes {
  if (!routes) {
    throw new SaveCardIpcError(
      'Save-card finalization engine unavailable (the engine has not finished bootstrapping)',
      'save-card-engine-unavailable',
    );
  }
  return routes;
}

function requireMarkDoneRequest(raw: unknown): SaveCardFleetAdhocMarkDoneRequest {
  if (!raw || typeof raw !== 'object') {
    throw new SaveCardIpcError(
      'a request with a non-empty packageId is required',
      'save-card-bad-request',
    );
  }
  const packageId = (raw as { packageId?: unknown }).packageId;
  if (typeof packageId !== 'string' || packageId === '') {
    throw new SaveCardIpcError(
      'a non-empty packageId is required',
      'save-card-bad-request',
    );
  }
  return { packageId };
}

function toMarkDoneResponse(
  finalization: PackageFinalization,
  outcome: FinalizeOutcome,
): SaveCardFleetAdhocMarkDoneResponse {
  return {
    finalizationId: finalization.id,
    packageId: finalization.packageId,
    finalizationKind: 'fleet-adhoc',
    outcome,
    boundaryRef: finalization.boundaryRef,
    boundaryStatus: finalization.boundaryStatus,
    packageRevision: finalization.packageRevision,
  };
}

/**
 * Register the DISTINCT fleet-adhoc mark-done channel. The handler pins the
 * fleet-adhoc discriminants (kind + NULL plan attribution) itself so the mint is
 * explicit and can never masquerade as a plan-package finalization, then delegates
 * to the shared WP-3C `finalizePackage` core and returns the captured `boundary_ref`.
 *
 * `getRoutes` is evaluated per invocation so registration can happen before the
 * asynchronous production engine injects its route object.
 */
export function registerSaveCardFinalizeIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardFinalizeRoutes | null,
): void {
  ipc.handle(SAVECARD_FINALIZE_CHANNEL, async (_event, raw: unknown) => {
    const routes = requireFinalizeRoutes(getRoutes());
    const request = requireMarkDoneRequest(raw);
    const context = await routes.resolveBoundary(request);
    const finalizeRequest: FinalizePackageRequest = {
      ...context,
      finalizationKind: 'fleet-adhoc',
      planId: null,
      planItemId: null,
    };
    const result = await finalizePackage(finalizeRequest, routes.finalizeDeps);
    return toMarkDoneResponse(result.finalization, result.outcome);
  });
}
