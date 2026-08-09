// SC-WP-1H — read-only Save-card IPC transport.
//
// The routes object owns the CommitCandidateService and all Git/database
// dependencies. This layer only validates the renderer request and transports
// the renderer-safe intent-unit DTO. The inventory channel is deliberately
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
  SAVECARD_ADOPT_BASELINE_CHANNEL,
  SAVECARD_PREVIEW_CHANNEL,
  COMMIT_CANDIDATE_MINT_CHANNEL,
  SAVECARD_ATTRIBUTION_RESOLUTION_CHANNEL,
  SAVECARD_FINALIZE_CHANNEL,
  SAVECARD_ATTENTION_CHANNEL,
  SAVECARD_ATTENTION_CHANGED_CHANNEL,
  type SaveCardInventoryRequest,
  type SaveCardInventoryResponse,
  type SaveCardAdoptBaselineRequest,
  type SaveCardAdoptBaselineResponse,
  type SaveCardPreviewRequest,
  type SaveCardPreviewResponse,
  type SaveCardMintRequest,
  type SaveCardMintResponse,
  type SaveCardMintRequestV2,
  type SaveCardAttributionResolutionRequest,
  type SaveCardAttributionResolutionResponse,
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
  finalizeSaveUnit,
  type FinalizeOutcome,
  type FinalizePackageDeps,
  type FinalizePackageRequest,
  type FinalizeSaveUnitDeps,
} from './finalization-service';
import {
  buildCandidate,
  buildCandidateV2,
  buildReviewedSemanticManifest,
  computeCandidateTopologyDigest,
  rememberReviewedSemanticManifest,
  reviewCarryVerdictFor,
  type CandidateBuildContext,
  type CandidateSelectionRequest,
} from './candidate-service';
import { resolvePinnedSelectionDrift } from './pinned-selection-drift';
import type {
  CommitCandidate,
  ReviewChallengeAtom,
  SaveRefusal,
  SaveRefusalStage,
  SelectionPreview,
} from '../../shared/commit-candidates';

function requireChallengeAtoms(value: unknown): ReviewChallengeAtom[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SaveCardIpcError('acknowledgedChallengeAtoms must be an array', 'save-card-bad-request');
  }
  for (const atom of value) {
    if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
      throw new SaveCardIpcError('acknowledgedChallengeAtoms contains an invalid atom', 'save-card-bad-request');
    }
    const record = atom as Record<string, unknown>;
    if ((record.kind !== 'unattributed' && record.kind !== 'cross-intent'
          && !Array.isArray(record.memberPathBytesBase64))
        || typeof record.atomId !== 'string'
        || typeof record.digest !== 'string') {
      throw new SaveCardIpcError('acknowledgedChallengeAtoms contains an invalid atom', 'save-card-bad-request');
    }
  }
  return value as ReviewChallengeAtom[];
}

function requireOptionalDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SaveCardIpcError('reviewedManifestDigest must be a SHA-256 digest', 'save-card-bad-request');
  }
  return value;
}

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
  adoptAllAsBaseline?(
    req: SaveCardAdoptBaselineRequest,
  ): Promise<SaveCardAdoptBaselineResponse>;
}

/** Minimal `ipcMain.handle` shape for testing without a live Electron main. */
export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export type SaveFunnelTelemetry = (event: { stage: SaveRefusalStage; code: string }) => void;

const logSaveFunnelStage: SaveFunnelTelemetry = ({ stage, code }) => {
  // This record is intentionally data-free. Never add request fields, paths,
  // messages, candidate/token ids, exception text, or repository locations.
  console.info('[save-funnel]', { stage, code });
};

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

/** Explicit intent-packaging mutation, registered separately from the audited
 * read-only inventory transport. */
export function registerSaveCardIntentIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardRoutes | null,
): void {
  ipc.handle(SAVECARD_ADOPT_BASELINE_CHANNEL, async (_event, raw: unknown) => {
    const routes = requireRoutes(getRoutes());
    if (!routes.adoptAllAsBaseline) {
      throw new SaveCardIpcError('intent packaging is unavailable', 'save-card-engine-unavailable');
    }
    return routes.adoptAllAsBaseline(requireRequest(raw));
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
  finalizeIntentDeps?: FinalizeSaveUnitDeps;
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
): Exclude<SaveCardFleetAdhocMarkDoneResponse, { ok: false }> {
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
  telemetry: SaveFunnelTelemetry = logSaveFunnelStage,
): void {
  ipc.handle(SAVECARD_FINALIZE_CHANNEL, async (_event, raw: unknown) => {
    const routes = requireFinalizeRoutes(getRoutes());
    const request = requireMarkDoneRequest(raw);
    let context: FleetAdhocBoundaryContext;
    try {
      context = await routes.resolveBoundary(request);
    } catch (error) {
      if (error instanceof SaveCardFinalizeRefusalError) {
        const response = {
          ok: false,
          code: error.code,
          message: error.message,
          stage: error.stage,
          ...(error.paths ? { paths: error.paths } : {}),
          workspaceId: error.workspaceId,
          workspaceTitle: error.workspaceTitle,
        } satisfies SaveCardFleetAdhocMarkDoneResponse;
        telemetry({ stage: error.stage, code: error.code });
        return response;
      }
      throw error;
    }
    const result = await finalizeSaveUnit({
      ...context,
      saveUnitId: context.packageId,
      saveUnitKind: 'named-save-set',
    }, routes.finalizeIntentDeps);
    const outcome: FinalizeOutcome = result.outcome;
    const response: Exclude<SaveCardFleetAdhocMarkDoneResponse, { ok: false }> = {
      finalizationId: result.finalization.id,
      packageId: result.finalization.saveUnitId,
      finalizationKind: 'fleet-adhoc',
      outcome,
      boundaryRef: result.finalization.boundaryRef,
      boundaryStatus: result.finalization.boundaryStatus,
      packageRevision: result.finalization.revision,
      pinnedSelection: context.pinnedSelection,
    };
    if (outcome !== 'boundary-unavailable') {
      telemetry({ stage: 'freeze', code: 'freeze-ready' });
      return response;
    }
    const refused = {
      ...response,
      refusal: {
        stage: 'freeze',
        code: 'freeze-boundary-unavailable',
        message: 'Freeze stage refused because the captured boundary could not be made durable.',
        paths: context.members.map((member) => member.path.pathBytesBase64),
      },
    } satisfies SaveCardFleetAdhocMarkDoneResponse;
    telemetry({ stage: 'freeze', code: 'freeze-boundary-unavailable' });
    return refused;
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
  mintCandidate(req: any): Promise<{
    candidate: CommitCandidate | SelectionPreview;
    context: CandidateBuildContext;
  }>;
  persistAttributionResolution?: SaveCardAttributionResolutionRoutes['persistAttributionResolution'];
}

export interface SaveCardAttributionResolutionRoutes {
  persistAttributionResolution(
    req: SaveCardAttributionResolutionRequest,
  ): Promise<SaveCardAttributionResolutionResponse>;
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
  const optionalStrings = (field: string): string[] => record[field] === undefined
    ? [] : asStringArray(record[field], field);
  return {
    workspaceId: record.workspaceId,
    selectedComponentIds: optionalStrings('selectedComponentIds'),
    selectedUnattributedEntryIds: optionalStrings('selectedUnattributedEntryIds'),
    selectedIntentIds: optionalStrings('selectedIntentIds'),
    selectedNamedSaveSetIds: optionalStrings('selectedNamedSaveSetIds'),
    resolutionIds: optionalStrings('resolutionIds'),
    finalizationIds: asStringArray(record.finalizationIds, 'finalizationIds'),
    ...(record.reviewedManifestDigest !== undefined
      ? { reviewedManifestDigest: requireOptionalDigest(record.reviewedManifestDigest) }
      : {}),
    ...(record.acknowledgedChallengeAtoms !== undefined
      ? { acknowledgedChallengeAtoms: requireChallengeAtoms(record.acknowledgedChallengeAtoms) }
      : {}),
  };
}

const MINT_REQUEST_FIELDS = new Set([
  'workspaceId',
  'selectedIntentIds',
  'selectedNamedSaveSetIds',
  'resolutionIds',
  'finalizationIds',
  'reviewedManifestDigest',
  'acknowledgedChallengeAtoms',
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
  return {
    workspaceId: record.workspaceId,
    selectedIntentIds: strings('selectedIntentIds'),
    selectedNamedSaveSetIds: strings('selectedNamedSaveSetIds'),
    resolutionIds: strings('resolutionIds'),
    finalizationIds: strings('finalizationIds'),
    ...(record.reviewedManifestDigest !== undefined
      ? { reviewedManifestDigest: requireOptionalDigest(record.reviewedManifestDigest) }
      : {}),
    ...(record.acknowledgedChallengeAtoms !== undefined
      ? { acknowledgedChallengeAtoms: requireChallengeAtoms(record.acknowledgedChallengeAtoms) }
      : {}),
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

const DEFAULT_MESSAGE_MAX_LENGTH = 72;

function sanitizeMessageMetadata(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u2026/g, '...')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...values]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .filter((value, index, sorted) => index === 0 || value !== sorted[index - 1]);
}

function boundMessageLength(message: string): string {
  const characters = Array.from(message);
  if (characters.length <= DEFAULT_MESSAGE_MAX_LENGTH) return message;
  return `${characters.slice(0, DEFAULT_MESSAGE_MAX_LENGTH - 3).join('').trimEnd()}...`;
}

function isOpaquePackageId(packageId: string): boolean {
  return packageId.startsWith('component:')
    || packageId.startsWith('unattributed:')
    || /[0-9a-f]{40,64}/i.test(packageId);
}

function commonDisplayDirectory(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const directories = paths.map((path) => {
    const normalized = path.replace(/\\/g, '/');
    const separator = normalized.lastIndexOf('/');
    return separator < 0 ? [] : normalized.slice(0, separator).split('/').filter(Boolean);
  });
  const common = [...directories[0]];
  for (const directory of directories.slice(1)) {
    while (common.length > 0
      && common.some((segment, index) => directory[index] !== segment)) {
      common.pop();
    }
  }
  return common.length > 0 ? common.join('/') : null;
}

function fileSummary(candidate: CommitCandidate | SelectionPreview): string {
  const memberCount = candidate.members.length;
  const commonDirectory = commonDisplayDirectory(candidate.members.map((member) => member.path.displayPath));
  const directory = commonDirectory ? sanitizeMessageMetadata(commonDirectory) : null;
  return `Save: ${memberCount} file${memberCount === 1 ? '' : 's'}${directory ? ` in ${directory}` : ''}`;
}

/** Derive a stable commit subject from the immutable package/turn snapshot.
 * Metadata is display-only: it is sanitized, sorted, deduplicated, and bounded;
 * repository content is never read. */
export function deriveDefaultMessageBody(
  request: SaveCardPreviewRequest,
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
): string {
  if (isCommitCandidate(candidate) && candidate.contractVersion === 2) {
    const selected = (context.intentUnits ?? []).filter((unit) =>
      candidate.saveIntentIds?.includes(unit.intentId));
    if (selected.length > 0) {
      const unitTitles = uniqueSorted(selected.map((unit) => sanitizeMessageMetadata(unit.title)).filter(Boolean));
      const planTitles = uniqueSorted(selected.flatMap((unit) => unit.planTitle ? [sanitizeMessageMetadata(unit.planTitle)] : []));
      const itemTitles = uniqueSorted(selected.flatMap((unit) => unit.planItemTitle ? [sanitizeMessageMetadata(unit.planItemTitle)] : []));
      const taskTitles = uniqueSorted(selected.filter((unit) => unit.kind === 'task')
        .map((unit) => sanitizeMessageMetadata(unit.title)).filter(Boolean));
      const saveSetTitles = uniqueSorted(selected.filter((unit) => unit.kind === 'named-save-set')
        .map((unit) => sanitizeMessageMetadata(unit.title)).filter(Boolean));
      const subject = unitTitles.length === 1 ? unitTitles[0] : `Save ${selected.length} tasks`;
      const details = [
        ...planTitles.map((title) => `Plan: ${title}`),
        ...itemTitles.map((title) => `Plan item: ${title}`),
        ...taskTitles.map((title) => `Task: ${title}`),
        ...saveSetTitles.map((title) => `Save set: ${title}`),
      ];
      return [boundMessageLength(subject), ...(details.length > 0 ? ['', ...details] : [])].join('\n');
    }
  }
  const selectedComponentIds = new Set(request.selectedComponentIds);
  const requestedFinalizationIds = new Set(request.finalizationIds);
  const selectedComponents = context.components.filter((component) =>
    selectedComponentIds.has(component.componentId),
  );
  const requestedFinalizations = context.finalizations.filter((finalization) =>
    requestedFinalizationIds.has(finalization.id),
  );

  const taskIds = uniqueSorted([
    ...selectedComponents.flatMap((component) =>
      component.associations.flatMap((association) => association.planItemId ? [association.planItemId] : []),
    ),
    ...requestedFinalizations.flatMap((finalization) =>
      finalization.planItemId ? [finalization.planItemId] : [],
    ),
  ].map(sanitizeMessageMetadata).filter(Boolean));
  const packageIds = uniqueSorted([
    ...requestedFinalizations.map((finalization) => finalization.packageId),
    ...(isCommitCandidate(candidate) ? candidate.finalizations.map((ref) => ref.packageId) : []),
  ].map(sanitizeMessageMetadata).filter((packageId) => packageId && !isOpaquePackageId(packageId)));
  const planIds = uniqueSorted(selectedComponents.flatMap((component) =>
    component.associations.flatMap((association) => association.planId ? [association.planId] : []),
  ).map(sanitizeMessageMetadata).filter(Boolean));
  const turnIds = uniqueSorted([
    ...selectedComponents.flatMap((component) =>
      component.associations.flatMap((association) => association.contributingTurnIds),
    ),
    ...requestedFinalizations.flatMap((finalization) =>
      finalization.checkpointTurnId ? [finalization.checkpointTurnId] : [],
    ),
  ]);

  let message: string;
  if (taskIds.length === 1) {
    message = `Save ${taskIds[0]}`;
  } else if (taskIds.length > 1) {
    message = `Save tasks ${taskIds.join(', ')}`;
  } else if (packageIds.length === 1) {
    message = `Save ${packageIds[0]}`;
  } else if (packageIds.length > 1) {
    message = `Save packages ${packageIds.join(', ')}`;
  } else if (planIds.length === 1) {
    message = `Save ${planIds[0]}`;
  } else if (planIds.length > 1) {
    message = `Save plans ${planIds.join(', ')}`;
  } else if (turnIds.length > 0) {
    message = `Save work from ${turnIds.length} turn${turnIds.length === 1 ? '' : 's'}`;
  } else {
    message = fileSummary(candidate);
  }
  if (packageIds.length > 0 && turnIds.length > 0) {
    message += ` (${turnIds.length} turn${turnIds.length === 1 ? '' : 's'})`;
  }
  return boundMessageLength(message);
}

function reviewPayload(
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
): Pick<SaveCardPreviewResponse, 'reviewedManifest' | 'durableFinalizationIntent' | 'reviewCarry'> {
  const carry = reviewCarryVerdictFor(candidate);
  const carryPayload = carry
    ? {
        reviewCarry: carry.carried
          ? {
              carried: true,
              reviewedManifestDigest: carry.reviewedManifestDigest,
              pendingPathBytesBase64: carry.pendingPathBytesBase64,
              dischargedPathBytesBase64: carry.dischargedPathBytesBase64,
            }
          : {
              carried: false,
              reviewedManifestDigest: carry.reviewedManifestDigest,
              reason: carry.reason,
              ...(carry.paths ? { paths: carry.paths } : {}),
            },
      }
    : {};
  if (!isCommitCandidate(candidate) || candidate.members.some((member) =>
    member.expectedCommitBlobOid === null && member.expectedWorktreeState === 'present')) {
    return carryPayload;
  }
  try {
    const manifest = buildReviewedSemanticManifest(candidate, context);
    const reviewedManifestDigest = rememberReviewedSemanticManifest(manifest);
    const paths = new Map<string, import('../../shared/commit-candidates').EncodedGitPath>();
    for (const entry of context.inventory.entries) {
      paths.set(entry.path.pathBytesBase64, entry.path);
      if (entry.originalPath) paths.set(entry.originalPath.pathBytesBase64, entry.originalPath);
      for (const path of entry.commitPathspecs) paths.set(path.pathBytesBase64, path);
    }
    const pathFor = (pathBytesBase64: string) => paths.get(pathBytesBase64) ?? {
      pathBytesBase64,
      displayPath: '[git path]',
      utf8Clean: false,
    };
    return {
      reviewedManifest: {
        manifestVersion: manifest.manifestVersion,
        reviewedManifestDigest,
        members: manifest.members.map((member) => ({
          finalPath: pathFor(member.finalPathBytesBase64),
          expectedState: member.expectedState,
          rawBlobOid: member.rawBlobOid,
          commitBlobOid: member.commitBlobOid,
          commitMode: member.commitMode,
          commitEffects: member.commitEffects.map((effect) => ({
            path: pathFor(effect.pathBytesBase64),
            operation: effect.operation,
            expectedState: effect.expectedState,
            rawBlobOid: effect.rawBlobOid,
            commitBlobOid: effect.commitBlobOid,
            commitMode: effect.commitMode,
          })),
        })),
        challengeVersion: manifest.challengeVersion,
        challengeAtoms: manifest.challengeAtoms,
      },
      durableFinalizationIntent: manifest.finalizations.map((intent) => ({
        finalizationId: intent.finalizationId,
        packageId: intent.packageId,
        packageRevision: intent.packageRevision,
        boundaryStatus: intent.boundaryStatus,
        frozenMemberManifestDigest: intent.frozenMemberManifestDigest,
      })),
      ...carryPayload,
    };
  } catch {
    // An ineligible/legacy fixture may not carry structured WP-2 topology. Never
    // manufacture a review identity from an opaque digest; simply omit it.
    return carryPayload;
  }
}

function toPreviewResponse(
  request: SaveCardPreviewRequest,
  candidate: CommitCandidate | SelectionPreview,
  context: CandidateBuildContext,
  mint = false,
): SaveCardPreviewResponse {
  const defaultMessageBody = deriveDefaultMessageBody(request, candidate, context);
  const requestedIds = new Set(request.finalizationIds);
  const driftResult = request.finalizationIds.length > 0
    ? resolvePinnedSelectionDrift({
        repositoryKey: context.repository.repositoryKey,
        inventory: context.inventory,
        components: context.components,
        finalizations: context.finalizations.filter((row) => requestedIds.has(row.id)),
        requestedComponentIds: request.selectedComponentIds ?? [],
        requestedUnattributedEntryIds: request.selectedUnattributedEntryIds ?? [],
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
  const refusal = candidateRefusal(candidate, isCommitCandidate(candidate), mint, blockingDriftPaths);
  return {
    candidate,
    isCandidate: isCommitCandidate(candidate),
    laresTrailers: deriveLaresTrailers(request, candidate, context),
    defaultMessageBody,
    // Every selected unattributed atom needs an explicit acknowledgement (D-5).
    unacknowledgedUnattributedEntryIds: [...pinnedSelection.selectedUnattributedEntryIds],
    componentTopologyDigest: selectionTopologyDigest(request, candidate, context),
    selectionDrift: driftResult?.drift ?? { added: [], missing: [], reAttributed: [], byteMoved: [] },
    selectionDriftDisplayPaths: driftResult?.displayPaths ?? {},
    pinnedSelection,
    refusal,
    ...reviewPayload(candidate, context),
  };
}

function candidateRefusal(
  candidate: CommitCandidate | SelectionPreview,
  candidateBacked: boolean,
  mint: boolean,
  paths: string[],
): SaveRefusal | null {
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
    const acknowledgement = candidate.eligibility.reason === 'unattributed-not-acknowledged';
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
  telemetry: SaveFunnelTelemetry = logSaveFunnelStage,
): void {
  ipc.handle(SAVECARD_PREVIEW_CHANNEL, async (_event, raw: unknown) => {
    const routes = requirePreviewRoutes(getRoutes());
    const request = requirePreviewRequest(raw);
    const context = await routes.resolvePreviewContext(request);
    const intentSelection = (request.selectedIntentIds?.length ?? 0) > 0
      || (request.selectedNamedSaveSetIds?.length ?? 0) > 0;
    const candidate = intentSelection ? buildCandidateV2({
      selectedIntentIds: request.selectedIntentIds ?? [],
      selectedNamedSaveSetIds: request.selectedNamedSaveSetIds ?? [],
      resolutionIds: request.resolutionIds ?? [],
      finalizationIds: request.finalizationIds,
      acknowledgeUnattributedEntryIds: [],
    }, context) : buildCandidate({
      selectedComponentIds: request.selectedComponentIds ?? [],
      selectedUnattributedEntryIds: request.selectedUnattributedEntryIds ?? [],
      finalizationIds: request.finalizationIds,
    }, context);
    const compatibilityRequest: SaveCardPreviewRequest = {
      ...request,
      selectedComponentIds: candidate.componentIds,
      selectedUnattributedEntryIds: candidate.selectedUnattributedEntryIds,
    };
    const response = toPreviewResponse(compatibilityRequest, candidate, context);
    telemetry(response.refusal
      ? { stage: response.refusal.stage, code: response.refusal.code }
      : { stage: 'preview-verify', code: 'preview-eligible' });
    return response;
  });
}

export function registerSaveCardMintIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardMintRoutes | null,
  telemetry: SaveFunnelTelemetry = logSaveFunnelStage,
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
    const responseRequest: SaveCardPreviewRequest = 'selectedIntentIds' in request ? {
      workspaceId: request.workspaceId,
      selectedComponentIds: candidate.componentIds,
      selectedUnattributedEntryIds: candidate.selectedUnattributedEntryIds,
      finalizationIds: request.finalizationIds,
      reviewedManifestDigest: request.reviewedManifestDigest,
      acknowledgedChallengeAtoms: request.acknowledgedChallengeAtoms,
    } : request;
    const response = toPreviewResponse(responseRequest, candidate, context, true) satisfies SaveCardMintResponse;
    telemetry(response.refusal
      ? { stage: response.refusal.stage, code: response.refusal.code }
      : { stage: 'mint', code: 'mint-token-issued' });
    return response;
  });
}

/** Production picker persistence seam. The route re-resolves repository and
 * evidence; this transport accepts no renderer-authored repository identity. */
export function registerSaveCardAttributionResolutionIpc(
  ipc: IpcLike,
  getRoutes: () => SaveCardAttributionResolutionRoutes | null,
): void {
  ipc.handle(SAVECARD_ATTRIBUTION_RESOLUTION_CHANNEL, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SaveCardIpcError('an attribution resolution request is required', 'save-card-bad-request');
    }
    const request = raw as SaveCardAttributionResolutionRequest;
    if (!request.workspaceId || !request.atom || request.atom.kind !== 'cross-intent') {
      throw new SaveCardIpcError('cross-intent evidence is required', 'save-card-bad-request');
    }
    if (!['commit-together', 'superseded-intentionally', 'restore-lost-work'].includes(request.resolution)) {
      throw new SaveCardIpcError('invalid attribution resolution', 'save-card-bad-request');
    }
    const routes = getRoutes();
    if (!routes) throw new SaveCardIpcError('save-card engine unavailable', 'save-card-engine-unavailable');
    return routes.persistAttributionResolution(request);
  });
}
