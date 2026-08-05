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
  SAVECARD_PREVIEW_CHANNEL,
  COMMIT_CANDIDATE_MINT_CHANNEL,
  SAVECARD_FINALIZE_CHANNEL,
  SAVECARD_ATTENTION_CHANNEL,
  SAVECARD_ATTENTION_CHANGED_CHANNEL,
  type SaveCardInventoryRequest,
  type SaveCardInventoryResponse,
  type SaveCardPreviewRequest,
  type SaveCardPreviewResponse,
  type SaveCardMintRequest,
  type SaveCardMintResponse,
  type SaveCardPinnedSelection,
  type SaveCardFleetAdhocMarkDoneRequest,
  type SaveCardFleetAdhocMarkDoneResponse,
  type SaveCardFleetAdhocRefusalCode,
  type SaveCardAttentionRequest,
  type SaveCardCheckpointExpiryNotice,
  type SaveCardAttentionChangedPayload,
} from '../../shared/types';
import type { PackageFinalization } from '../database';
import {
  finalizePackage,
  type FinalizeOutcome,
  type FinalizePackageDeps,
  type FinalizePackageRequest,
} from './finalization-service';
import {
  buildCandidate,
  computeCandidateTopologyDigest,
  type CandidateBuildContext,
  type CandidateSelectionRequest,
} from './candidate-service';
import { resolvePinnedSelectionDrift } from './pinned-selection-drift';
import type {
  CommitCandidate,
  SaveRefusal,
  SaveRefusalStage,
  SelectionPreview,
} from '../../shared/commit-candidates';

// Backward-compatible main-module exports for the focused IPC tests and any
// main-side callers; the wire contract itself is owned by shared/types.
export {
  SAVECARD_FINALIZE_CHANNEL,
  type SaveCardFleetAdhocMarkDoneRequest,
  type SaveCardFleetAdhocMarkDoneResponse,
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

// ── SC-WP-N2 — checkpoint-expiry attention channel (read + push) ──────────────

/** The main-side seam the attention read drives: the freshest per-workspace
 *  checkpoint-expiry notice, published by each retention cycle. Returns null when
 *  the workspace has no edge expiring soon (or no cycle has run yet). */
export type SaveCardAttentionProvider = (workspaceId: string) => SaveCardCheckpointExpiryNotice | null;

/** Minimal `webContents.send` shape for the attention push (testable without a
 *  live BrowserWindow). */
export interface AttentionSenderLike {
  send(channel: string, payload: SaveCardAttentionChangedPayload): void;
}

function requireAttentionRequest(raw: unknown): SaveCardAttentionRequest {
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
 * Register the lightweight read channel. Unlike the inventory route this NEVER
 * probes git — it only reads the in-memory notice the retention cycle published,
 * so the Save entry can illuminate cheaply. `getProvider` is evaluated per
 * invocation so registration can precede the async engine bootstrap that injects
 * the provider (a missing provider answers null, never throws).
 */
export function registerSaveCardAttentionIpc(
  ipc: IpcLike,
  getProvider: () => SaveCardAttentionProvider | null,
): void {
  ipc.handle(SAVECARD_ATTENTION_CHANNEL, (_event, raw: unknown) => {
    const request = requireAttentionRequest(raw);
    const provider = getProvider();
    return provider ? provider(request.workspaceId) : null;
  });
}

/** Push the freshest attention notice for one workspace to a renderer. Kept here
 *  (not inline in index.ts) so the wire shape has one owner and is unit-testable. */
export function broadcastSaveCardAttention(
  sender: AttentionSenderLike,
  workspaceId: string,
  notice: SaveCardCheckpointExpiryNotice | null,
): void {
  sender.send(SAVECARD_ATTENTION_CHANGED_CHANNEL, { workspaceId, notice });
}

// ── SC-WP-3E — fleet-adhoc mark-done finalization channel ─────────────────────

/** The DISTINCT mutating channel. Kept out of `SAVECARD_CHANNELS` so the Stage 1
 *  read-only audit stays exact; carries the explicit `markDone` verb. */
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
> & { pinnedSelection: SaveCardPinnedSelection };

/** Renderer-safe result of a fleet-adhoc mark-done. `boundaryRef` is always
 *  captured — even an `unavailable` outcome names the ref it failed to pin. */
/** The main-process seam the mark-done channel drives. `resolveBoundary` maps a
 *  renderer `packageId` to the full finalize context; `finalizeDeps` is left
 *  undefined in production so the live DB store + real ref writer are used. */
export interface SaveCardFinalizeRoutes {
  resolveBoundary(req: SaveCardFleetAdhocMarkDoneRequest): Promise<FleetAdhocBoundaryContext>;
  finalizeDeps?: FinalizePackageDeps;
}

/** A known, renderer-actionable boundary refusal. Preview-route implementations
 *  throw this below their trust boundary; the IPC handler alone converts it to
 *  a typed response. Unexpected errors continue to reject. */
export class SaveCardFinalizeRefusalError extends Error {
  constructor(
    message: string,
    readonly code: SaveCardFleetAdhocRefusalCode,
    readonly workspaceId: string,
    readonly workspaceTitle: string,
    readonly stage: SaveRefusalStage = 'boundary-capture',
    readonly paths?: string[],
  ) {
    super(message);
    this.name = 'SaveCardFinalizeRefusalError';
  }
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
  const targetWorkspaceId = (raw as { targetWorkspaceId?: unknown }).targetWorkspaceId;
  if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId === '') {
    throw new SaveCardIpcError(
      'a non-empty targetWorkspaceId is required',
      'save-card-bad-request',
    );
  }
  return { packageId, targetWorkspaceId };
}

function toMarkDoneResponse(
  finalization: PackageFinalization,
  outcome: FinalizeOutcome,
  pinnedSelection: SaveCardPinnedSelection,
): SaveCardFleetAdhocMarkDoneResponse {
  return {
    finalizationId: finalization.id,
    packageId: finalization.packageId,
    finalizationKind: 'fleet-adhoc',
    outcome,
    boundaryRef: finalization.boundaryRef,
    boundaryStatus: finalization.boundaryStatus,
    packageRevision: finalization.packageRevision,
    pinnedSelection,
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
    let context: FleetAdhocBoundaryContext;
    try {
      context = await routes.resolveBoundary(request);
    } catch (error) {
      if (error instanceof SaveCardFinalizeRefusalError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          stage: error.stage,
          ...(error.paths ? { paths: error.paths } : {}),
          workspaceId: error.workspaceId,
          workspaceTitle: error.workspaceTitle,
        } satisfies SaveCardFleetAdhocMarkDoneResponse;
      }
      throw error;
    }
    const finalizeRequest: FinalizePackageRequest = {
      ...context,
      finalizationKind: 'fleet-adhoc',
      planId: null,
      planItemId: null,
    };
    const result = await finalizePackage(finalizeRequest, routes.finalizeDeps);
    const response = toMarkDoneResponse(result.finalization, result.outcome, context.pinnedSelection);
    if (result.outcome !== 'boundary-unavailable') return response;
    return {
      ...response,
      refusal: {
        stage: 'freeze',
        code: 'freeze-boundary-unavailable',
        message: 'Freeze stage refused because the captured boundary could not be made durable.',
        paths: context.members.map((member) => member.path.pathBytesBase64),
      },
    };
  });
}

// ── SC-WP-3H — Save-lens candidate preview channel ────────────────────────────

/** The main-process seam the preview channel drives. `resolvePreviewContext`
 *  resolves a renderer selection into the full WP-3G `CandidateBuildContext`
 *  (inventory, components, requested finalizations, temp-index reps, ledger,
 *  fingerprint, pinned HEAD); the handler then calls the pure `buildCandidate`
 *  assembler so both lenses share one identity/verdict computation. Read-only. */
export interface SaveCardPreviewRoutes {
  resolvePreviewContext(req: SaveCardPreviewRequest): Promise<CandidateBuildContext>;
}

export interface SaveCardMintRoutes {
  mintCandidate(req: SaveCardMintRequest): Promise<{
    candidate: CommitCandidate | SelectionPreview;
    context: CandidateBuildContext;
  }>;
}

function requirePreviewRoutes(routes: SaveCardPreviewRoutes | null): SaveCardPreviewRoutes {
  if (!routes) {
    throw new SaveCardIpcError(
      'Save-card preview engine unavailable (the engine has not finished bootstrapping)',
      'save-card-engine-unavailable',
    );
  }
  return routes;
}

function requirePreviewRequest(raw: unknown): SaveCardPreviewRequest {
  if (!raw || typeof raw !== 'object') {
    throw new SaveCardIpcError(
      'a preview request with a non-empty workspaceId is required',
      'save-card-bad-request',
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.workspaceId !== 'string' || record.workspaceId === '') {
    throw new SaveCardIpcError(
      'a non-empty workspaceId is required',
      'save-card-bad-request',
    );
  }
  const asStringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new SaveCardIpcError(`${field} must be an array of strings`, 'save-card-bad-request');
    }
    return value as string[];
  };
  return {
    workspaceId: record.workspaceId,
    selectedComponentIds: asStringArray(record.selectedComponentIds, 'selectedComponentIds'),
    selectedUnattributedEntryIds: asStringArray(
      record.selectedUnattributedEntryIds,
      'selectedUnattributedEntryIds',
    ),
    finalizationIds: asStringArray(record.finalizationIds, 'finalizationIds'),
  };
}

const MINT_REQUEST_FIELDS = new Set([
  'workspaceId',
  'selectedComponentIds',
  'selectedUnattributedEntryIds',
  'finalizationIds',
  'acknowledgeTopologyDigest',
  'acknowledgeUnattributedEntryIds',
]);

function requireMintRequest(raw: unknown): SaveCardMintRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SaveCardIpcError('a mint request is required', 'save-card-bad-request');
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((field) => !MINT_REQUEST_FIELDS.has(field));
  if (unexpected.length > 0) {
    throw new SaveCardIpcError(`unexpected mint request field: ${unexpected[0]}`, 'save-card-bad-request');
  }
  if (typeof record.workspaceId !== 'string' || record.workspaceId === '') {
    throw new SaveCardIpcError('a non-empty workspaceId is required', 'save-card-bad-request');
  }
  const strings = (field: string): string[] => {
    const value = record[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new SaveCardIpcError(`${field} must be an array of strings`, 'save-card-bad-request');
    }
    return value as string[];
  };
  if (record.acknowledgeTopologyDigest !== null
      && typeof record.acknowledgeTopologyDigest !== 'string') {
    throw new SaveCardIpcError(
      'acknowledgeTopologyDigest must be a string or null',
      'save-card-bad-request',
    );
  }
  return {
    workspaceId: record.workspaceId,
    selectedComponentIds: strings('selectedComponentIds'),
    selectedUnattributedEntryIds: strings('selectedUnattributedEntryIds'),
    finalizationIds: strings('finalizationIds'),
    acknowledgeTopologyDigest: record.acknowledgeTopologyDigest,
    acknowledgeUnattributedEntryIds: strings('acknowledgeUnattributedEntryIds'),
  };
}

function isCommitCandidate(
  candidate: CommitCandidate | SelectionPreview,
): candidate is CommitCandidate {
  return 'candidateId' in candidate;
}

/**
 * Derive the READ-ONLY `Lares-*` trailer previews from the immutable snapshot
 * (the resolved context + the assembled candidate) — never from renderer input.
 * A mixed-plan candidate emits MULTIPLE `Lares-Plan` trailers (never one silently
 * chosen plan; contract §3). These are server-authoritative: the renderer renders
 * them verbatim and any user trailer lives in a separate namespace that can never
 * override a `Lares-*` line.
 */
function deriveLaresTrailers(
  request: SaveCardPreviewRequest,
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
): string[] {
  const selectedComponentIds = new Set(request.selectedComponentIds);
  const selectedComponents = context.components.filter((component) =>
    selectedComponentIds.has(component.componentId),
  );
  const trailers: string[] = [];

  const turnIds = new Set(
    selectedComponents.flatMap((component) =>
      component.associations.flatMap((association) => association.contributingTurnIds),
    ),
  );
  if (turnIds.size > 0) trailers.push(`Lares-Turns: ${turnIds.size}`);

  const planIds = [...new Set(
    selectedComponents.flatMap((component) =>
      component.associations
        .map((association) => association.planId)
        .filter((planId): planId is string => planId !== null),
    ),
  )].sort();
  for (const planId of planIds) trailers.push(`Lares-Plan: ${planId}`);

  if (isCommitCandidate(candidate)) {
    for (const ref of candidate.finalizations) {
      trailers.push(`Lares-Finalization: ${ref.packageId}@${ref.packageRevision}`);
    }
  }

  return trailers;
}

/** Whether the selected components fuse ≥2 owners/plans and so need an explicit
 *  overlap acknowledgement before a token can mint. */
function selectionRequiresOverlapAck(
  request: SaveCardPreviewRequest,
  context: CandidateBuildContext,
): boolean {
  const selectedComponentIds = new Set(request.selectedComponentIds);
  return context.components.some(
    (component) =>
      selectedComponentIds.has(component.componentId) && component.overlap.requiresOverlapAck,
  );
}

/** The server-computed union topology digest for the exact selected set. Stable
 *  across previews of the same selection (a hash of the selection, not the bytes),
 *  so the renderer can echo it back as the overlap acknowledgement. */
function selectionTopologyDigest(
  request: SaveCardPreviewRequest,
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
): string {
  const selectedUnattributed = new Set(candidate.selectedUnattributedEntryIds);
  return computeCandidateTopologyDigest(
    context,
    candidate.componentIds,
    context.inventory.entries.filter((entry) => selectedUnattributed.has(entry.entryId)),
  );
}

function toPreviewResponse(
  request: SaveCardPreviewRequest,
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
): SaveCardPreviewResponse {
  const memberCount = candidate.members.length;
  const defaultMessageBody = `Save ${memberCount} file${memberCount === 1 ? '' : 's'}`;
  const requestedIds = new Set(request.finalizationIds);
  const driftResult = request.finalizationIds.length > 0
    ? resolvePinnedSelectionDrift({
        repositoryKey: context.repository.repositoryKey,
        inventory: context.inventory,
        components: context.components,
        finalizations: context.finalizations.filter((row) => requestedIds.has(row.id)),
        requestedComponentIds: request.selectedComponentIds,
        requestedUnattributedEntryIds: request.selectedUnattributedEntryIds,
      })
    : null;
  const pinnedSelection = driftResult?.pinnedSelection ?? {
    selectedComponentIds: [...candidate.componentIds],
    selectedUnattributedEntryIds: [...candidate.selectedUnattributedEntryIds],
    frozenMemberCount: candidate.members.length,
  };
  const blockingDriftPaths = driftResult
    ? [...new Set([
        ...driftResult.drift.missing,
        ...driftResult.drift.byteMoved,
        ...driftResult.drift.reAttributed,
      ])]
    : [];
  const refusal = candidateRefusal(candidate, isCommitCandidate(candidate), request, blockingDriftPaths);
  return {
    candidate,
    isCandidate: isCommitCandidate(candidate),
    laresTrailers: deriveLaresTrailers(request, candidate, context),
    defaultMessageBody,
    requiresOverlapAck: selectionRequiresOverlapAck(request, context),
    // Every selected unattributed atom needs an explicit acknowledgement (D-5).
    unacknowledgedUnattributedEntryIds: [...pinnedSelection.selectedUnattributedEntryIds],
    componentTopologyDigest: selectionTopologyDigest(request, candidate, context),
    selectionDrift: driftResult?.drift ?? { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: driftResult?.displayPaths ?? {},
    pinnedSelection,
    refusal,
  };
}

function candidateRefusal(
  candidate: CommitCandidate | SelectionPreview,
  candidateBacked: boolean,
  request: SaveCardPreviewRequest | SaveCardMintRequest,
  paths: string[],
): SaveRefusal | null {
  const mint = 'acknowledgeTopologyDigest' in request;
  const stage: SaveRefusalStage = mint ? 'mint' : 'preview-verify';
  if (!candidateBacked) {
    return {
      stage,
      code: mint ? 'mint-refused' : 'preview-ineligible',
      message: `${mint ? 'Mint' : 'Preview verification'} stage refused because the selection has no ready finalization.`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }
  if (!candidate.eligibility.eligible) {
    const acknowledgement = candidate.eligibility.reason === 'overlap-not-acknowledged'
      || candidate.eligibility.reason === 'unattributed-not-acknowledged';
    return {
      stage,
      code: mint && acknowledgement ? 'acknowledgement-stale' : mint ? 'mint-refused' : 'preview-ineligible',
      message: `${mint ? 'Mint' : 'Preview verification'} stage refused: ${candidate.eligibility.reason}.`,
      ...(paths.length > 0 ? { paths } : {}),
    };
  }
  if (mint && isCommitCandidate(candidate) && !candidate.token) {
    return {
      stage: 'mint',
      code: 'mint-token-missing',
      message: 'Mint stage refused because an eligible candidate did not receive a token.',
    };
  }
  return null;
}

/**
 * Register the read-only Save-lens preview channel. The handler resolves the
 * selection into a WP-3G `CandidateBuildContext` via the injected route, calls the
 * pure `buildCandidate` assembler (identical identity + verdicts across both
 * lenses), and returns the renderer-safe verdicts plus server-derived read-only
 * `Lares-*` trailer previews. Nothing here mutates the worktree/index/refs.
 *
 * `getRoutes` is evaluated per invocation so registration can happen before the
 * asynchronous production engine injects its route object.
 */
export function registerSaveCardPreviewIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardPreviewRoutes | null,
): void {
  ipc.handle(SAVECARD_PREVIEW_CHANNEL, async (_event, raw: unknown) => {
    const routes = requirePreviewRoutes(getRoutes());
    const request = requirePreviewRequest(raw);
    const context = await routes.resolvePreviewContext(request);
    const selection: CandidateSelectionRequest = {
      selectedComponentIds: request.selectedComponentIds,
      selectedUnattributedEntryIds: request.selectedUnattributedEntryIds,
      finalizationIds: request.finalizationIds,
    };
    const candidate = buildCandidate(selection, context);
    return toPreviewResponse(request, candidate, context);
  });
}

export function registerSaveCardMintIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardMintRoutes | null,
): void {
  ipc.handle(COMMIT_CANDIDATE_MINT_CHANNEL, async (_event, raw: unknown) => {
    const request = requireMintRequest(raw);
    const routes = getRoutes();
    if (!routes) {
      throw new SaveCardIpcError(
        'Save-card mint engine unavailable (the engine has not finished bootstrapping)',
        'save-card-engine-unavailable',
      );
    }
    const { candidate, context } = await routes.mintCandidate(request);
    return toPreviewResponse(request, candidate, context) satisfies SaveCardMintResponse;
  });
}
